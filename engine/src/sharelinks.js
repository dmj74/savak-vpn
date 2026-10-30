/**
 * Share-link export/import.
 * ========================
 *
 * The point of a ladder is that a savak node stays usable by everybody else's
 * clients: Hiddify, v2rayNG/NGFPC, Shadowrocket, Streisand, SFA, Outline-style
 * apps. So every rung can be serialised to the de-facto URL its own ecosystem
 * uses, and parsed back for import.
 *
 * Formats (as used by those clients, not invented here):
 *   hy2://      <password>@<host>:<port>?insecure=&sni=&alpn=h3&obfs=&obfs-password=&upmbps=&downmbps=&fp=
 *   tuic://     <uuid>:<password>@<host>:<port>?congestion_control=&udp_relay_mode=&sni=&alpn=&allow_insecure=&disable_sni=&reduce_rtt&heartbeat=
 *   vless://    <uuid>@<host>:<port>?encryption=none&security=reality&sni=&pbk=&sid=&fp=&type=tcp&flow=&serviceName=
 *   anytls://   <password>@<host>:<port>?sni=&fp=&insecure=
 *   ss://       <base64url(method:password)>@<host>:<port>#<tag>
 *   trojan://   <password>@<host>:<port>?sni=&allowInsecure=
 *   vmess://    base64(json)
 *   wireguard   an .ini [Interface]+[Peer] (every WG client eats this)
 */

const b64url = (s) => Buffer.from(s, 'utf8').toString('base64url');
const unb64url = (s) => Buffer.from(s, 'base64url').toString('utf8');

function qs(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

export function shareLinkFor(rungId, ctx, tuning = {}) {
  const tls = tuning.tls ?? {};
  const enc = encodeURIComponent;
  const tag = enc(ctx.tag ?? rungId);
  switch (rungId) {
    case 'hy2_brutal': {
      const p = {
        sni: tls.server_name ?? '',
        alpn: (tls.alpn ?? ['h3']).join(','),
        insecure: tls.certificate_public_key_sha256 ? 1 : 0,
        fp: tls.utls?.fingerprint ?? 'chrome',
        obfs: tuning.obfs?.type ?? '',
        'obfs-password': tuning.obfs?.password ?? '',
        upmbps: tuning.bandwidth?.upMbps || '',
        downmbps: tuning.bandwidth?.downMbps || '',
        'recv-window-conn': tuning.streamReceiveWindow ?? '',
        'recv-window': tuning.connectionReceiveWindow ?? '',
        'fast-open': tuning.dial?.tcp_fast_open ? 1 : 0,
        hop: (tuning.hop?.server_ports ?? ctx.server.ports?.hop ?? []).join(','),
      };
      return `hy2://${enc(ctx.creds.hy2Password)}@${ctx.server.address}:${ctx.server.port}${qs(p)}#${tag}`;
    }
    case 'tuic_v5': {
      const p = {
        sni: tls.server_name ?? '',
        alpn: 'h3',
        'congestion_control': tuning.congestionControl ?? 'bbr',
        'udp_relay_mode': tuning.udpRelayMode ?? 'native',
        'allow_insecure': 0,
        'disable_sni': 0,
        'reduce_rtt': tuning.zeroRtt ? 1 : 0,
        heartbeat: tuning.heartbeat ?? '',
      };
      return `tuic://${enc(ctx.creds.tuicUuid)}:${enc(ctx.creds.tuicPassword)}@${ctx.server.address}:${ctx.server.port}${qs(p)}#${tag}`;
    }
    case 'vless_reality_tcp':
    case 'vless_reality_grpc': {
      const p = {
        encryption: 'none',
        security: 'reality',
        sni: tls.server_name ?? ctx.server.realityDest?.host ?? '',
        pbk: ctx.creds.realityPublicKey,
        sid: ctx.creds.realityShortId ?? '',
        fp: tls.utls?.fingerprint ?? 'chrome',
        type: rungId === 'vless_reality_grpc' ? 'grpc' : 'tcp',
        flow: rungId === 'vless_reality_tcp' ? 'xtls-rprx-vision' : '',
        serviceName: rungId === 'vless_reality_grpc' ? ctx.server.serviceName ?? 'svc' : '',
        mode: rungId === 'vless_reality_grpc' ? 'multi' : '',
      };
      return `vless://${ctx.creds.uuid}@${ctx.server.address}:${ctx.server.port}${qs(p)}#${tag}`;
    }
    case 'vless_ws_cdn': {
      const p = {
        encryption: 'none',
        security: tls.enabled ? 'tls' : 'none',
        sni: tls.server_name ?? '',
        type: 'ws',
        path: ctx.server.wsPath ?? '/',
        host: ctx.server.wsHost ?? '',
        fp: tls.utls?.fingerprint ?? 'chrome',
      };
      return `vless://${ctx.creds.uuid}@${ctx.server.address}:${ctx.server.port}${qs(p)}#${tag}`;
    }
    case 'anytls': {
      const p = { sni: tls.server_name ?? '', fp: tls.utls?.fingerprint ?? 'chrome', insecure: 0 };
      return `anytls://${enc(ctx.creds.anytlsPassword)}@${ctx.server.address}:${ctx.server.port}${qs(p)}#${tag}`;
    }
    case 'ss2022': {
      const userinfo = b64url(`${ctx.creds.ssMethod}:${ctx.creds.ssPassword}`);
      return `ss://${userinfo}@${ctx.server.address}:${ctx.server.port}#${tag}`;
    }
    case 'wg_uot':
      return wgConf(ctx, tuning);
    default:
      return null;
  }
}

export function wgConf(ctx, tuning = {}) {
  const a = ctx.creds.wg;
  return [
    '[Interface]',
    `PrivateKey = ${a.clientPrivateKey}`,
    `Address = ${tuning.clientIp ?? '10.66.66.2/32'}`,
    tuning.dns ? `DNS = ${tuning.dns}` : null,
    `MTU = ${tuning.mtu ?? 1420}`,
    '',
    '[Peer]',
    `PublicKey = ${a.serverPublicKey}`,
    a.psk ? `PresharedKey = ${a.psk}` : null,
    `AllowedIPs = 0.0.0.0/0, ::/0`,
    `Endpoint = ${ctx.server.address}:${ctx.server.ports?.wg ?? 51820}`,
    `PersistentKeepalive = ${tuning.keepalive ?? 25}`,
  ]
    .filter((l) => l !== null)
    .join('\n');
}

/** Minimal importer: enough to adopt an existing single-protocol subscription link. */
export function parseShareLink(url) {
  const hash = url.includes('#') ? decodeURIComponent(url.slice(url.indexOf('#') + 1)) : 'imported';
  const withoutFrag = url.slice(0, url.indexOf('#') === -1 ? url.length : url.indexOf('#'));
  const scheme = withoutFrag.slice(0, withoutFrag.indexOf('://'));
  const rest = withoutFrag.slice(withoutFrag.indexOf('://') + 3);
  const [authority, query = ''] = rest.split('?');
  const params = Object.fromEntries(new URLSearchParams(query));

  const splitAuth = (s) => {
    const at = s.lastIndexOf('@');
    if (at === -1) return { user: null, hostport: s };
    return { user: s.slice(0, at), hostport: s.slice(at + 1) };
  };
  const hostport = (s) => {
    const idx = s.lastIndexOf(':');
    return { address: s.slice(0, idx), port: Number(s.slice(idx + 1)) };
  };

  switch (scheme) {
    case 'hy2': {
      const { user, hostport: hp } = splitAuth(authority);
      return { rungId: 'hy2_brutal', tag: hash, server: { ...hostport(hp) }, creds: { hy2Password: decodeURIComponent(user ?? '') }, params };
    }
    case 'tuic': {
      const { user, hostport: hp } = splitAuth(authority);
      const [uuid, password] = (user ?? ':').split(':');
      return { rungId: 'tuic_v5', tag: hash, server: { ...hostport(hp) }, creds: { tuicUuid: uuid, tuicPassword: decodeURIComponent(password ?? '') }, params };
    }
    case 'vless': {
      const { user, hostport: hp } = splitAuth(authority);
      const rungId = params.security === 'reality' ? (params.type === 'grpc' ? 'vless_reality_grpc' : 'vless_reality_tcp') : 'vless_ws_cdn';
      return {
        rungId,
        tag: hash,
        server: { ...hostport(hp) },
        creds: {
          uuid: user,
          realityPublicKey: params.pbk,
          realityShortId: params.sid,
          realityServerName: params.sni,
        },
        params,
      };
    }
    case 'anytls': {
      const { user, hostport: hp } = splitAuth(authority);
      return { rungId: 'anytls', tag: hash, server: { ...hostport(hp) }, creds: { anytlsPassword: decodeURIComponent(user ?? '') }, params };
    }
    case 'ss': {
      const { user, hostport: hp } = splitAuth(authority);
      let method;
      let password;
      try {
        const decoded = unb64url(user.replace(/^\/+/, ''));
        [method, password] = decoded.split(':');
      } catch {
        [method, password] = Buffer.from(user, 'base64').toString('utf8').split(':');
      }
      return { rungId: 'ss2022', tag: hash, server: { ...hostport(hp) }, creds: { ssMethod: method, ssPassword: password }, params };
    }
    default:
      return { rungId: null, tag: hash, unsupported: scheme, params };
  }
}
