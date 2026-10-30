#!/usr/bin/env node
/**
 * savak — CLI for the smart evasion ladder.
 *
 *   savak plan        [--profile p.json] [--node fra-1] [--mode speed]
 *                     [--access cellular] [--censor sni-only] [--rtt 70] [--loss 3] [--bw 40]
 *                     [--out config.json] [--json] [--validate]
 *   savak race        --host 1.2.3.4 [--probe-port 20125]  (needs server/bootstrap.sh responder)
 *   savak nodes       [--profile p.json] ...                (cross-node race)
 *   savak server      [--profile p.json] [--node fra-1] [--out server.json]
 *   savak validate    <file.json>
 *   savak profile     [--out profile.json] [--sign]       (Ed25519 keypair + signed example)
 *   savak bundle      [--out savak-bundle.json] [--live host] [--only a,b]
 *   savak init        --hostname host --node id [--brutal] [--outDir dir]  (profile+keys+server.json)
 *   savak keys        [--json]                              (fresh credentials for a node)
 *   savak serve       [--port 8080]                        (dashboard)
 */

import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { planForNode, planAcrossNodes, AdaptiveSelector, POLICIES } from './index.js';
import { synthesizeLink, measureLink, CENSOR_PROFILES } from './probes.js';
import { exampleProfile, signProfile, verifyProfile, generateSigningKey, saveProfile, loadProfile } from './profile.js';
import { serverConfig } from './singbox.js';
import { validateConfig } from './validate.js';
import { RUNGS } from './ladder.js';
import { generateCredentials } from './keys.js';
import { buildBundle } from './bundle.js';
import { tuneFor } from './tune.js';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[camel(key)] = true;
      else {
        out[camel(key)] = next;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

async function readProfile(args) {
  if (args.profile) return loadProfile(args.profile);
  const env = process.env.SAVAK_PROFILE_FILE;
  if (env) return loadProfile(env);
  return exampleProfile();
}

function linkFrom(args) {
  const spec = {
    access: args.access ?? 'wifi',
    censor: args.censor ?? 'none',
  };
  if (args.rtt) spec.rttMs = Number(args.rtt);
  if (args.loss) spec.lossPct = Number(args.loss);
  if (args.bw) spec.downMbps = Number(args.bw);
  if (args.up) spec.upMbps = Number(args.up);
  return synthesizeLink(spec);
}

function policyFrom(args) {
  const p = {};
  if (args.mode) p.mode = args.mode;
  for (const k of ['allowLegacy', 'bondInterfaces', 'portHopping', 'fakeIp', 'controlApi', 'stack']) {
    if (args[k] !== undefined) p[k] = args[k] === 'true' || args[k] === true ? true : args[k] === 'false' ? false : args[k];
  }
  return p;
}

const pad = (s, n) => String(s).padEnd(n);
const pct = (v) => `${(v * 100).toFixed(0)}%`;

function printPlan(plan, { showAll = false } = {}) {
  const rows = [];
  rows.push(`node      ${plan.node.label} (${plan.node.id}) → ${plan.node.address}`);
  rows.push(`link      ${plan.link.source} ${plan.link.access} rtt=${plan.link.rttMs ?? '?'}ms loss=${plan.link.lossPct ?? '?'}% down=${plan.link.downMbps ?? '?'}Mbps`);
  const censor = Object.entries(plan.link).filter(([, v]) => v === true).map(([k]) => k);
  if (censor.length) rows.push(`signals   ${censor.join(' ')}`);
  rows.push(`mode      ${plan.mode} (${POLICIES[plan.mode]?.label ?? ''})`);
  rows.push('');
  rows.push('  ladder (ranked)'.padEnd(58) + 'score   thr   lat   stab  evade cost');
  for (const r of plan.ranking) {
    const l = plan.ladder.find((x) => x.rungId === r.rungId);
    if (!r.feasible && !showAll) {
      rows.push(`  - ${pad(r.rungId, 22)}excluded: ${r.reason}`);
      continue;
    }
    const p = l?.parts ?? {};
    rows.push(
      `  ${r.feasible ? '✓' : '✗'} ${pad(r.rungId, 22)}${pad((r.score ?? 0).toFixed(3), 8)}` +
        `${pad(pct(p.throughput ?? 0), 6)}${pad(pct(p.latency ?? 0), 6)}${pad(pct(p.stability ?? 0), 6)}${pad(pct(p.evasion ?? 0), 6)}${pct(p.cost ?? 0)}`,
    );
  }
  rows.push('');
  rows.push(`CHOSEN    ${plan.chosen}  —  ${plan.decision.why}`);
  const chosen = plan.ladder.find((l) => l.rungId === plan.chosen);
  if (chosen) {
    rows.push('');
    rows.push('  applied tuning:');
    for (const n of chosen.notes) rows.push(`   • ${pad(n.key, 26)}${n.why}`);
    rows.push('');
    rows.push('  evasion on the wire:');
    for (const f of chosen.flags) rows.push(`   • ${pad(f.flag, 26)}${f.note}`);
  }
  if (plan.warnings.length) {
    rows.push('');
    rows.push('  warnings:');
    for (const w of plan.warnings) rows.push(`   ! ${w}`);
  }
  return rows.join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    process.stdout.write(
      `savak — smart evasion ladder (sing-box 1.14)\n\n` +
        `  savak plan     [--profile f.json] [--node fra-1] [--mode auto|speed|stealth|game|resist]\n` +
        `                 [--access wifi|cellular] [--censor ${Object.keys(CENSOR_PROFILES).join('|')}]\n` +
        `                 [--rtt ms] [--loss %] [--bw mbps] [--root] [--all] [--links]\n` +
        `                 [--out client.json] [--validate]\n` +
        `  savak nodes    race every node in the profile and rank them\n` +
        `  savak bundle   --out savak-bundle.json  the signed per-rung config bundle for the app\n` +
        `  savak race     --host <addr> [--probe-port 20125] real measurements, not a model\n` +
        `  savak server   --out server.json  the node's own listeners (all rungs at once)\n` +
        `  savak keys     fresh credentials for a node (uuid, hy2, tuic, anytls, ss2022, reality, wg)\n` +
        `  savak validate <file.json>  check any config against the official schema\n` +
        `  savak ladder   print the catalogue and where each rung came from\n` +
        `  savak serve    [--port 8080] the dashboard\n\n`,
    );
    return;
  }
  const args = parseArgs(argv);
  const cmd = args._[0] ?? 'plan';

  switch (cmd) {
    case 'plan': {
      const profile = await readProfile(args);
      const selector = args.stateful ? new AdaptiveSelector(policyFrom(args)) : undefined;
      const plan = planForNode({
        profile,
        nodeId: args.node,
        policy: policyFrom(args),
        link: linkFrom(args),
        client: args.root ? { platform: 'linux', capabilities: { packetInjection: true, kernelTls: true, graphicalClient: false, cdnFronting: false, mptcp: true } } : {},
        selector,
      });
      if (args.json) process.stdout.write(`${JSON.stringify({ ...plan, config: undefined }, null, 2)}\n`);
      else process.stdout.write(`${printPlan(plan, { showAll: !!args.all })}\n`);
      if (args.out) {
        await writeFile(args.out, `${JSON.stringify(plan.config, null, 2)}\n`);
        process.stderr.write(`wrote ${args.out}\n`);
      }
      if (args.validate) {
        const res = await validateConfig(plan.config);
        process.stdout.write(`\nvalidate(${res.engine}): ${res.ok ? 'OK' : 'FAILED'}\n${res.errors.map((e) => `  ${e}`).join('\n')}${res.skipped ? `\n  note: ${res.skipped}` : ''}\n`);
        if (!res.ok) process.exitCode = 4;
      }
      if (args.links) process.stdout.write(`\nshare links (import into other clients):\n${Object.entries(plan.shareLinks).map(([k, v]) => `  ${pad(k, 22)}${v}`).join('\n')}\n`);
      break;
    }
    case 'nodes': {
      const profile = await readProfile(args);
      const res = planAcrossNodes({ profile, policy: policyFrom(args), link: linkFrom(args) });
      process.stdout.write(
        ['  node                    rung                    score   est.Mbps  rtt', ...res.nodes.map((n) => `  ${pad(n.label, 22)}${pad(n.rung, 22)}${pad(n.score, 8)}${pad(n.throughputMbps, 10)}${n.rttMs}`)].join('\n') + '\n',
      );
      if (res.best) process.stdout.write(`\nbest node: ${res.best.label} over ${res.best.rung}\n`);
      break;
    }
    case 'race': {
      if (!args.host) throw new Error('race needs --host <addr> (and server/bootstrap.sh must have installed the probe responder)');
      const link = await measureLink({
        host: args.host,
        ports: (args.ports ?? '443,8443').split(',').map(Number),
        probePort: Number(args.probePort ?? 20125),
        throughputPort: Number(args.throughputPort ?? 20126),
        realSni: args.sni,
        whitelistedSni: args.whitelistSni ?? 'www.google.com',
        access: args.access ?? 'wifi',
        withSniProbe: !args.noSniProbe,
      });
      const profile = await readProfile(args);
      const plan = planForNode({ profile, policy: policyFrom(args), link, nodeId: args.node });
      process.stdout.write(`measured: ${JSON.stringify({ rttMs: link.rttMs, lossPct: link.lossPct, downMbps: link.downMbps, sniFiltered: link.sniFiltered, confidence: link.confidence, udpBlocked: link.udpBlocked })}\n\n${printPlan(plan, { showAll: true })}\n`);
      if (args.out) await writeFile(args.out, `${JSON.stringify(plan.config, null, 2)}\n`);
      break;
    }
    case 'server': {
      const profile = await readProfile(args);
      const node = profile.servers.find((s) => s.id === args.node) ?? profile.servers[0];
      const ladder = RUNGS.map((rung) => {
        const tuning = tuneFor({
          rung,
          link: linkFrom(args),
          client: { platform: 'linux', mtu: 1420, capabilities: { kernelTls: true, graphicalClient: false } },
          server: { ...node, capabilities: node.capabilities },
          creds: profile.credentials,
          policy: resolve(args.mode),
          notes: [],
        });
        return { id: rung.id, rung, tuning, feasible: (node.protocols ?? []).includes(rung.id), outbound: null };
      });
      const cfg = serverConfig({
        profile,
        node,
        server: { ...node, tag: 'savak', creds: profile.credentials, profile, paths: { cert: '/var/lib/savak/tls.crt', key: '/var/lib/savak/tls.key', state: '/var/lib/savak' } },
        creds: profile.credentials,
        policy: resolve(args.mode),
        ladder,
        options: { hostname: args.hostname, certificateProvider: !!args.acme, masqueradeUrl: args.masquerade, realityDest: node.realityDest, paths: { state: '/var/lib/savak' } },
      });
      const out = args.out ?? 'server.json';
      await writeFile(out, `${JSON.stringify(cfg, null, 2)}\n`);
      const res = await validateConfig(cfg);
      process.stdout.write(`wrote ${out}\nvalidate(${res.engine}): ${res.ok ? 'OK' : 'FAILED'}\n${res.errors.slice(0, 25).map((e) => `  ${e}`).join('\n')}\n`);
      if (!res.ok) process.exitCode = 4;
      break;
    }
    case 'validate': {
      const file = args._[1];
      if (!file) throw new Error('validate needs a file');
      const cfg = JSON.parse(await readFile(file, 'utf8'));
      const res = await validateConfig(cfg);
      process.stdout.write(`${res.ok ? 'OK' : 'FAILED'} (${res.engine})\n${res.errors.map((e) => `  ${e}`).join('\n')}\n`);
      if (!res.ok) process.exitCode = 4;
      break;
    }
    case 'profile': {
      const keys = generateSigningKey();
      let profile = exampleProfile({ keys: keys.keyId });
      if (args.sign !== 'no') profile = signProfile(profile, keys.privateKey, keys.keyId);
      await saveProfile(args.out ?? 'profile.json', profile);
      if (args.keypairOut) await saveProfile(args.keypairOut, keys);
      const v = verifyProfile(profile, { [keys.keyId]: keys.publicKey });
      process.stdout.write(
        `wrote ${args.out ?? 'profile.json'} (profileId=${profile.profileId}, signature=${profile.signature ? 'ed25519' : 'none'})\n` +
          `verify: ${v.ok ? 'OK' : `FAILED (${v.reason})`}\n` +
          (args.keypairOut
            ? `wrote ${args.keypairOut} — KEEP THE PRIVATE KEY OFFLINE; the client only needs:\n  "trustedKeys": { "${keys.keyId}": ${JSON.stringify(keys.publicKey)} }\n`
            : 'pass --keypair-out to persist the signing key\n'),
      );
      break;
    }
    case 'keys': {
      const creds = generateCredentials();
      if (args.json) {
        process.stdout.write(`${JSON.stringify(creds, null, 2)}\n`);
        break;
      }
      process.stdout.write(
        [
          `uuid                 ${creds.uuid}`,
          `hysteria2 password ${creds.hy2Password}`,
          `hysteria2 obfs     ${creds.hy2ObfsPassword}`,
          `tuic uuid          ${creds.tuicUuid}`,
          `tuic password      ${creds.tuicPassword}`,
          `anytls password    ${creds.anytlsPassword}`,
          `ss method          ${creds.ssMethod}`,
          `ss key             ${creds.ssPassword}`,
          `reality pbk        ${creds.realityPublicKey}`,
          `reality skp        ${creds.realityPrivateKey}`,
          `reality sid        ${creds.realityShortId}`,
          `reality dest       ${creds.realityDest.host}:${creds.realityDest.port}  (${creds.realityDest.why})`,
          `wg server pub      ${creds.wg.serverPublicKey}`,
          `wg server priv     ${creds.wg.serverPrivateKey}`,
          `wg client pub      ${creds.wg.clientPublicKey}`,
          `wg client priv     ${creds.wg.clientPrivateKey}`,
          `wg psk             ${creds.wg.psk}`,
        ].join('\n') + '\n',
      );
      break;
    }
    case 'bundle': {
      const profile = await readProfile(args);
      const bundle = await buildBundle({
        profile,
        policy: policyFrom(args),
        linkSpec: args.live ? undefined : linkFrom(args),
        link: args.live ? await measureLink({ host: args.live, ports: (args.ports ?? '443').split(',').map(Number), access: args.access ?? 'wifi' }) : undefined,
        only: args.only ? String(args.only).split(',') : [],
        validate: args.validate === false ? false : true,
        client: args.root ? { platform: 'linux', capabilities: { packetInjection: true, kernelTls: true, graphicalClient: false, mptcp: true } } : {},
      });
      const out = args.out ?? 'savak-bundle.json';
      await writeFile(out, `${JSON.stringify(bundle, null, 2)}\n`);
      process.stdout.write(
        `bundle → ${out}\n` +
          bundle.nodes.map((n) => `  ${pad(n.id, 12)} preferred=${n.preferredRung.padEnd(20)} rungs=${n.allowedRungs.length}`).join('\n') +
          `\nvalidate: ${bundle.ok ? 'OK — every embedded config parses under the sing-box 1.14.4 schema' : `FAILED\n  ${bundle.errors.join('\n  ')}`}\n`,
      );
      if (!bundle.ok) process.exitCode = 4;
      break;
    }
    case 'init': {
      const { initProfile, serverConfigFor } = await import('./init.js');
      const outDir = args.outDir ?? '.';
      const res = initProfile({
        nodeId: args.node ?? 'node-1',
        hostname: args.hostname ?? 'node.local',
        user: args.user ?? 'user',
        tcpBrutal: !!args.brutal,
        tlsMode: args.tlsMode,
        masquerade: args.masquerade ?? 'https://www.google.com',
        mode: args.mode ?? 'auto',
      });
      const cfg = serverConfigFor(res.profile, res.profile.servers[0].id, { apiSecret: args.apiSecret ?? res.credentials.hy2Password.slice(0, 16), acmeEmail: args.email });
      const v = await validateConfig(cfg);
      const { writeFile, mkdir } = await import('node:fs/promises');
      await mkdir(outDir, { recursive: true });
      await writeFile(`${outDir}/profile.json`, `${JSON.stringify(res.profile, null, 2)}\n`);
      await writeFile(`${outDir}/keys.json`, `${JSON.stringify({ profileSigning: res.signingKey, credentials: res.credentials }, null, 2)}\n`);
      await writeFile(`${outDir}/server.json`, `${JSON.stringify(cfg, null, 2)}\n`);
      process.stdout.write(
        `initialised node ${res.profile.servers[0].id} (${res.profile.servers[0].address})\n` +
          `  profile.json   profileId=${res.profile.profileId} signature=ed25519 keyId=${res.signingKey.keyId}\n` +
          `  server.json    ${cfg.inbounds.length} listeners + ${cfg.endpoints?.length ?? 0} endpoint — validate(${v.engine}): ${v.ok ? 'OK' : 'FAILED'}\n` +
          (v.ok ? '' : v.errors.slice(0, 6).map((e) => `    ${e}\n`).join('')) +
          `  keys.json      KEEP THIS FILE SECRET (profile signing key + all node credentials)\n\n` +
          `next: node src/cli.js bundle --profile ${outDir}/profile.json --node ${res.profile.servers[0].id} --out ${outDir}/bundle.json\n` +
          `      ship bundle.json to the phones; trust the key: "${res.signingKey.keyId}"\n`,
      );
      if (!v.ok) process.exitCode = 4;
      break;
    }
    case 'serve': {
      const { serve } = await import('./web.js');
      await serve({ port: Number(args.port ?? 8080) });
      break;
    }
    case 'ladder': {
      process.stdout.write(`${RUNGS.map((r) => `${pad(r.id, 22)}${pad(r.family, 10)}${r.title}\n${' '.repeat(34)}${r.lineage}`).join('\n')}\n`);
      break;
    }
    default:
      process.stdout.write(
        `savak — smart evasion ladder\n\ncommands: plan | nodes | race | server | validate | profile | ladder | serve\n\nmodes: ${Object.keys(POLICIES).join(', ')}\ncensor profiles: ${Object.keys(CENSOR_PROFILES).join(', ')}\n`,
      );
  }
}

const resolve = (mode) => ({ mode: mode ?? 'auto' });

main().catch((e) => {
  process.stderr.write(`savak: ${e.stack ?? e.message}\n`);
  process.exitCode = 1;
});
