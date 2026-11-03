import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { startUdp, startTcp } from '../src/probe-service.js';
import { probeUdp, probeTcpRtt, probeThroughput, classifySniProbe, synthesizeLink, measureLink } from '../src/probes.js';
import { portOf } from './net-helpers.js';

/**
 * These are not mocked: a real UDP responder and a real byte sink run in-process on
 * loopback, and one test puts a lossy forwarder between them so the measurement layer
 * has to *detect* the loss it is told to introduce. If RTT/loss maths were wrong, the
 * ladder's congestion-control decision would be wrong on a real phone.
 */

const servers = [];
after(() => {
  for (const s of servers) {
    try {
      s.close?.();
    } catch {}
  }
});

test('UDP round-trip probe measures RTT and reports zero loss on loopback', async () => {
  const udp = startUdp(0);
  servers.push(udp);
  const port = await portOf(udp);
  const r = await probeUdp({ host: '127.0.0.1', port, packets: 12, size: 1200, timeoutMs: 500 });
  assert.equal(r.ok, true);
  assert.equal(r.received, 12);
  assert.equal(r.lossPct, 0);
  assert.ok(r.rttMs >= 0 && r.rttMs < 250, `loopback RTT should be sub-millisecond-ish, got ${r.rttMs}`);
  assert.equal(r.blocked, false);
});

test('a forwarder that drops 3 of 10 datagrams must be reported as ~30% loss', async () => {
  const echo = startUdp(0);
  servers.push(echo);
  const echoPort = await portOf(echo);

  // Deliberately lossy middleman: drops the datagrams whose sequence we choose,
  // so the *measured* loss number is something we can assert against.
  const drop = new Set([2, 6]);
  const gw = dgram.createSocket('udp4');
  servers.push(gw);
  let client = null;
  gw.on('message', (msg, rinfo) => {
    const dir = msg.toString('ascii', 0, 6);
    const seq = msg.readUInt32BE(6);
    if (dir === 'SAVAKR') return client && gw.send(msg, 0, msg.length, client.port, client.address);
    if (drop.has(seq)) return; // simulated loss on the forward path
    client = rinfo;
    gw.send(msg, 0, msg.length, echoPort, '127.0.0.1');
  });
  await new Promise((r) => gw.bind(0, '127.0.0.1', r));
  const gwPort = gw.address().port;

  const r = await probeUdp({ host: '127.0.0.1', port: gwPort, packets: 10, size: 1000, timeoutMs: 400 });
  assert.equal(r.sent, 10);
  assert.equal(r.received, 8, `expected exactly the 2 injected drops, got ${10 - r.received}`);
  assert.equal(r.lossPct, 20);
  assert.equal(r.blocked, false);
});

test('an unreachable UDP port is reported as blocked, not as "slow"', async () => {
  const r = await probeUdp({ host: '127.0.0.1', port: 1, packets: 3, size: 800, timeoutMs: 250 });
  assert.equal(r.ok, false);
  assert.equal(r.blocked, true);
});

test('TCP RTT probe reports per-port reachability', async () => {
  const sink = startTcp(0);
  servers.push(sink);
  const port = sink.address().port;
  const r = await probeTcpRtt({ host: '127.0.0.1', ports: [port, 1], samples: 3, timeoutMs: 400 });
  assert.equal(r[port].ok, true);
  assert.ok(r[port].rttMs < 250);
  assert.equal(r[1].ok, false, 'a closed port must show as unreachable');
  assert.ok(r[1].errors.length > 0);
});

test('throughput probe returns a sane goodput figure on loopback', async () => {
  const sink = startTcp(0);
  servers.push(sink);
  const r = await probeThroughput({ host: '127.0.0.1', port: sink.address().port, seconds: 1 });
  assert.equal(r.ok, true);
  assert.ok(r.mbps > 10, `loopback should stream plenty, got ${r.mbps} Mbps`);
  assert.ok(r.elapsedSec <= 2.5, `the probe must stop on time, ran ${r.elapsedSec}s`);
});

test('measureLink folds every probe into one ladder-ready view (loopback, nothing blocked)', async () => {
  const udp = startUdp(0);
  const sink = startTcp(0);
  servers.push(udp, sink);
  const udpPort = await portOf(udp);
  const link = await measureLink({
    host: '127.0.0.1',
    ports: [sink.address().port],
    probePort: udpPort,
    throughputPort: sink.address().port,
    packets: 6,
    seconds: 1,
    access: 'wifi',
  });
  assert.equal(link.source, 'measured');
  assert.equal(link.udpBlocked, false);
  assert.equal(link.portBlocked, false);
  assert.ok(link.downMbps > 0);
  assert.ok(link.rttMs >= 0);
  // The whole point: a phone on a healthy LAN must NOT be steered away from QUIC.
  assert.equal(link.tcpOnly, false);
});

test('SNI classifier reads the shape of the failure, not just the timeout', () => {
  const ok = { ok: true };
  assert.equal(classifySniProbe({ clean: ok, whitelisted: ok, noSni: ok }).sniFiltered, false);
  const reset = classifySniProbe({ clean: { ok: false, error: 'socket hang up: ECONNRESET' }, whitelisted: ok, noSni: ok });
  assert.equal(reset.sniFiltered, true);
  assert.ok(reset.needsSpoofOrHiding, 'a reset on the real SNI means the name must be hidden, not just reordered');
  const all = classifySniProbe({ clean: { ok: false, error: 'ECONNREFUSED' }, whitelisted: { ok: false, error: 'ECONNREFUSED' }, noSni: { ok: false, error: 'ECONNREFUSED' } });
  assert.equal(all.portBlocked, true);
  assert.equal(all.sniFiltered, undefined, 'do not claim SNI filtering when the port is simply dead');
  const matcher = classifySniProbe({ clean: { ok: false, error: 'ECONNRESET' }, whitelisted: { ok: false, error: 'ECONNRESET' }, noSni: ok });
  assert.equal(matcher.sniFiltered, true);
  assert.match(matcher.note, /matcher/);
});

test('synthetic link model honours ad-hoc signals and derives the dependent flags', () => {
  const l = synthesizeLink({ access: 'cellular', censor: 'udp-block', lossPct: 5, downMbps: 12 });
  assert.equal(l.udpBlocked, true);
  assert.equal(l.quicBlocked, true, 'quicBlocked is implied when UDP is gone');
  assert.equal(l.tcpOnly, true);
  assert.equal(l.lossPct, 5);
  assert.equal(l.downMbps, 12);
  const shaped = synthesizeLink({ portThrottled: true, mtuCap: 1400 });
  assert.equal(shaped.portThrottled, true);
  assert.equal(shaped.pmtuDrops, true, 'a 1400-byte path must be treated as a PMTUD problem');
});
