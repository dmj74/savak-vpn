#!/usr/bin/env node
/**
 * savak probe responder — the peer end of engine/src/probes.js.
 *
 * Small on purpose: it must be safe to leave running on a tunnel host.
 *   UDP  <port>       echo "SAVAKP" + the sequence header back (RTT/loss/jitter)
 *   TCP  <port+1>     "GET <seconds>\n" → streams deterministic bytes until time is up
 *   TCP  <port+2>     plain TLS listener with a self-signed cert (SNI-filter classifier)
 *
 * It does not proxy anything and holds no secrets; it only measures the path.
 */

import dgram from 'node:dgram';
import net from 'node:net';
import tls from 'node:tls';
import { existsSync, readFileSync } from 'node:fs';

const UDP_PORT = Number(process.env.SAVAK_PROBE_UDP ?? 20125);
const TCP_PORT = UDP_PORT + 1;
const TLS_PORT = UDP_PORT + 2;
const CERT = process.env.SAVAK_PROBE_CERT ?? '/var/lib/savak/probe-cert.pem';
const KEY = process.env.SAVAK_PROBE_KEY ?? '/var/lib/savak/probe-key.pem';

const BLOCK = Buffer.alloc(64 * 1024, 0x58);

/**
 * Wire format (deliberately asymmetric):
 *   request  "SAVAKQ" | seq:u32 | t0:u32 | pad…
 *   response "SAVAKR" | seq:u32 | t0:u32          (14 bytes, always shorter)
 *
 * Two reasons for the distinct magic, both of them real:
 *   1. A relay between the phone and this host must be able to tell a probe from a
 *      reply. With one symmetric format (which is what this file originally had) any
 *      forwarder ping-pongs the same datagram back to us forever.
 *   2. Response ≪ request means the listener can never be turned into an amplification
 *      reflection by a spoofed source address — a UDP reflector that answers 1200 bytes
 *      to 1200 bytes is an attack tool, not a measuring device.
 */
export function startUdp(port = UDP_PORT) {
  const sock = dgram.createSocket('udp4');
  sock.on('message', (msg, rinfo) => {
    if (msg.length < 14 || msg.toString('ascii', 0, 6) !== 'SAVAKQ') return; // not ours, never reflect junk
    const reply = Buffer.alloc(14);
    msg.copy(reply, 6, 6, 14); // seq + client t0, echoed for RTT and clock-skew-free maths
    reply.write('SAVAKR', 0, 'ascii');
    sock.send(reply, 0, reply.length, rinfo.port, rinfo.address);
  });
  sock.bind(port);
  return sock;
}

export function startTcp(port = TCP_PORT) {
  return net
    .createServer((s) => {
      let stopAt = 0;
      let timer = null;
      s.once('data', (buf) => {
        const secs = Math.min(10, Number(String(buf).match(/(\d+(\.\d+)?)/)?.[1] ?? 2) || 2);
        stopAt = Date.now() + secs * 1000;
        const pump = () => {
          if (Date.now() >= stopAt) {
            s.end();
            return;
          }
          if (!s.write(BLOCK)) s.once('drain', pump);
          else setImmediate(pump);
        };
        pump();
      });
      s.on('error', () => {
        clearTimeout(timer);
        stopAt = 1;
      });
      s.on('close', () => {
        stopAt = 1;
        clearTimeout(timer);
      });
    })
    .listen(port);
}

export function startTls(port = TLS_PORT) {
  if (!existsSync(CERT) || !existsSync(KEY)) return null;
  return tls
    .createSecureServer(
      { cert: readFileSync(CERT), key: readFileSync(KEY) },
      (sock) => {
        sock.on('error', () => {});
        sock.end('ok\n');
      },
    )
    .listen(port);
}

if (process.argv[1] && process.argv[1].endsWith('probe-service.js')) {
  startUdp();
  startTcp();
  startTls();
  process.stdout.write(`savak probe responder: udp=${UDP_PORT} tcp=${TCP_PORT} tls=${TLS_PORT}\n`);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
}
