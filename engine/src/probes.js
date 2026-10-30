/**
 * Link measurement + the synthetic link model.
 * ============================================
 *
 * The selector is only as good as its inputs, so this module has two halves:
 *
 *  • `synthesizeLink()` — deterministic, for tests / offline plan generation.
 *  • real socket probes  — TCP RTT, UDP RTT/loss/jitter, throughput sample,
 *    SNI-filter classification. They talk to the tiny responder in
 *    `probe-service.js` (installed by server/bootstrap.sh) plus `node:tls`,
 *    and every one of them degrades to `null`/`estimated` instead of throwing:
 *    a phone must still connect when a probe is blocked.
 *
 * Nothing here claims to *prove* what a censor is doing. Probes yield
 * observations; `classify*` turns them into labelled hypotheses with a
 * confidence, and the ladder treats low-confidence signals as "prefer the
 * rung that does not care".
 */

import net from 'node:net';
import dgram from 'node:dgram';
import tls from 'node:tls';

const now = () => Number(process.hrtime.bigint() / 1000000n);
const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);

/* ------------------------------------------------------------------ *
 * Synthetic model
 * ------------------------------------------------------------------ */

/** Censor profiles: which mechanisms are observed on this path. */
export const CENSOR_PROFILES = Object.freeze({
  none: {},
  'sni-only': { sniFiltered: true },
  // Two lookalikes with opposite answers, so they must not share a profile:
  // a protocol-wide UDP throttle is dodged by moving to TCP; per-port QoS is dodged
  // by hopping *within* UDP (which is far cheaper, so it is preferred when it works).
  'udp-throttle': { udpThrottled: true },
  'port-qos': { portThrottled: true },
  'quic-kill': { quicBlocked: true, udpBlocked: false },
  'udp-block': { udpBlocked: true, quicBlocked: true },
  'deep-packet': { sizeHeuristic: true, quicFingerprinted: true, clientHelloFingerprinted: true },
  'total-recall': { udpBlocked: true, quicBlocked: true, sniFiltered: true, portBlocked: true, activeProbeSuspected: true, ipRangeBlocked: true },
});

const NAMED_KEYS = new Set(['censor', 'access', 'rttMs', 'jitterMs', 'lossPct', 'downMbps', 'upMbps', 'flows', 'mtuCap']);

export function synthesizeLink(spec = {}) {
  // Anything that is not a named knob is treated as an observed censor signal,
  // so callers can say `{portThrottled: true}` without inventing a profile name.
  const extra = Object.fromEntries(Object.entries(spec).filter(([k, v]) => !NAMED_KEYS.has(k) && v !== undefined && v !== null));
  const censor = { ...(CENSOR_PROFILES[spec.censor ?? 'none'] ?? spec.censor ?? {}), ...extra };
  const access = spec.access ?? 'wifi';
  const base = {
    source: 'synthetic',
    access,
    rttMs: spec.rttMs ?? (access === 'cellular' ? 78 : 42),
    jitterMs: spec.jitterMs ?? (access === 'cellular' ? 14 : 3),
    lossPct: spec.lossPct ?? (access === 'cellular' ? 1.8 : 0.1),
    downMbps: spec.downMbps ?? (access === 'cellular' ? 32 : 180),
    upMbps: spec.upMbps ?? (access === 'cellular' ? 8 : 60),
    flows: spec.flows ?? 64,
    mtuCap: spec.mtuCap ?? (access === 'cellular' ? 1400 : 1500),
    measured: true,
    ...censor,
  };
  return {
    ...base,
    tcpOnly: base.udpBlocked,
    pmtuDrops: (base.mtuCap ?? 1500) <= 1400 || base.sizeHeuristic === true,
    ipv6Flaky: base.access === 'cellular',
    tlsEoT: true,
    quicBlocked: base.quicBlocked ?? base.udpBlocked,
    udpThrottled: base.udpThrottled ?? false,
  };
}

/* ------------------------------------------------------------------ *
 * Real probes
 * ------------------------------------------------------------------ */

function withTimeout(promise, ms, label) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, rej) => {
      t = setTimeout(() => rej(Object.assign(new Error(`${label}: timeout after ${ms}ms`), { code: 'ETIMEDOUT' })), ms);
    }),
  ]);
}

/** TCP connect time = the RTT every TLS rung pays before it can send a byte. */
export async function probeTcpRtt({ host, ports = [443], samples = 5, timeoutMs = 1500 } = {}) {
  const out = {};
  for (const port of ports) {
    const rtts = [];
    const errors = [];
    for (let i = 0; i < samples; i++) {
      const t0 = now();
      try {
        await withTimeout(
          new Promise((resolve, reject) => {
            const s = net.connect({ host, port });
            s.setTimeout(timeoutMs);
            s.once('connect', () => {
              s.destroy();
              resolve();
            });
            s.once('error', (e) => {
              s.destroy();
              reject(e);
            });
            s.once('timeout', () => {
              s.destroy();
              reject(new Error('ETIMEDOUT'));
            });
          }),
          timeoutMs + 50,
          `tcp ${host}:${port}`,
        );
        rtts.push(now() - t0);
      } catch (e) {
        errors.push(e.code ?? e.message);
      }
    }
    const sorted = [...rtts].sort((a, b) => a - b);
    out[port] = {
      ok: rtts.length > 0,
      rttMs: median(rtts),
      minRttMs: sorted[0] ?? null,
      jitterMs: sorted.length > 1 ? median(sorted.map((v) => Math.abs(v - (sorted[0] ?? 0)))) : 0,
      successRatio: rtts.length / samples,
      errors: [...new Set(errors)],
    };
  }
  return out;
}

/**
 * UDP round-trip against the savak probe responder: loss + jitter + RTT, which is
 * exactly what decides BRUTAL-vs-BBR and QUIC-vs-TCP.
 */
export async function probeUdp({ host, port = 20125, packets = 32, size = 1200, timeoutMs = 1200, pacingMs = 12, settleMs = 250 } = {}) {
  const socket = dgram.createSocket('udp4');
  const sentAt = new Map();
  const rttList = [];
  let stop = false;

  // One listener for the whole session, matched by sequence number. A per-packet
  // `once('message')` desynchronises the moment one probe packet is dropped, which
  // turns a loss measurement into an off-by-one cascade — i.e. a wrong
  // BRUTAL-vs-BBR decision on the phone.
  const onMessage = (msg) => {
    if (msg.length < 10 || msg.toString('ascii', 0, 6) !== 'SAVAKR') return;
    const seq = msg.readUInt32BE(6);
    const t0 = sentAt.get(seq);
    if (t0 === undefined || rttList.some((r) => r.seq === seq)) return;
    rttList.push({ seq, rttMs: now() - t0 });
  };
  socket.on('message', onMessage);
  socket.on('error', () => {});

  try {
    for (let i = 0; i < packets && !stop; i++) {
      const payload = Buffer.alloc(size, 0x41);
      payload.write('SAVAKQ', 0, 'ascii');
      payload.writeUInt32BE(i, 6);
      payload.writeUInt32BE(Date.now() % 0x100000000, 10);
      sentAt.set(i, now());
      await new Promise((resolve) => socket.send(payload, 0, payload.length, port, host, resolve));
      if (pacingMs) await new Promise((r) => setTimeout(r, pacingMs));
    }
    const deadline = now() + timeoutMs;
    while (rttList.length < packets && now() < deadline) await new Promise((r) => setTimeout(r, 25));
    await new Promise((r) => setTimeout(r, Math.min(settleMs, 60)));
  } finally {
    stop = true;
    socket.off('message', onMessage);
    socket.close();
  }

  const rtts = rttList.map((r) => r.rttMs).sort((a, b) => a - b);
  const received = rtts.length;
  const lossPct = ((packets - received) / packets) * 100;
  const mrt = median(rtts) ?? 0;
  return {
    ok: received > 0,
    sent: packets,
    received,
    lossPct: Math.round(lossPct * 10) / 10,
    rttMs: mrt,
    p95RttMs: rtts[Math.floor(rtts.length * 0.95)] ?? null,
    jitterMs: rtts.length > 1 ? median(rtts.map((v) => Math.abs(v - mrt))) : 0,
    // Nothing back at all is a different statement than a slow path: one means the
    // protocol is being killed, the other only that it is degraded.
    blocked: received === 0,
  };
}

/** Sustained TCP goodput sample. Bytes are produced locally by the responder, so
 *  this measures the path, not a CDN. */
export async function probeThroughput({ host, port = 20126, seconds = 3, timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    const start = now();
    let bytes = 0;
    const s = net.connect({ host, port }, () => s.write(`GET ${seconds}\n`));
    s.on('data', (chunk) => {
      bytes += chunk.length;
      if ((now() - start) / 1000 >= seconds) finish();
    });
    s.on('error', (e) => resolve({ ok: false, error: e.message }));
    s.on('end', finish);
    let done = false;
    function finish() {
      if (done) return;
      done = true;
      s.destroy();
      const elapsed = Math.max(0.05, (now() - start) / 1000);
      resolve({ ok: true, mbps: Math.round(((bytes * 8) / elapsed / 1e6) * 10) / 10, bytes, elapsedSec: Math.round(elapsed * 100) / 100 });
    }
    setTimeout(() => resolve({ ok: false, error: 'timeout' }), timeoutMs).unref?.();
  });
}

/**
 * SNI-filter classifier. We attempt a handshake with three different Hellos and
 * read the *shape* of the failure — that shape, not the timeout, is the signal.
 */
export function classifySniProbe({ clean, whitelisted, noSni }) {
  const died = (r) => !r?.ok && /ECONNRESET|ERR_SSL|EPROTO|onunexpected|tlsv1 alert|broken pipe|EOF/i.test(String(r?.error ?? ''));
  if (clean?.ok && whitelisted?.ok) return { sniFiltered: false, confidence: 0.9, note: 'both Hellos completed' };
  if (!clean?.ok && whitelisted?.ok && died(clean)) {
    return { sniFiltered: true, needsSpoofOrHiding: true, confidence: 0.85, note: 'real SNI was reset while a whitelisted SNI completed' };
  }
  if (!clean?.ok && !whitelisted?.ok && noSni?.ok) {
    return { sniFiltered: true, confidence: 0.6, note: 'only the nameless Hello survived — a matcher, not a TLS box' };
  }
  if (!clean?.ok && !whitelisted?.ok && !noSni?.ok) {
    return { portBlocked: true, confidence: 0.7, note: 'every handshake failed at this port; treat as blocked/port-throttled, not SNI-filtered' };
  }
  return { sniFiltered: false, confidence: 0.35, note: 'inconclusive' };
}

export async function probeSniFilter({ host, port = 443, realSni, whitelistedSni, timeoutMs = 4000 } = {}) {
  const attempt = (servername) =>
    new Promise((resolve) => {
      const s = tls.connect(
        { host, port, servername, rejectUnauthorized: false, ALPNProtocols: ['h2'], timeout: timeoutMs },
        () => {
          const info = { ok: true, protocol: s.getProtocol?.() ?? null, authorized: s.authorized };
          s.destroy();
          resolve(info);
        },
      );
      s.on('error', (e) => {
        s.destroy();
        resolve({ ok: false, error: e.message });
      });
      s.on('timeout', () => {
        s.destroy();
        resolve({ ok: false, error: 'ETIMEDOUT' });
      });
    });
  const [clean, whitelisted, noSni] = await Promise.all([attempt(realSni), whitelistedSni ? attempt(whitelistedSni) : { ok: false, error: 'no-whitelist' }, attempt(undefined)]);
  return { ...classifySniProbe({ clean, whitelisted, noSni }), raw: { clean, whitelisted, noSni } };
}

/**
 * One pass: everything that can be measured, plus the derived flags the ladder
 * consumes. Missing measurements stay `null` and the selector falls back to priors.
 */
export async function measureLink({ host, ports = [443], probePort = 20125, throughputPort = 20126, realSni, whitelistedSni, packets = 24, seconds = 2, access = 'wifi', withSniProbe = false } = {}) {
  const tcp = await probeTcpRtt({ host, ports });
  const udp = await probeUdp({ host, port: probePort, packets });
  const tp = await probeThroughput({ host, port: throughputPort, seconds });
  const sni = withSniProbe ? await probeSniFilter({ host, port: ports[0], realSni, whitelistedSni }) : null;

  const bestTcp = Object.values(tcp).filter((r) => r.ok).sort((a, b) => a.rttMs - b.rttMs)[0] ?? null;
  const link = {
    source: 'measured',
    access,
    rttMs: bestTcp?.rttMs ?? udp?.rttMs ?? null,
    jitterMs: udp?.jitterMs ?? bestTcp?.jitterMs ?? null,
    lossPct: udp?.ok ? udp.lossPct : null,
    downMbps: tp.ok ? tp.mbps : null,
    upMbps: tp.ok ? Math.round(tp.mbps * 0.35 * 10) / 10 : null,
    udpBlocked: !!udp.blocked,
    quicBlocked: !!udp.blocked,
    portBlocked: !Object.values(tcp).some((r) => r.ok),
    portThrottled: tp.ok && tp.mbps < 4 ? true : undefined,
    sniFiltered: sni?.sniFiltered,
    plaintextMatch: sni?.confidence >= 0.6 && sni.note?.includes('matcher') ? true : undefined,
    confidence: sni?.confidence ?? null,
    tcpOnly: !!udp.blocked,
    pmtuDrops: udp.ok && udp.lossPct > 35 ? true : undefined,
    measured: true,
    raw: { tcp, udp, throughput: tp, sni },
  };
  return link;
}
