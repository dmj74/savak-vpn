/**
 * sing-box 1.14 config assembly.
 * =============================
 *
 * Two products from the same plan:
 *   • `clientConfig`  — what the Android app runs. Ships the *whole feasible
 *     ladder* inside the config behind a `selector`, so a transport switch is a
 *     control-API call (no restart, no dropped sockets) rather than a reconnect.
 *   • `serverConfig`  — what a node runs: every rung's listener, so any client
 *     can ladder up or down without the operator re-provisioning.
 *
 * Everything emitted here is checked against the vendored official schema in
 * test/schema.test.js — if a key is wrong, the build fails instead of silently
 * producing a config that sing-box refuses to start with.
 */

import { RUNG_BY_ID, FAMILY, carrierOf } from './ladder.js';
import { ANYTLS_PADDING } from './tune.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const SEL = 'savak-ladder';
const DIRECT = 'savak-direct';
const BLOCK = 'savak-block';

/** Domains that (still) need help — kept inline so a profile works with no downloads. */
export const DEFAULT_EVASION_DOMAINS = Object.freeze([
  'youtube.com',
  'googlevideo.com',
  'github.com',
  'githubusercontent.com',
  'instagram.com',
  'cdninstagram.com',
  'telegram.org',
  't.me',
  'twitter.com',
  'x.com',
  'netflix.com',
  'openai.com',
  'wikipedia.org',
]);

/** Domestic ranges that must NOT be tunnelled (faster + avoids needless egress). */
export const DEFAULT_DIRECT_DOMAINS = Object.freeze(['ac.ir', 'ir', 'shabako.ir', 'bankmellat.ir', 'sled.ir', 'tms123.ir']);

/**
 * Per-destination evasion table. This is where "smart" actually lives: the
 * transform is paid for only on the destinations that need it, instead of
 * globally (which taxes every connection in the tunnel).
 */
export function evasionRouteRules({ client, policy, link }) {
  const rules = [];
  const domains = policy.evasionDomains ?? DEFAULT_EVASION_DOMAINS;
  if (!domains.length) return rules;

  const needsHelp = link.sniFiltered || policy.mode === 'stealth' || policy.mode === 'resist';
  if (!needsHelp) return rules;

  // Route rules have no `tag` field (sing-box does not label rules in 1.14).
  const opts = { action: 'route-options', rule_set: 'savak-evasion-domains' };
  if (client.capabilities?.packetInjection && policy.sniWhitelist?.length) {
    opts.tls_spoof = policy.sniWhitelist[0];
    opts.tls_spoof_method = 'wrong-sequence';
  } else {
    opts.tls_record_fragment = true;
  }
  if (link.plaintextMatch) {
    opts.tls_fragment = true;
    opts.tls_fragment_fallback_delay = link.access === 'cellular' ? '900ms' : '500ms';
  }
  rules.push(opts);
  return rules;
}

export function evasionRuleSets(domains = DEFAULT_EVASION_DOMAINS) {
  return [
    {
      type: 'inline',
      tag: 'savak-evasion-domains',
      // HeadlessRule "default" items carry the matchers directly (no `payload`, no `type`).
      rules: [{ domain_suffix: [...domains] }],
    },
  ];
}

/* ------------------------------------------------------------------ *
 * DNS — the cheapest latency you can buy
 * ------------------------------------------------------------------ */

export function dnsBlock({ policy, client, link, fakeIp }) {
  const servers = [
    { tag: 'savak-local', type: 'local' },
    {
      tag: 'savak-tunnel',
      type: 'https',
      server: policy.dohServer ?? 'dns.google',
      path: policy.dohPath ?? '/dns-query',
      detour: SEL,
      domain_resolver: { server: 'savak-local' },
      tcp_fast_open: true,
    },
  ];
  if (fakeIp) {
    servers.unshift({
      tag: 'savak-fakeip',
      type: 'fakeip',
      inet4_range: policy.fakeIpV4Range ?? '198.18.0.0/15',
      inet6_range: policy.fakeIpV6Range ?? 'fc00::/18',
    });
  }
  const rules = [
    { action: 'route', server: 'savak-local', rule_set: 'savak-domestic', disable_cache: false },
    { action: 'reject', query_type: ['HTTPS'] }, // don't let clients chase SVCB through the tunnel twice
  ];
  if (fakeIp) rules.push({ action: 'route', server: 'savak-fakeip', query_type: ['A', 'AAAA'] });
  return {
    servers,
    rules,
    final: 'savak-tunnel',
    strategy: link.ipv6Flaky ? 'ipv4_only' : 'prefer_ipv4',
    // Optimistic answers return the previous record immediately while revalidating in the
    // background: on a phone that wakes the radio every few minutes, this removes a full
    // DNS round-trip from the "first tap after unlock".
    optimistic: policy.dnsOptimistic !== false,
    cache_capacity: clamp(policy.dnsCacheCapacity ?? 4096, 256, 65536),
    timeout: policy.dnsTimeout ?? (link.access === 'cellular' ? '2s' : '1.5s'),
  };
}

/* ------------------------------------------------------------------ *
 * Inbound (capture)
 * ------------------------------------------------------------------ */

export function tunInbound({ client, policy, link, mtu }) {
  const tun = {
    type: 'tun',
    tag: 'savak-tun',
    address: [client.ipv4 ?? '172.19.0.1/30', client.ipv6 ?? 'fdfe:dcba:9876::1/126'],
    auto_route: true,
    strict_route: client.platform === 'android' ? false : true,
    mtu: mtu ?? (link.access === 'cellular' ? 1280 : 1420),
    // 'system' keeps TCP in the kernel: no userspace copy per segment. gVisor only
    // wins for exotic UDP shapes, so it is a choice, not a default.
    stack: policy.stack ?? 'mixed',
    dns_mode: 'hijack',
    dns_address: [client.dnsAddress ?? '172.19.0.2'],
    // Endpoint-independent mapping/filtering is what makes P2P, VoIP and game NAT
    // traversal work at all through a tunnel; it costs nothing when UDP is not used.
    udp_mapping: 'endpoint_independent',
    udp_filtering: 'endpoint_independent',
    udp_nat_max: policy.udpNatMax ?? 3584,
  };
  if (policy.excludePackages?.length) tun.exclude_package = policy.excludePackages;
  if (policy.includePackages?.length) tun.include_package = policy.includePackages;
  if (policy.proxyAppsOnly) tun.route_exclude_address = ['198.18.0.0/15'];
  if (client.platform === 'android' && policy.systemHttpProxy) {
    // Browsers/YouTube on Android obey a system HTTP proxy: for pure-TCP apps that is
    // strictly cheaper than a TUN (no IP encapsulation, no per-packet routing decisions).
    tun.platform = {
      http_proxy: {
        enabled: true,
        server: '127.0.0.1',
        server_port: policy.httpProxyPort ?? 20120,
        bypass_domain: ['+.local', '*.ir', '192.168.0.0/16', '10.0.0.0/8'],
      },
    };
  }
  if (policy.mtuFromPath && link.mtuCap) tun.mtu = clamp(link.mtuCap, 1280, 1460);
  if (link.excludeMptcp !== true) tun.exclude_mptcp = false;
  return tun;
}

export function localProxyInbound(policy) {
  // Used by hotspot sharing / desktop: a mixed SOCKS+HTTP listener instead of a TUN.
  return {
    type: 'mixed',
    tag: 'savak-local',
    listen: '::',
    listen_port: policy.localProxyPort ?? 20121,
    set_system_proxy: false,
    udp_over_tcp: { enabled: true, version: 2 },
  };
}

/* ------------------------------------------------------------------ *
 * Routing
 * ------------------------------------------------------------------ */

export function routeBlock({ policy, client, link, useBond, fakeIp, final }) {
  const rules = [];
  rules.push({ action: 'sniff', sniffer: ['http', 'tls', 'quic'], timeout: link.access === 'cellular' ? '1.5s' : '1s' });
  rules.push({ action: 'route', outbound: DIRECT, inbound: 'savak-local' });
  rules.push({ action: 'route', outbound: DIRECT, ip_is_private: true });
  rules.push({ action: 'route', outbound: DIRECT, rule_set: 'savak-domestic' });
  if (policy.blockAds !== false) rules.push({ action: 'route', outbound: BLOCK, protocol: ['bittorrent'] });
  rules.push(...evasionRouteRules({ client, policy, link }));
  if (policy.splitUdpForGame && link.access === 'cellular') {
    // Voice/video latency is better served by an unfragmented path than by padding.
    rules.push({ action: 'route-options', port: [5004, 5005], udp_connect: false });
  }
  return {
    rules,
    final,
    auto_detect_interface: true,
    default_domain_resolver: { server: 'savak-local' },
    // Route-level defaults apply to every dial, which is what we want for a ladder:
    // per-outbound copies would each need the same fields and drift apart.
    ...(useBond ? { default_network_strategy: 'hybrid', default_network_type: ['wifi', 'cellular'], default_fallback_delay: '250ms' } : {}),
    rule_set: [
      {
        type: 'inline',
        tag: 'savak-domestic',
        rules: [{ domain_suffix: [...(policy.directDomains ?? DEFAULT_DIRECT_DOMAINS)] }],
      },
      ...evasionRuleSets(policy.evasionDomains),
    ],
    find_process: false,
  };
}

/* ------------------------------------------------------------------ *
 * clientConfig
 * ------------------------------------------------------------------ */

/**
 * @param {object} p
 * @param {object} p.profile      decoded savak profile (servers + credentials)
 * @param {object} p.node         selected server object from the profile
 * @param {object} p.client       device capabilities
 * @param {object} p.policy       resolved policy
 * @param {object} p.link         link characteristics
 * @param {object} p.ladder       [{rungId, feasible, tuning, outbound}]
 * @param {string} p.chosen       rung tag id to connect
 * @param {object} [p.mtu]
 */
export function clientConfig({ profile, node, client, policy, link, ladder, chosen, mtu }) {
  const feasible = ladder.filter((r) => r.feasible);
  if (!feasible.length) throw new Error('ladder-empty: nothing is feasible on this link');
  // Only outbound-carrier rungs can be members of a selector; endpoints (WireGuard)
  // replace the whole capture strategy and are handled by endpointClientConfig().
  const selectable = feasible.filter((r) => carrierOf(r.rungId ?? r.id) === 'outbound');
  if (chosen && carrierOf(String(chosen).replace(/^savak-/, '')) === 'endpoint') {
    return endpointClientConfig({ profile, node, client, policy, link, rung: feasible.find((r) => r.tag === chosen) ?? feasible[0], mtu });
  }
  if (!selectable.length) {
    return endpointClientConfig({ profile, node, client, policy, link, rung: feasible[0], mtu });
  }
  const outbounds = selectable.map((r) => r.outbound);
  const tags = selectable.map((r) => r.outbound.tag);
  const chosenTag = tags.includes(chosen) ? chosen : tags[0];

  const fakeIp = policy.fakeIp !== false && !policy.proxyAppsOnly;
  const useBond = feasible.some((r) => r.tuning?.dial?.network_strategy === 'hybrid') || policy.bondInterfaces === true;

  const config = {
    // Log level matters for throughput on a mid-range phone: every line is a lock + a
    // write() on the same cores doing the crypto.
    log: { level: policy.logLevel ?? (policy.mode === 'speed' ? 'error' : 'warning'), timestamp: false },
    dns: dnsBlock({ policy, client, link, fakeIp }),
    inbounds: [policy.capture === 'proxy' ? localProxyInbound(policy) : tunInbound({ client, policy, link, mtu })],
    outbounds: [
      ...outbounds,
      {
        type: 'selector',
        tag: SEL,
        default: chosenTag,
        outbounds: tags,
        interrupt_exist_connections: policy.switchMode === 'hard' ? true : false,
      },
      { type: 'direct', tag: DIRECT },
      { type: 'block', tag: BLOCK },
    ],
    route: routeBlock({ policy, client, link, useBond, fakeIp, final: SEL }),
    experimental: {
      cache_file: {
        enabled: true,
        path: policy.cacheFile ?? (client.platform === 'android' ? 'cache/savak.db' : 'cache/savak.db'),
        store_dns: true,
        ...(fakeIp ? { store_fakeip: true } : {}),
        cache_id: `${profile.profileId}:${node.id}`,
      },
    },
  };

  const wg = selectable.find((r) => r.endpoint);
  if (wg) config.endpoints = [wg.endpoint];

  if (policy.raceInterval && feasible.length > 1) {
    config.outbounds.unshift({
      type: 'urltest',
      tag: 'savak-race',
      url: policy.raceUrl ?? 'https://www.gstatic.com/generate_204',
      interval: policy.raceInterval,
      tolerance: policy.raceToleranceMs ?? 25,
      outbounds: tags,
      idle_timeout: policy.raceIdleTimeout ?? '30m',
    });
  }

  if (policy.controlApi) {
    config.services = [
      {
        type: 'api',
        listen: policy.controlApiListen ?? '127.0.0.1:20123',
        ...(policy.controlApiSecret ? { secret: policy.controlApiSecret } : {}),
      },
    ];
  }
  if (policy.capture === 'both') config.inbounds.push(localProxyInbound(policy));
  return config;
}

/* ------------------------------------------------------------------ *
 * WireGuard wins → interface mode
 * ------------------------------------------------------------------ */

/**
 * When the raw-UDP rung wins there is no sing-box tunnel to multiplex over: the
 * WireGuard *endpoint* owns the interface, so the config collapses to
 * "one endpoint + a direct route". That is why the ladder charges WG for losing
 * split-tunnelling and per-domain evasion — on a phone with a shaped link,
 * 1420-byte kernel crypto usually beats those losses, but not always, and the
 * tradeoff is scored instead of assumed.
 */
export function endpointClientConfig({ profile, node, client, policy, link, rung, mtu }) {
  const endpoint = rung?.endpoint ?? rung;
  return {
    log: { level: policy.logLevel ?? 'warning', timestamp: false },
    dns: {
      // DNS rides inside the tunnel (allowed_ips covers 0/0), so the system resolver
      // is enough here and adds no round-trip of its own.
      servers: [{ tag: 'savak-local', type: 'local' }],
      final: 'savak-local',
      strategy: link.ipv6Flaky ? 'ipv4_only' : 'prefer_ipv4',
      optimistic: true,
    },
    endpoints: [
      {
        ...endpoint,
        system: false,
        name: client.tunName ?? 'savak0',
      },
    ],
    outbounds: [{ type: 'direct', tag: DIRECT }],
    route: { rules: [{ action: 'route', outbound: DIRECT, ip_is_private: true }], final: DIRECT },
    experimental: {
      cache_file: { enabled: true, path: policy.cacheFile ?? 'cache/savak.db', store_dns: true, cache_id: `${profile.profileId}:${node.id}:wg` },
    },
  };
}

/* ------------------------------------------------------------------ *
 * serverConfig — every rung listening at once
 * ------------------------------------------------------------------ */

const RUNG_PORT_KEY = {
  hy2_brutal: 'hy2',
  tuic_v5: 'tuic',
  vless_reality_tcp: 'reality',
  vless_reality_grpc: 'realityGrpc',
  anytls: 'anytls',
  ss2022: 'ss',
  wg_uot: 'wg',
  naive_h3: 'naive',
  vless_ws_cdn: 'ws',
  vmess_ws: 'ws',
};

export function serverConfig({ profile, node, server, creds, policy, ladder, options = {} }) {
  const inbounds = [];
  const endpoints = [];
  const paths = options.paths ?? { cert: '/var/lib/savak/tls.crt', key: '/var/lib/savak/tls.key', state: '/var/lib/savak' };
  for (const rung of ladder) {
    if (!rung.feasible) continue;
    if (rung.id === 'wg_uot') {
      endpoints.push({
        type: 'wireguard',
        tag: 'savak-wg',
        // Endpoint objects have no `listen` field — only `listen_port`.
        listen_port: node.ports?.wg ?? 16000,
        private_key: creds.wg.serverPrivateKey,
        mtu: options.mtu ?? 1420,
        system: true, // kernel data path: the whole reason WG is the fast rung
        workers: options.workers,
        peers: [
          {
            public_key: creds.wg.clientPublicKey,
            // On the server side the peer dials us, so there is no endpoint address to pin;
            // `allowed_ips` is what authorises this peer's tunnel addresses.
            allowed_ips: [options.clientIp ?? '10.66.66.2/32'],
            ...(options.reserved ? { reserved: options.reserved } : {}),
          },
        ],
      });
      continue;
    }
    const portKey = RUNG_PORT_KEY[rung.id];
    const port = node.ports?.[portKey] ?? node.ports?.[rung.id] ?? node.port;
    const ctx = {
      tag: `savak-${rung.id}`,
      server: { ...node, port, masquerade: options.masqueradeUrl, realityDest: node.realityDest, serviceName: node.serviceName, grpcIdleTimeout: '10s', grpcPingTimeout: '45s', wsPath: node.wsPath ?? '/', wsHost: node.wsHost },
      creds,
      profile: { user: profile.user ?? 'savak-user' },
      paths,
    };
    const built = rung.rung.server?.(ctx, rung.tuning);
    if (built) {
      // Server listeners must not carry client-side dial fields.
      for (const k of ['tcp_fast_open', 'tcp_multi_path', 'network_strategy', 'network_type', 'connect_timeout', 'domain_resolver', 'fallback_delay', 'detour', 'udp_fragment', 'tcp_keep_alive', 'tcp_keep_alive_interval']) {
        delete built[k];
      }
      if (built.multiplex && !built.multiplex.brutal?.up_mbps) delete built.multiplex;
      inbounds.push(built);
    }
  }

  const hy2 = inbounds.find((i) => i.type === 'hysteria2');
  if (hy2 && options.masqueradeUrl) {
    // Anything that is not a valid Hysteria session gets proxied to a real site,
    // so an active prober sees a website and not a closed port.
    // 1.14 accepts a URL string (reverse proxy) or {type:"file",directory}.
    hy2.masquerade = { type: 'proxy', url: options.masqueradeUrl };
  }
  if (hy2 && options.hysteriaBandwidth?.downMbps) {
    hy2.down_mbps = options.hysteriaBandwidth.downMbps;
    hy2.up_mbps = options.hysteriaBandwidth.upMbps;
    hy2.ignore_client_bandwidth = false;
  }
  const anytlsIn = inbounds.find((i) => i.type === 'anytls');
  if (anytlsIn) anytlsIn.padding_scheme = ANYTLS_PADDING;
  const realityIn = inbounds.find((i) => i.type === 'vless' && i.tls?.reality?.enabled);
  if (realityIn) realityIn.tls.reality.handshake.server = options.realityDest?.host ?? 'www.google.com';

  return {
    log: { level: options.logLevel ?? 'info', timestamp: true },
    dns: { servers: [{ tag: 'local', type: 'local' }], final: 'local', strategy: 'prefer_ipv4' },
    inbounds,
    ...(endpoints.length ? { endpoints } : {}),
    outbounds: [
      { type: 'direct', tag: 'direct' },
      { type: 'block', tag: 'block' },
    ],
    route: {
      rules: [
        { action: 'sniff', sniffer: ['tls', 'http', 'quic'] },
        { action: 'route', outbound: 'block', domain_suffix: ['censys.io', 'shodan.io', 'binaryedge.com'] },
      ],
      final: 'direct',
      auto_detect_interface: false,
    },
    ...(options.certificateProvider
      ? {
          certificate_providers: [
            {
              type: 'acme',
              domain: options.hostname ? [options.hostname] : [],
              data_directory: `${options.paths?.state ?? '/var/lib/savak'}/certmagic`,
              ...(options.acmeEmail ? { email: options.acmeEmail } : {}),
              disable_http_challenge: false,
              disable_tls_alpn_challenge: false,
            },
          ],
        }
      : {}),
    services: [
      {
        type: 'api',
        listen: options.apiListen ?? '127.0.0.1:20124',
        ...(options.apiSecret ? { secret: options.apiSecret } : {}),
      },
    ],
    experimental: { cache_file: { enabled: true, path: `${options.paths?.state ?? '/var/lib/savak'}/cache.db`, store_dns: true } },
  };
}

export { SEL, DIRECT, BLOCK, FAMILY };
