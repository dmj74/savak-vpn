/**
 * Savak Smart Evasion Ladder — پلکان دور زدن فیلترینگ
 * ===================================================
 *
 * هر «پله» (rung) یکی از معروف‌ترین پروتکل‌های ضدسانسور دنیاست که به‌همراه
 * *بهترین ایده‌ی* آن پروتکل درون خودِ پله کدگذاری شده است. موتور به‌جای اینکه
 * کاربر را مجبور کند بین Hysteria2 / VLESS-Reality / TUIC / WireGuard / ... یکی
 * را انتخاب کند، همه‌ی آن‌ها را هم‌زمان می‌سنجد و هوشمندانه انتخاب/تعویض می‌کند.
 *
 * Each rung is a famous circumvention tool, kept importable as a standalone
 * outbound, plus the metadata the selector needs:
 *
 *   requires      hard feasibility gates (link/client capabilities) — checked BEFORE scoring
 *   cost          rttCostMs / overheadPct / cpuLoad  (what the rung spends to buy stealth)
 *   affinity      how well it survives each censor mechanism (0..1)
 *   perf          which speed knobs actually apply to it (see tune.js)
 *   build()       emits a sing-box *client* outbound (schema-validated, sing-box 1.14)
 *   server()      emits the matching sing-box *server* listener (for server/bootstrap.sh)
 *
 * Nothing here is invented: every field emitted below exists in the vendored
 * sing-box 1.14.4 JSON schema (see test/schema.test.js), and every claim in the
 * comments cites a doc section from the upstream tree.
 */

/** Families group rungs that share a failure mode (and a warm handover path). */
export const FAMILY = Object.freeze({
  QUIC: 'quic',
  TLS_TCP: 'tls-tcp',
  RAW_UDP: 'raw-udp',
  RELAY: 'relay',
});

/**
 * @typedef {object} Rung
 * @property {string} id
 * @property {string} title
 * @property {string} lineage      the "famous VPN" this rung comes from
 * @property {string} family
 * @property {'outbound'|'endpoint'} carrier   where the rung can be attached in a config
 * @property {Record<string,any>} requires
 * @property {{rttCostMs:number, overheadPct:number, cpuLoad:number}} cost
 * @property {Record<string,number>} affinity
 * @property {string[]} perf
 * @property {(ctx:object, tuning:object)=>object} build
 * @property {(ctx:object, tuning:object)=>object|null} [server]
 */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Reality/QUIC handshake against a high-reputation host the censor rarely blocks wholesale. */
export const DEFAULT_HANDSHOOK_HOSTS = Object.freeze([
  'www.google.com',
  'youtube.com',
  'www.microsoft.com',
  'dl.google.com',
]);

/**
 * The ladder, ordered from "fastest when it works" to "works when everything else failed".
 * Order alone is NOT the choice — score.js re-ranks it from live measurements.
 */
export const RUNGS = [
  {
    id: 'hy2_brutal',
    title: 'Hysteria2 · BRUTAL + gecko',
    lineage:
      'Hysteria (apernet) — QUIC-based, famous for surviving heavily lossy/shaped links; sing-box 1.14 adds Chrome QUIC parrot, port hopping and the gecko size-padding obfuscator',
    family: FAMILY.QUIC,
    requires: { udp: true, quic: true, mtuFloor: 1200 },
    cost: { rttCostMs: 1, overheadPct: 0.12, cpuLoad: 0.55 },
    affinity: {
      loss: 0.95, // BRUTAL is pacing-based: loss does not collapse the window
      shaping: 0.95, // constant-rate padding defeats "slow-start then throttle" shapers
      udp_qos: 0.7, // port hopping dodges per-port throttling
      dpi_quic: 0.8, // Chrome parrot + gecko padding
      dpi_sni: 0.45, // SNI still visible unless ECH/masquerade — see stealth mode
      active_probe: 0.75, // masquerade answers HTTP junk like a normal site
      tcp_only: 0.0,
      cpu: 0.5,
    },
    perf: ['brutal', 'port_hopping', 'quic_mtu', 'tfo', 'keepalive'],
    build(ctx, t) {
      const hy2 = {
        type: 'hysteria2',
        tag: ctx.tag,
        server: ctx.server.address,
        server_port: ctx.server.port,
        password: ctx.creds.hy2Password,
        ...t.quic,
        ...t.hop,
        tls: t.tls,
        ...t.dial,
      };
      if (t.bandwidth.upMbps || t.bandwidth.downMbps) {
        // "If empty, the BBR congestion control algorithm will be used instead of Hysteria CC."
        // So setting up/down_mbps is exactly what switches on BRUTAL.
        if (t.bandwidth.upMbps) hy2.up_mbps = t.bandwidth.upMbps;
        if (t.bandwidth.downMbps) hy2.down_mbps = t.bandwidth.downMbps;
      } else if (t.bbrProfile) {
        hy2.bbr_profile = t.bbrProfile; // conservative | standard | aggressive
      }
      if (t.obfs) hy2.obfs = t.obfs; // {type: salamander|gecko, password}
      if (t.brutalDebug) hy2.brutal_debug = true;
      if (ctx.policy.mode === 'speed' && ctx.client.capabilities.chromeParrot) {
        // keep parrot on (default) — Chrome-like handshake, harder to fingerprint
      } else if (ctx.client.capabilities.chromeParrot === 'off') {
        hy2.disable_chrome_parrot = true; // e.g. Ed25519 cert servers, which Chrome cannot verify
      }
      return hy2;
    },
    server(ctx, t) {
      return {
        type: 'hysteria2',
        tag: `${ctx.tag}-in`,
        listen: '::',
        listen_port: ctx.server.port,
        users: [{ name: ctx.profile.user, password: ctx.creds.hy2Password }],
        ...(t.obfs ? { obfs: t.obfs } : {}),
        ...(ctx.server.masquerade ? { masquerade: ctx.server.masquerade } : {}),
        tls: { enabled: true, certificate_path: ctx.paths.cert, key_path: ctx.paths.key },
      };
    },
  },

  {
    id: 'tuic_v5',
    title: 'TUIC v5 · 0-RTT QUIC',
    lineage:
      'TUIC (EA1204/IMUX) — designed for mobile: resumption with 0-RTT, so a reconnect after the radio sleeps costs no handshake round-trip',
    family: FAMILY.QUIC,
    requires: { udp: true, quic: true, mtuFloor: 1200 },
    cost: { rttCostMs: 0, overheadPct: 0.1, cpuLoad: 0.45 },
    affinity: {
      loss: 0.75,
      shaping: 0.6,
      udp_qos: 0.55,
      dpi_quic: 0.5, // no Chrome parrot available here — weaker than hy2 under QUIC fingerprinting
      dpi_sni: 0.5,
      active_probe: 0.6,
      tcp_only: 0.0,
      cpu: 0.6,
    },
    perf: ['zero_rtt', 'udp_relay', 'keepalive', 'tfo'],
    build(ctx, t) {
      const tuic = {
        type: 'tuic',
        tag: ctx.tag,
        server: ctx.server.address,
        server_port: ctx.server.port,
        uuid: ctx.creds.tuicUuid,
        password: ctx.creds.tuicPassword,
        congestion_control: t.congestionControl, // cubic | new_reno | bbr
        udp_relay_mode: t.udpRelayMode, // native | quic
        heartbeat: t.heartbeat,
        tls: t.tls,
        ...t.quic,
        ...t.dial,
      };
      if (t.zeroRtt) tuic.zero_rtt_handshake = true;
      return tuic;
    },
    server(ctx, t) {
      return {
        type: 'tuic',
        tag: `${ctx.tag}-in`,
        listen: '::',
        listen_port: ctx.server.port,
        users: [{ name: ctx.profile.user, uuid: ctx.creds.tuicUuid, password: ctx.creds.tuicPassword }],
        congestion_control: t.congestionControl,
        zero_rtt_handshake: !!t.zeroRtt,
        tls: { enabled: true, certificate_path: ctx.paths.cert, key_path: ctx.paths.key },
      };
    },
  },

  {
    id: 'vless_reality_tcp',
    title: 'VLESS · Reality + xtls-rprx-vision (+ TCP Brutal)',
    lineage:
      'Xray/VLESS Reality (RPRX) — the reference design against active probing: the handshake completes against a REAL website, so there is no certificate and no fake-Hello to fingerprint',
    family: FAMILY.TLS_TCP,
    requires: { udp: false, quic: false, mtuFloor: 0 },
    cost: { rttCostMs: 1, overheadPct: 0.045, cpuLoad: 0.3 },
    affinity: {
      loss: 0.35, // TCP loss control hurts on cellular; Brutal buys this back when bandwidth is known
      shaping: 0.5,
      udp_qos: 1.0, // irrelevant: it never uses UDP, so UDP throttling cannot hurt
      dpi_quic: 1.0,
      dpi_sni: 0.95, // Reality hides the real SNI entirely
      active_probe: 0.98, // unauthenticated probes get a genuine target-site TLS session
      tcp_only: 1.0,
      cpu: 0.75,
    },
    perf: ['tcp_brutal', 'mux', 'tfo', 'record_fragment', 'spoof'],
    build(ctx, t) {
      const vless = {
        type: 'vless',
        tag: ctx.tag,
        server: ctx.server.address,
        server_port: ctx.server.port,
        uuid: ctx.creds.uuid,
        flow: 'xtls-rprx-vision',
        network: 'tcp',
        tls: t.tls, // tls.reality.enabled + public_key + short_id + server_name
        ...t.dial,
      };
      if (t.mux) vless.multiplex = t.mux; // carries `brutal` for the TCP path
      if (t.packetEncoding !== undefined) vless.packet_encoding = t.packetEncoding;
      return vless;
    },
    server(ctx, t) {
      return {
        type: 'vless',
        tag: `${ctx.tag}-in`,
        listen: '::',
        listen_port: ctx.server.port,
        users: [{ name: ctx.profile.user, uuid: ctx.creds.uuid, flow: 'xtls-rprx-vision' }],
        multiplex: t.mux ? { enabled: true, padding: false, brutal: t.brutalInbound } : undefined,
        tls: {
          enabled: true,
          reality: {
            enabled: true,
            // sing-box calls it `server_port` here (ServerOptions, not ListenOptions).
            handshake: { server: ctx.server.realityDest.host, server_port: ctx.server.realityDest.port ?? 443 },
            private_key: ctx.creds.realityPrivateKey,
            max_time_difference: '90s',
          },
        },
      };
    },
  },

  {
    id: 'vless_reality_grpc',
    title: 'VLESS · Reality + gRPC (mux)',
    lineage:
      'VMess/gRPC lineage (v2fly transport) — many small RPCs over one long HTTP/2 connection; survives middleboxes that kill long-lived raw TCP and works behind CDN workers',
    family: FAMILY.TLS_TCP,
    requires: { udp: false, quic: false, mtuFloor: 0, http2: true },
    cost: { rttCostMs: 1, overheadPct: 0.09, cpuLoad: 0.4 },
    affinity: {
      loss: 0.5,
      shaping: 0.6,
      udp_qos: 1.0,
      dpi_quic: 1.0,
      dpi_sni: 0.9,
      active_probe: 0.9,
      tcp_only: 1.0,
      cpu: 0.6,
      cdn: 0.9, // can be fronted by a CDN worker
    },
    perf: ['mux', 'grpc_ping', 'record_fragment', 'spoof'],
    build(ctx, t) {
      return {
        type: 'vless',
        tag: ctx.tag,
        server: ctx.server.address,
        server_port: ctx.server.port,
        uuid: ctx.creds.uuid,
        network: 'tcp',
        transport: {
          type: 'grpc',
          service_name: ctx.server.serviceName,
          idle_timeout: ctx.server.grpcIdleTimeout,
          ping_timeout: ctx.server.grpcPingTimeout,
          permit_without_stream: false,
        },
        tls: t.tls,
        ...t.dial,
      };
    },
    server(ctx) {
      return {
        type: 'vless',
        tag: `${ctx.tag}-in`,
        listen: '::',
        listen_port: ctx.server.port,
        users: [{ name: ctx.profile.user, uuid: ctx.creds.uuid }],
        transport: { type: 'grpc', service_name: ctx.server.serviceName },
        tls: { enabled: true, certificate_path: ctx.paths.cert, key_path: ctx.paths.key },
      };
    },
  },

  {
    id: 'wg_uot',
    title: 'WireGuard · UDP + fragmentation',
    lineage:
      'WireGuard (Jason Donenfeld) — the throughput/latency king on clean links: ~1.5× the goodput of TLS-wrapped tunnels at a fraction of the CPU, so it wins on weak phones',
    family: FAMILY.RAW_UDP,
    // sing-box 1.11+ removed the `wireguard` outbound: WG is an *endpoint*, i.e. its own
    // interface. It therefore cannot live inside a `selector` — when it wins, the whole
    // capture strategy changes (see singbox.js#endpointClientConfig). It also means
    // split tunnelling is gone, which is a real cost and is scored as such.
    carrier: 'endpoint',
    requires: { udp: true, quic: false, mtuFloor: 1280, kernelCrypto: false },
    cost: { rttCostMs: 0, overheadPct: 0.02, cpuLoad: 0.12 },
    affinity: {
      loss: 0.4, // no loss recovery of its own — relies on the link
      shaping: 0.3, // packet-size profile is recognisable
      udp_qos: 0.35,
      dpi_quic: 1.0,
      dpi_sni: 0.05, // no TLS at all: if DPI is doing WG-signature matching this dies
      active_probe: 0.1, // responds to anything with a reply/parse error
      tcp_only: 0.0,
      cpu: 1.0, // best on low-CPU devices
    },
    perf: ['udp_fragment', 'keepalive', 'workers'],
    build(ctx, t) {
      // Materialised as a sing-box endpoint, never as an outbound — see singbox.js#endpointClientConfig
      return { endpoint: true };
    },
    server(ctx, t) {
      return {
        type: 'wireguard',
        tag: `${ctx.tag}-in`,
        listen_port: ctx.server.port,
        private_key: ctx.creds.wg.serverPrivateKey,
        mtu: ctx.client.mtu,
        system: true,
        peers: [{ public_key: ctx.creds.wg.clientPublicKey, allowed_ips: ['0.0.0.0/0', '::/0'] }],
      };
    },
  },

  {
    id: 'anytls',
    title: 'AnyTLS · padded',
    lineage:
      'AnyTLS (AmneziaWG lineage) — a TLS-shaped control channel whose bandwidth cost is dominated by padding instead of crypto, i.e. "OpenVPN without the CPU"; default padding_scheme mirrors OpenVPN-over-TLS size statistics',
    family: FAMILY.TLS_TCP,
    requires: { udp: false, quic: false, mtuFloor: 0, tls: true },
    cost: { rttCostMs: 1, overheadPct: 0.28, cpuLoad: 0.25 },
    affinity: {
      loss: 0.45,
      shaping: 0.75, // heavy padding looks like an ordinary TLS video session
      udp_qos: 1.0,
      dpi_quic: 1.0,
      dpi_sni: 0.6,
      active_probe: 0.7,
      tcp_only: 1.0,
      cpu: 0.85,
    },
    perf: ['padding', 'tfo', 'record_fragment'],
    build(ctx, t) {
      return {
        type: 'anytls',
        tag: ctx.tag,
        server: ctx.server.address,
        server_port: ctx.server.port,
        password: ctx.creds.anytlsPassword,
        idle_session_timeout: t.idleSessionTimeout,
        min_idle_session: t.minIdleSession,
        tls: t.tls,
        ...t.dial,
      };
    },
    server(ctx) {
      return {
        type: 'anytls',
        tag: `${ctx.tag}-in`,
        listen: '::',
        listen_port: ctx.server.port,
        users: [{ name: ctx.profile.user, password: ctx.creds.anytlsPassword }],
        tls: { enabled: true, certificate_path: ctx.paths.cert, key_path: ctx.paths.key },
      };
    },
  },

  {
    id: 'ss2022',
    title: 'Shadowsocks 2022 · AEAD',
    lineage:
      'Shadowsocks (clowwindy → Outline) — the original smart-proxy: almost no framing overhead, so it still wins on links where TLS/QUIC is affordable but bandwidth is scarce',
    family: FAMILY.RAW_UDP,
    requires: { udp: false, quic: false, mtuFloor: 0 },
    cost: { rttCostMs: 0, overheadPct: 0.015, cpuLoad: 0.18 },
    affinity: {
      loss: 0.35,
      shaping: 0.35,
      udp_qos: 0.8,
      dpi_quic: 1.0,
      dpi_sni: 0.05, // no TLS, and the AEAD salt is a known fingerprint
      active_probe: 0.25,
      tcp_only: 1.0,
      cpu: 0.95,
    },
    perf: ['mux', 'udp_over_tcp', 'tfo'],
    build(ctx, t) {
      const ss = {
        type: 'shadowsocks',
        tag: ctx.tag,
        server: ctx.server.address,
        server_port: ctx.server.port,
        method: ctx.creds.ssMethod,
        password: ctx.creds.ssPassword,
        ...t.dial,
      };
      if (t.mux) ss.multiplex = t.mux;
      if (t.udpOverTcp) ss.udp_over_tcp = t.udpOverTcp;
      return ss;
    },
    server(ctx) {
      return {
        type: 'shadowsocks',
        tag: `${ctx.tag}-in`,
        listen: '::',
        listen_port: ctx.server.port,
        method: ctx.creds.ssMethod,
        users: [{ name: ctx.profile.user, password: ctx.creds.ssPassword }],
      };
    },
  },

  {
    id: 'naive_h3',
    title: 'NaïveProxy · HTTP/3 + proof-of-work',
    lineage:
      'NaïveProxy (klzgrad) — browser-accurate HTTP/2/3 client with an anti-QoS proof-of-work scheme; the standard answer when DPI matches Chrome-vs-proxy timing patterns',
    family: FAMILY.TLS_TCP,
    requires: { udp: false, quic: false, mtuFloor: 0, tls: true },
    cost: { rttCostMs: 1, overheadPct: 0.14, cpuLoad: 0.6 },
    affinity: {
      loss: 0.7, // HTTP/3 = QUIC semantics over the TLS path
      shaping: 0.8, // PoW padding is purpose-built against bandwidth shaping
      udp_qos: 0.6,
      dpi_quic: 0.9,
      dpi_sni: 0.55,
      active_probe: 0.85,
      tcp_only: 1.0,
      cpu: 0.35,
    },
    perf: ['quic_cc', 'receive_windows', 'insecure_concurrency'],
    build(ctx, t) {
      const naive = {
        type: 'naive',
        tag: ctx.tag,
        server: ctx.server.address,
        server_port: ctx.server.port,
        username: ctx.creds.naiveUser,
        password: ctx.creds.naivePassword,
        tls: t.tls,
        ...t.dial,
      };
      if (t.naiveQuic) {
        naive.quic = true;
        // HTTP/3 in Naïve speaks its own CC vocabulary: bbr | bbr2 | cubic | reno.
        naive.quic_congestion_control = { bbr: 'bbr', bbr2: 'bbr2', cubic: 'cubic', new_reno: 'reno' }[t.congestionControl] ?? 'bbr';
        // No connection-level window knob here, only per-stream and per-session ones.
        if (t.streamReceiveWindow) naive.stream_receive_window = t.streamReceiveWindow;
        if (t.connectionReceiveWindow) naive.quic_session_receive_window = t.connectionReceiveWindow;
      }
      return naive;
    },
    server() {
      return null; // Naïve server is not a sing-box listener; documented as interop-only
    },
  },

  {
    id: 'vless_ws_cdn',
    title: 'VLESS · WebSocket/TLS behind a CDN',
    lineage:
      'v2rayNG/Hiddify classic — looks like a websocket app over TLS and can be fronted by Cloudflare; slow, but it is the rung that survives when an operator blocks whole IP ranges or every unusual port',
    family: FAMILY.TLS_TCP,
    requires: { udp: false, quic: false, mtuFloor: 0, tls: true, fronting: true },
    cost: { rttCostMs: 1, overheadPct: 0.16, cpuLoad: 0.5 },
    affinity: {
      loss: 0.4,
      shaping: 0.5,
      udp_qos: 1.0,
      dpi_quic: 1.0,
      dpi_sni: 0.6,
      active_probe: 0.6,
      tcp_only: 1.0,
      cdn: 1.0,
      ip_blocked: 1.0, // fronting hides the origin IP
    },
    perf: ['mux', 'ws_early_data', 'record_fragment', 'fragment'],
    build(ctx, t) {
      const out = {
        type: 'vless',
        tag: ctx.tag,
        server: ctx.server.address,
        server_port: ctx.server.port,
        uuid: ctx.creds.uuid,
        network: 'tcp',
        transport: {
          type: 'ws',
          path: ctx.server.wsPath,
          max_early_data: t.earlyDataBytes,
          early_data_header_name: 'Sec-WebSocket-Protocol',
          ...(ctx.server.wsHost ? { headers: { Host: ctx.server.wsHost } } : {}),
        },
        tls: t.tls,
        ...t.dial,
      };
      return out;
    },
    server(ctx) {
      return {
        type: 'vless',
        tag: `${ctx.tag}-in`,
        listen: '::',
        listen_port: ctx.server.port,
        users: [{ name: ctx.profile.user, uuid: ctx.creds.uuid }],
        transport: { type: 'ws', path: ctx.server.wsPath },
        tls: { enabled: true, certificate_path: ctx.paths.cert, key_path: ctx.paths.key },
      };
    },
  },

  {
    id: 'vmess_ws',
    title: 'VMess · WebSocket (legacy interop)',
    lineage: 'VMess (v2ray) — kept only so existing savak servers and v2rayNG-style imports keep working',
    family: FAMILY.TLS_TCP,
    requires: { udp: false, quic: false, mtuFloor: 0, legacy: true },
    cost: { rttCostMs: 1, overheadPct: 0.15, cpuLoad: 0.55 },
    affinity: {
      loss: 0.4,
      shaping: 0.4,
      udp_qos: 1.0,
      dpi_quic: 1.0,
      dpi_sni: 0.5,
      active_probe: 0.5, // VMess is vulnerable to replay/probe tricks; also malleable padding
      tcp_only: 1.0,
      cdn: 0.8,
    },
    perf: ['mux', 'global_padding'],
    build(ctx, t) {
      const out = {
        type: 'vmess',
        tag: ctx.tag,
        server: ctx.server.address,
        server_port: ctx.server.port,
        uuid: ctx.creds.uuid,
        security: 'auto',
        alter_id: 0,
        network: 'tcp',
        transport: { type: 'ws', path: ctx.server.wsPath },
        tls: t.tls,
        ...t.dial,
      };
      if (t.globalPadding) out.global_padding = true;
      return out;
    },
    server(ctx) {
      return {
        type: 'vmess',
        tag: `${ctx.tag}-in`,
        listen: '::',
        listen_port: ctx.server.port,
        users: [{ name: ctx.profile.user, uuid: ctx.creds.uuid }],
        transport: { type: 'ws', path: ctx.server.wsPath },
        tls: { enabled: true, certificate_path: ctx.paths.cert, key_path: ctx.paths.key },
      };
    },
  },

  {
    id: 'tor_bridge',
    title: 'Tor bridge · obfs4 (resistance mode)',
    lineage:
      'Tor — never "fast", but the rung that still works when the censor has fingerprinted and blocked every commercial-grade protocol; selectable, never auto-preferred by the speed policy',
    family: FAMILY.RELAY,
    requires: { udp: false, quic: false, mtuFloor: 0, tor: true, resistanceOnly: true },
    cost: { rttCostMs: 900, overheadPct: 0.4, cpuLoad: 0.7 },
    affinity: {
      loss: 0.6,
      shaping: 0.9,
      udp_qos: 1.0,
      dpi_quic: 1.0,
      dpi_sni: 1.0,
      active_probe: 1.0,
      tcp_only: 1.0,
      ip_blocked: 0.9,
    },
    perf: [],
    build(ctx, t) {
      return {
        type: 'tor',
        tag: ctx.tag,
        data_directory: ctx.paths.torData,
        executable_path: ctx.client.capabilities.torExecutable,
        ...(ctx.creds.torRc ? { torrc: ctx.creds.torRc } : {}),
        ...t.dial,
      };
    },
    server() {
      return null;
    },
  },
];

export const RUNG_BY_ID = Object.freeze(RUNGS.reduce((acc, r) => ((acc[r.id] = r), acc), {}));

/**
 * Which rungs a policy mode is willing to consider at all.
 * `speed`  → cut the slow-by-design rungs, so the phone does not waste radio time probing them.
 * `stealth`→ drop the naked-UDP rungs whose DPI signature is well known.
 * `resist` → everything, including Tor.
 */
const MODE_ALLOW = Object.freeze({
  speed: ['hy2_brutal', 'tuic_v5', 'wg_uot', 'vless_reality_tcp', 'anytls', 'ss2022', 'naive_h3'],
  stealth: ['vless_reality_tcp', 'vless_reality_grpc', 'hy2_brutal', 'anytls', 'naive_h3', 'vless_ws_cdn'],
  game: ['wg_uot', 'tuic_v5', 'hy2_brutal', 'vless_reality_tcp', 'ss2022'],
  resist: RUNGS.map((r) => r.id),
  auto: RUNGS.filter((r) => r.id !== 'tor_bridge').map((r) => r.id),
});

/**
 * Which rungs a policy mode is willing to consider at all.
 * `only` is a hard narrowing (an operator shipping a two-rung bundle for a cheap plan):
 * it must reach config assembly too, otherwise the selector still contains every rung and
 * the phone can be steered onto something the operator meant to remove.
 */
export function allowedRungsFor(mode = 'auto', opts = {}) {
  const base = MODE_ALLOW[mode] ?? MODE_ALLOW.auto;
  let allow = new Set(base);
  if (opts.only?.length) {
    const wanted = new Set(opts.only);
    const unknown = opts.only.filter((id) => !RUNG_BY_ID[id]);
    if (unknown.length) throw new Error(`unknown rung id(s): ${unknown.join(', ')} — refusing to build a ladder from a typo`);
    allow = new Set([...allow].filter((id) => wanted.has(id)));
  }
  let out = RUNGS.filter((r) => allow.has(r.id));
  // `allowLegacy` is opt-in: VMess/WS is only there for old servers.
  if (!opts.allowLegacy) out = out.filter((r) => r.id !== 'vmess_ws');
  return out;
}

/** Bandwidth estimate the rung needs for pacing-based CC (0 = unknown → let BBR guess). */
export function pacingBandwidth(link, policy) {
  if (!link?.measured) return { upMbps: 0, downMbps: 0 };
  const headroom = clamp(1 - (policy.pacingHeadroomPct ?? 0.12), 0.5, 0.98);
  const up = Math.round((link.upMbps ?? 0) * headroom);
  const down = Math.round((link.downMbps ?? 0) * headroom);
  // BRUTAL is a *pacing* algorithm: overestimating causes self-inflicted loss, so
  // only trust the measurement when the probe actually sampled sustained throughput.
  return {
    upMbps: up >= 5 ? up : 0,
    downMbps: down >= 5 ? down : 0,
  };
}

/** Where a rung attaches: a normal outbound, or a standalone interface endpoint. */
export function carrierOf(rungId) {
  return RUNG_BY_ID[rungId]?.carrier ?? 'outbound';
}
