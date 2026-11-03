import { planForNode } from '../src/index.js';
import { serverConfig } from '../src/singbox.js';
import { tuneFor } from '../src/tune.js';
import { RUNGS } from '../src/ladder.js';
import { synthesizeLink } from '../src/probes.js';
import { nodeView } from '../src/profile.js';

/** Shared fixture wiring so tests exercise the same code path as the CLI. */
export { planForNode };

export function serverConfigForTest(profile, nodeId) {
  const node = nodeView(profile, nodeId);
  const link = synthesizeLink({ access: 'wifi' });
  const ladder = RUNGS.map((rung) => {
    const tuning = tuneFor({
      rung,
      link,
      client: { platform: 'linux', mtu: 1420, capabilities: { kernelTls: true } },
      server: { ...node, capabilities: node.capabilities ?? {} },
      creds: profile.credentials,
      policy: { mode: 'auto' },
      notes: [],
    });
    return { id: rung.id, rung, tuning, feasible: (node.protocols ?? []).includes(rung.id) };
  });
  return serverConfig({
    profile,
    node,
    server: { ...node, creds: profile.credentials, profile, paths: { cert: '/var/lib/savak/tls.crt', key: '/var/lib/savak/tls.key', state: '/var/lib/savak' } },
    creds: profile.credentials,
    policy: { mode: 'auto' },
    ladder,
    options: { hostname: 'fra1.savak.example', certificateProvider: true, acmeEmail: 'ops@savak.example', masqueradeUrl: 'https://www.google.com', realityDest: node.realityDest, paths: { state: '/var/lib/savak' } },
  });
}
