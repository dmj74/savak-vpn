/**
 * Speed + stealth tuning (تظیم موتور).
 * =====================================
 *
 * Two jobs:
 *
 *  1. SPEED  — every knob here shortens either the handshake, the per-packet
 *              round-trip budget, or the flow-control ceiling. Each knob is
 *              returned together with a human-readable `why`, because a config
 *              generator that cannot explain itself is how people end up with
 *              "magic" 4KB receive windows capping them at window/RTT.
 *
 *  2. STEALTH — evasion transforms are applied *only when the measurement says
 *              the censor is actually using that mechanism*. Applied blindly,
 *              fragmentation costs an extra RTT, padding costs bytes, port
 *              hopping costs handshakes. Applied surgically, it costs ~0.
 *
 * Ground rules taken from upstream sing-box 1.14 docs (not from folklore):
 *   • `route.sniff` / `geoip` / `geosite` / `gso` no longer exist → not emitted.
 *   • `tls.kernel_rx` "will definitely degrade performance" → never emitted.
 *   • `tls.utls` is documented as "Not Recommended … unsuitable for censorship
 *     circumvention" → opt-in only, with a warning, preferring Reality/ECH/Naïve.
 *   • Hysteria CC (BRUTAL) is only used when up/down_mbps are set; empty → BBR.
 *   • `spoof` is a *string* (the whitelisted SNI to forge), not a boolean.
 */

import { FAMILY, DEFAULT_HANDSHOOK_HOSTS, pacingBandwidth } from './ladder.js';

const MiB = 1024 * 1024;
const KiB = 1024;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v, step = 1) => Math.round(v / step) * step;

/** Named policies: what the selector optimises for, and which knobs it accepts. */
export const POLICIES = Object.freeze({
  auto: {
    label: 'خودکار — متوازن',
    weights: { throughput: 0.34, latency: 0.2, stability: 0.24, evasion: 0.16, cost: 0.06 },
    pacingHeadroomPct: 0.12,
    fakeIp: true,
    bondInterfaces: true,
    portHopping: 'on-signal',
    obfs: 'on-signal',
    minSwitchGainPct: 15,
    dwellMs: 45_000,
    probeIntervalMs: { wifi: 180_000, cellular: 300_000 },
  },
  speed: {
    label: 'سرعت حداکثری',
    weights: { throughput: 0.55, latency: 0.16, stability: 0.14, evasion: 0.08, cost: 0.07 },
    pacingHeadroomPct: 0.06,
    fakeIp: true,
    bondInterfaces: true,
    portHopping: 'on-signal',
    obfs: 'off',
    // In speed mode we actively *disable* transforms that cost bytes, and we
    // switch the TUN to the kernel stack (see tun.stack) instead of gVisor.
    stack: 'system',
    minSwitchGainPct: 10,
    dwellMs: 30_000,
    probeIntervalMs: { wifi: 120_000, cellular: 240_000 },
  },
  stealth: {
    label: 'ستیزگی حداکثری',
    weights: { throughput: 0.14, latency: 0.06, stability: 0.14, evasion: 0.6, cost: 0.06 },
    pacingHeadroomPct: 0.2,
    fakeIp: true,
    bondInterfaces: false,
    portHopping: 'always',
    obfs: 'gecko',
    stack: 'mixed',
    minSwitchGainPct: 30,
    dwellMs: 120_000,
    probeIntervalMs: { wifi: 600_000, cellular: 900_000 },
  },
  game: {
    label: 'تأخیر کم (بازی/ویدیوکال)',
    weights: { throughput: 0.1, latency: 0.55, stability: 0.25, evasion: 0.05, cost: 0.05 },
    pacingHeadroomPct: 0.25,
    fakeIp: true,
    bondInterfaces: true,
    portHopping: 'off', // hopping = occasional re-handshake = latency spike
    obfs: 'off', // salamander/gecko adds bytes per packet
    stack: 'system',
    udpRelayMode: 'native', // lossy-but-fast; 'quic' would add a retransmit layer
    congestionControl: 'bbr',
    minSwitchGainPct: 25,
    dwellMs: 90_000,
    probeIntervalMs: { wifi: 300_000, cellular: 300_000 },
  },
  resist: {
    label: 'مقاومت (آخرین راه‌حل)',
    weights: { throughput: 0.08, latency: 0.04, stability: 0.12, evasion: 0.7, cost: 0.06 },
    pacingHeadroomPct: 0.25,
    fakeIp: true,
    bondInterfaces: true,
    portHopping: 'always',
    obfs: 'gecko',
    stack: 'mixed',
    allowTor: true,
    allowLegacyUtls: true,
    minSwitchGainPct: 40,
    dwellMs: 180_000,
    probeIntervalMs: { wifi: 900_000, cellular: 900_000 },
  },
});

export function resolvePolicy(policy = {}) {
  const mode = policy.mode ?? 'auto';
  const base = POLICIES[mode] ?? POLICIES.auto;
  // `mode` is echoed back so downstream consumers (labels, the dashboard, the UI)
  // can tell an unknown mode from the default one instead of silently normalising it.
  return { mode, knownMode: !!POLICIES[mode], ...base, ...policy, weights: { ...base.weights, ...(policy.weights ?? {}) } };
}

/* ------------------------------------------------------------------ *
 * Link budget helpers
 * ------------------------------------------------------------------ */

/**
 * Throughput over one flow is bounded by `window / RTT` unless the transport
 * can open several streams. Sizing the QUIC windows from the *measured* BDP is
 * the single biggest config-level speedup for a link with a fat pipe and a
 * 60–90 ms RTT (Iran → Frankfurt/Istanbul is exactly that).
 */
export function sizeWindows({ downMbps = 40, rttMs = 60, streams = 4 }, notes) {
  const rtt = Math.max(rttMs, 5) / 1000;
  const bdp = ((downMbps * 1e6) / 8) * rtt; // bytes in flight for the whole link
  const perStream = bdp / Math.max(streams, 1);
  const connection = round(clamp(bdp * 8, 1 * MiB, 96 * MiB), MiB);
  const stream = round(clamp(perStream * 6, 256 * 1024, 24 * MiB), MiB);
  notes?.push({
    key: 'quic_receive_windows',
    why: `BDP ≈ ${(bdp / KiB) | 0} KiB at ${Math.round(rttMs)} ms; connection window ${connection / MiB} MiB, stream window ${stream / MiB} MiB (a 1 MiB stream window would cap one flow at ${Math.max(1, Math.round((1 * MiB * 8) / 1e6 / rtt))} Mbps)`,
  });
  return { connection, stream };
}

/** QUIC initial packet size: never exceed what the link can carry without IP fragmentation. */
export function initialPacketSize(client, link, notes) {
  const mtu = client.mtu ?? (link.access === 'cellular' ? 1280 : 1420);
  // 1200 is Chrome's typical QUIC initial for a 1280 MTU path; IPv6 + tunnel overhead is ~76 B.
  let ips = Math.min(1232, mtu - 76);
  if (link.pmtuDrops) ips = Math.min(ips, 1140);
  if (link.sizeHeuristic) ips = round(ips, 16); // keep the size profile tidy for the padder
  notes?.push({
    key: 'initial_packet_size',
    why: `first flight sized to ${ips} B so it never IP-fragments on a ${mtu}-byte MTU (a fragmented Initial = retransmit storm on cellular)`,
  });
  return clamp(ips, 1000, 1350);
}

/** TCP_FAST_OPEN: −1 RTT per new connection. Only meaningful if the server kept the cookie alive. */
export function fastOpen(server, link, notes) {
  const ok = !!server.capabilities?.tfo && !link.tfoBroken;
  if (ok) {
    notes?.push({
      key: 'tcp_fast_open',
      why: 'saves one RTT per new TCP connection; browsing opens many, so this is felt as "snappier" more than as higher peak speed',
    });
  }
  return ok;
}

/**
 * sing-box for Android can dial WiFi and cellular *concurrently* (MPTCP-style
 * bonding) — but only in the graphical clients with `auto_detect_interface`.
 * It is a resilience win first, a speed win second (the faster path wins).
 */
export function interfaceBonding(client, policy, notes) {
  if (!client.capabilities?.graphicalClient || !policy.bondInterfaces) return null;
  if (!client.interfaces?.cellular || !client.interfaces?.wifi) return null;
  notes?.push({
    key: 'network_strategy.hybrid',
    why: 'both radios are dialled at once and the faster path is kept, so a congested home WiFi or a throttled carrier never costs you the session',
  });
  return { network_strategy: 'hybrid', network_type: ['wifi', 'cellular'], fallback_delay: '250ms' };
}

/** kernel TLS TX: real zero-copy win, but only on Linux 5.1+, TLS 1.3, and only when nothing else sits above the socket. */
export function kernelTls({ client, rung, mux, quic }, notes) {
  if (!client.capabilities?.kernelTls || client.platform === 'android') return null;
  if (rung.family !== FAMILY.TLS_TCP || mux || quic || !client.tlsVersionAtLeast13) return null;
  notes?.push({
    key: 'tls.kernel_tx',
    why: 'kTLS TX with splice(2) on both ends (Linux ≥5.1, TLS 1.3) — CPU stops being the bottleneck on a 1 Gbps port',
  });
  // kernel_rx is deliberately never enabled: upstream states it "will definitely degrade performance".
  return { kernel_tx: true };
}

/* ------------------------------------------------------------------ *
 * Evasion decision table
 * ------------------------------------------------------------------ */

/**
 * Decide which TLS/QUIC-level transforms a rung needs for *this* link.
 * @returns {{tls:object, obfs:object|null, hop:object|null, flags:object[]}}
 */
export function evasion({ rung, link, client, policy, server, creds, notes }) {
  const tls = { enabled: true };
  const flags = [];
  const realityReady = !!creds?.realityPublicKey && !!server?.capabilities?.reality;
  const isTlsTcp = rung.family === FAMILY.TLS_TCP;

  // ---- SNI filtering -------------------------------------------------
  // Order of preference: Reality (no SNI exposure at all) > ECH (encrypted SNI)
  // > record_fragment (split the ClientHello so a string matcher misses)
  // > spoof (forge a whitelisted Hello first; needs raw sockets ⇒ not Android)
  if (link.sniFiltered || policy.mode === 'stealth' || policy.mode === 'resist') {
    if (realityReady && (isTlsTcp || rung.family === FAMILY.QUIC)) {
      if (isTlsTcp) {
        tls.reality = {
          enabled: true,
          public_key: creds.realityPublicKey,
          short_id: creds.realityShortId ?? '',
        };
        tls.server_name = creds.realityServerName ?? server.realityDest?.host ?? DEFAULT_HANDSHOOK_HOSTS[0];
        tls.min_version = '1.3';
        flags.push({ flag: 'reality', note: 'handshake completed against a real site: no certificate to seize, no fake Hello to probe' });
      }
    } else if (creds?.echConfig) {
      tls.ech = { enabled: true, config: creds.echConfig };
      tls.server_name = creds.serverName ?? server.address;
      flags.push({ flag: 'ech', note: 'SNI is encrypted inside the ClientHello; the middlebox sees only the IP' });
    } else if (client.capabilities?.packetInjection) {
      const whitelisted = (policy.sniWhitelist?.length ? policy.sniWhitelist : ['www.google.com'])[0];
      tls.spoof = whitelisted;
      tls.spoof_method = link.spoofMethodDowngraded ? 'wrong-checksum' : 'wrong-sequence';
      tls.record_fragment = true;
      flags.push({ flag: 'spoof', note: `forged ClientHello with whitelisted SNI ${whitelisted} is injected ahead of the real one, then invalidated by a ${tls.spoof_method} segment` });
    } else {
      // Android: userspace only, so fragmenting TLS records is the honest option.
      tls.record_fragment = true;
      flags.push({ flag: 'record_fragment', note: 'split the ClientHello across TLS records (works inside a TUN, no raw sockets)' });
    }
  }

  // ---- Plain-string middlebox on plaintext (rare, but some ISP CPEs) ---
  if (link.plaintextMatch && !tls.fragment) {
    tls.fragment = true;
    tls.fragment_fallback_delay = link.access === 'cellular' ? '900ms' : '500ms';
    flags.push({ flag: 'fragment', note: 'only enabled because a hello was RST with no TLS alert at all — i.e. a string matcher, not a TLS-aware box' });
  }

  // ---- SNI/cert handling for QUIC rungs --------------------------------
  if (rung.family === FAMILY.QUIC) {
    tls.alpn = ['h3'];
    if (server.tlsMode === 'self-signed') {
      // Public-key pinning instead of `insecure`: `insecure` is a fingerprint and a MITM hole.
      tls.certificate_public_key_sha256 = [server.pinnedKeySha256];
      flags.push({ flag: 'pin_spki', note: 'pinning the server SPKI rather than disabling verification, so an on-path box cannot MITM the tunnel' });
    } else if (server.tlsMode === 'acme') {
      tls.server_name = creds.serverName ?? server.address;
    }
    if (isTlsTcp === false && !tls.server_name && creds.serverName) tls.server_name = creds.serverName;
    if (!tls.server_name && link.sniFiltered) {
      notes?.push({
        key: 'quic_sni_risk',
        why: 'QUIC rungs still send a plaintext SNI unless ECH is configured — fine when SNI filtering is not in play, weak otherwise',
      });
    }
  } else if (isTlsTcp && !tls.reality && !tls.server_name) {
    tls.server_name = creds.serverName ?? server.address;
  }

  // ---- min TLS 1.3 everywhere (1-RTT, 0-RTT resumption, no legacy fingerprints) ----
  if (!tls.min_version && !tls.reality) tls.min_version = '1.3';

  // ---- uTLS: legacy interop only ---------------------------------------
  if (policy.allowLegacyUtls && link.clientHelloFingerprinted && !tls.reality) {
    tls.utls = { enabled: true, fingerprint: client.capabilities?.browserHint ?? 'chrome' };
    notes?.push({
      key: 'utls_legacy',
      why: 'upstream calls uTLS "unsuitable for censorship circumvention" — kept only for servers that need it; prefer Reality, ECH or NaïveProxy',
    });
    flags.push({ flag: 'utls', note: 'legacy ClientHello mimicry (documented as detectable — consider upgrading the server)' });
  }

  // ---- QUIC fingerprint + size heuristics ------------------------------
  let obfs = null;
  const wantObfs = policy.obfs !== 'off' && (policy.obfs === 'always' || policy.obfs === 'gecko' || policy.obfs === 'salamander' || (policy.obfs === 'on-signal' && (link.sizeHeuristic || link.quicFingerprinted)));
  if (rung.id === 'hy2_brutal' && wantObfs) {
    // An explicit user choice wins; otherwise pick by the signal: size heuristics need
    // size padding (gecko), payload regexes only need the stream cipher (salamander, cheaper).
    const type = policy.obfs === 'salamander' ? 'salamander' : policy.obfs === 'gecko' || policy.obfs === 'always' ? 'gecko' : link.sizeHeuristic ? 'gecko' : 'salamander';
    obfs = { type, password: creds.hy2ObfsPassword };
    if (type === 'gecko') {
      obfs.min_packet_size = 512;
      obfs.max_packet_size = link.access === 'cellular' ? 1100 : 1200;
    }
    flags.push({
      flag: `obfs_${type}`,
      note:
        type === 'gecko'
          ? 'sizes every on-wire packet into a browser-like band, so "one 1200 B + N tiny" patterns stop identifying the tunnel'
          : 'stream-cipher obfuscation of QUIC payloads; cheap, defeats payload regexes',
    });
  }

  // ---- per-port QoS throttling → port hopping --------------------------
  let hop = null;
  // Hopping is the answer to per-port QoS; for a protocol-wide UDP throttle it is
  // pointless, and in 'game' mode a hop is a latency spike, so the policy says no.
  const wantHop =
    policy.portHopping !== 'off' &&
    (policy.portHopping === 'always' || (policy.portHopping === 'on-signal' && (link.portThrottled || link.portBlocked) && !link.udpThrottled)) && !link.udpBlocked;
  const portPool = server.ports?.hop ?? server.hopPorts ?? (Array.isArray(server.ports) ? server.ports : null);
  if (wantHop && rung.family === FAMILY.QUIC && portPool?.length) {
    hop = {
      server_ports: portPool,
      hop_interval: '45s',
      hop_interval_max: link.portThrottled ? '120s' : '180s',
    };
    flags.push({
      flag: 'port_hop',
      note: `hops across ${portPool.length} ranges on a randomised 45–${hop.hop_interval_max} cadence, so a shaper that profiled one UDP port loses the flow`,
    });
  }

  if (!flags.length) flags.push({ flag: 'clean', note: 'no evasion transforms needed on this path — every byte saved is throughput' });
  return { tls, obfs, hop, flags };
}

/* ------------------------------------------------------------------ *
 * One entry point: build every tuning block for one rung on one link
 * ------------------------------------------------------------------ */

export function tuneFor({ rung, link, client, server, creds, policy, notes = [] }) {
  const out = { notes };

  // TLS / obfuscation / hopping --------------------------------------
  const { tls, obfs, hop, flags } = evasion({ rung, link, client, policy, server, creds, notes });
  out.tls = tls;
  out.obfs = obfs;
  out.hop = hop ?? {};
  out.evadeFlags = flags;

  // Congestion control & bandwidth pacing -----------------------------
  const bandwidth = pacingBandwidth(link, policy);
  out.bandwidth = bandwidth;
  const measuredFat = (link.downMbps ?? 0) >= 25 || (link.lossPct ?? 0) >= 2;
  if (rung.family === FAMILY.QUIC) {
    if (!bandwidth.downMbps) {
      out.bbrProfile = link.lossPct >= 4 ? 'conservative' : policy.mode === 'speed' ? 'aggressive' : 'standard';
      notes.push({
        key: 'bbr_profile',
        why: `bandwidth unmeasured, so BBR (${out.bbrProfile}) is used instead of a guessed pacing rate — a wrong BRUTAL number is worse than no number`,
      });
    } else {
      notes.push({
        key: 'brutal_pacing',
        why: `BRUTAL paces at ${bandwidth.downMbps}/${bandwidth.upMbps} Mbps (measured × ${Math.round((1 - (policy.pacingHeadroomPct ?? 0.12)) * 100)}%, the headroom keeps the queue from building), which ignores the loss signal — the point of BRUTAL on a link that is *shaped* rather than congested`,
      });
    }
  }
  out.congestionControl =
    policy.congestionControl ?? (rung.id === 'tuic_v5' ? (measuredFat ? 'bbr' : 'cubic') : 'bbr');
  out.udpRelayMode = policy.udpRelayMode ?? (link.lossPct >= 6 ? 'quic' : 'native');
  out.zeroRtt = !!server.capabilities?.zeroRtt && link.access === 'cellular';
  if (out.zeroRtt) {
    notes.push({ key: 'zero_rtt', why: 'resumes the QUIC session without a round-trip — the radio-wake reconnect you feel as "it took 2 seconds to come back"' });
  }
  out.heartbeat = link.access === 'cellular' ? '8s' : '15s';

  // Flow control / buffers --------------------------------------------
  const windows = sizeWindows({ downMbps: link.downMbps ?? 40, rttMs: link.rttMs ?? 60, streams: 4 }, notes);
  out.connectionReceiveWindow = windows.connection;
  out.streamReceiveWindow = windows.stream;
  out.initialPacketSize = initialPacketSize(client, link, notes);
  out.maxConcurrentStreams = clamp((link.flows ?? 64) * 2, 128, 1024);
  out.quic = {
    initial_packet_size: out.initialPacketSize,
    connection_receive_window: out.connectionReceiveWindow,
    stream_receive_window: out.streamReceiveWindow,
    max_concurrent_streams: out.maxConcurrentStreams,
    keep_alive_period: client.interfaces?.cellular && !client.interfaces?.wifi ? '45s' : '120s',
    idle_timeout: policy.mode === 'game' ? '20s' : '60s',
  };
  if (link.pmtuDrops) out.quic.disable_path_mtu_discovery = true;

  // Dialer-level -------------------------------------------------------
  const dial = {};
  if (fastOpen(server, link, notes)) dial.tcp_fast_open = true;
  if (client.capabilities?.mptcp && policy.mode !== 'stealth') {
    dial.tcp_multi_path = true;
    notes.push({ key: 'tcp_multi_path', why: 'MPTCP lets a single TCP session survive the WiFi↔cellular handover instead of dying and re-starting' });
  }
  const bond = interfaceBonding(client, policy, notes);
  Object.assign(dial, bond ?? {});
  if (link.mtuCap && link.mtuCap < 1420) dial.udp_fragment = true;
  dial.connect_timeout = link.access === 'cellular' ? '3s' : '2s';
  // TLS handshake budget lives in the TLS block, not the dialer.
  if (link.access === 'cellular') tls.handshake_timeout = '10s';
  dial.tcp_keep_alive = link.access === 'cellular' ? '2m' : '5m';
  dial.tcp_keep_alive_interval = link.access === 'cellular' ? '30s' : '75s';
  if (server.capabilities?.probeResistant) dial.fallback_delay = '300ms';
  out.dial = dial;

  // Multiplexing ---------------------------------------------------------
  // mux is a latency/overhead tradeoff: one TLS session carrying N streams.
  const muxEligible = [FAMILY.TLS_TCP, FAMILY.RAW_UDP].includes(rung.family) && rung.id !== 'tor_bridge';
  if (muxEligible && policy.mode !== 'game') {
    const mux = {
      enabled: true,
      protocol: link.lossPct >= 3 ? 'smux' : 'h2mux',
      max_connections: clamp(Math.ceil((link.flows ?? 64) / 32), 2, 6),
      min_streams: link.access === 'cellular' ? 4 : 8,
      padding: false, // padding is bytes we pay for forever
    };
    if (server.capabilities?.tcpBrutal && bandwidth.downMbps) {
      mux.brutal = { enabled: true, up_mbps: bandwidth.upMbps, down_mbps: bandwidth.downMbps };
      notes.push({ key: 'mux_brutal', why: 'TCP Brutal on the single multiplexed session — the "VLESS+TCP+Brutal" trick that keeps throughput flat under loss on a shaped link (needs the brutal kernel module on the server)' });
    }
    out.mux = mux;
    notes.push({
      key: 'multiplex',
      why: `${mux.protocol} with up to ${mux.max_connections}×${mux.min_streams} streams: browsing stops paying a fresh TLS handshake per connection, which on a 70 ms RTT is the dominant cost`,
    });
  }

  // Per-rung extras ------------------------------------------------------
  out.packetEncoding = rung.id.startsWith('vless') ? (link.udpHeavy ? 'xudp' : '') : undefined;
  if (out.packetEncoding === 'xudp') {
    notes.push({ key: 'xudp', why: 'UDP traffic (QUIC, DNS, VoIP) is batched into the one tunnel session instead of a new association per flow' });
  }
  out.udpOverTcp = rung.id === 'ss2022' && link.tcpOnly ? { enabled: true, version: 2 } : undefined;
  out.earlyDataBytes = link.tlsEoT && rung.id === 'vless_ws_cdn' ? 4096 : 0;
  out.globalPadding = rung.id === 'vmess_ws' ? true : undefined;
  // NaïveProxy has two personalities and they behave completely differently under a
  // UDP-capping censor: HTTP/2 over TCP, or HTTP/3 over QUIC. Choose by the link.
  out.naiveQuic = rung.id === 'naive_h3' && !link.udpBlocked && !link.udpThrottled;
  out.idleSessionTimeout = rung.id === 'anytls' ? '5m' : undefined;
  out.minIdleSession = rung.id === 'anytls' ? 8 : undefined;
  out.brutalDebug = false;
  const ktls = kernelTls({ client, rung, mux: out.mux, quic: rung.family === FAMILY.QUIC }, notes);
  if (ktls) Object.assign(out.tls, ktls);
  return out;
}

/** Any-TLS padding scheme: OpenVPN-like size statistics (documented default reproduced, tightened). */
export const ANYTLS_PADDING = Object.freeze([
  '0=30-30',
  '1=100-400',
  '2=400-500,c,500-1000,c,500-1000,c,500-1000,c,500-1000',
  '3=400-500,c,500-1000,c,500-1000,c,500-1000',
  '4=9',
  '5=10-20',
  'm1=10-20,m2=10-20',
  'r1=15-25,r2=15-25',
  'w0=5-7,w1=5-7',
]);
