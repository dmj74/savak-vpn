#!/usr/bin/env bash
#
# savak node bootstrap — provisioning for ONE rung-complete node.
#
# What this does:
#   1. checks the kernel really can do what the ladder assumes (BBR, and Brutal if asked for)
#   2. generates a full credential set with the engine (no `sing-box generate …` needed)
#   3. writes /etc/savak/{profile.json,server.json} from the same code path the CLI uses,
#      so a node cannot be configured with a key the client-side schema would reject
#   4. installs sysctl tuning that the speed claims actually depend on (window sizes,
#      qdisc, conntrack) — a config file alone cannot fix a 212 KB default socket buffer
#   5. installs the systemd unit + the measurement responder the app's probes talk to
#
# Default is DRY RUN: nothing is written outside $STATE_DIR until you pass --apply.
#
set -euo pipefail

STATE_DIR=${STATE_DIR:-/etc/savak}
RUN_DIR=${RUN_DIR:-/var/lib/savak}
BIN_DIR=${BIN_DIR:-/usr/local/bin}
SINGBOX_VERSION=${SINGBOX_VERSION:-1.14.4}
GITHUB_BASE=${GITHUB_BASE:-https://github.com/SagerNet/sing-box/releases/download}
APPLY=0
WITH_BRUTAL=0
HOSTNAME_ARG=""
NODE_ID="fra-1"
MASQUERADE="https://www.google.com"
ENGINE="${ENGINE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../engine" && pwd)}"

say() { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!!\033[0m %s\n' "$*" >&2; }
need() { command -v "$1" >/dev/null 2>&1 || { warn "missing dependency: $1"; exit 3; }; }

# accept both --flag value and --flag=value so it behaves like every other tool
args=("$@")
i=0
while [ $i -lt ${#args[@]} ]; do
  arg="${args[$i]}"
  case "$arg" in
    --apply) APPLY=1 ;;
    --with-brutal|--brutal) WITH_BRUTAL=1 ;;
    --hostname) i=$((i+1)); HOSTNAME_ARG="${args[$i]}" ;;
    --hostname=*) HOSTNAME_ARG="${arg#*=}" ;;
    --node) i=$((i+1)); NODE_ID="${args[$i]}" ;;
    --node=*) NODE_ID="${arg#*=}" ;;
    --state-dir) i=$((i+1)); STATE_DIR="${args[$i]}" ;;
    --state-dir=*) STATE_DIR="${arg#*=}" ;;
    --email) i=$((i+1)); SAVAK_EMAIL="${args[$i]}" ;;
    --help | -h)
      sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) warn "unknown argument: $arg (see --help)"; exit 2 ;;
  esac
  i=$((i+1))
done

need node
need curl
need tar
need openssl
node -e 'import("node:crypto").then(m=>process.exit(m.generateKeyPairSync?"x25519"==="x25519"?0:0:1))' >/dev/null 2>&1 || true

# ---------------------------------------------------------------- kernel reality
kernel_ok() {
  local major minor
  major=$(uname -r | cut -d. -f1)
  minor=$(uname -r | cut -d. -f2)
  [ "$major" -gt 5 ] || { [ "$major" -eq 5 ] && [ "$minor" -ge 7 ]; }
}

available_cc() {
  # The ladder only claims pacing/BBR behaviour if the kernel offers it.
  local cc
  cc=$(cat /proc/sys/net/ipv4/tcp_available_congestion_control 2>/dev/null || echo "")
  printf '%s' "$cc"
}

# ------------------------------------------------------------------- preflight
preflight() {
  say "preflight"
  local cc; cc=$(available_cc)
  if [[ "$cc" == *bbr* ]]; then
    say "BBR available: $cc"
  else
    warn "no bbr in tcp_available_congestion_control ($cc) — BBR profiles will not engage; the ladder will still fall back to cubic"
  fi
  if [[ "$cc" == *brutal* ]]; then
    say "tcp-brutal module loaded (BRUTAL-over-TLS via multiplex.brutal is usable)"
  else
    warn "tcp-brutal not loaded — multiplex.brutal is dropped from generated configs; Hysteria2 BRUTAL (userspace) still works"
  fi
  if kernel_ok; then
    say "kernel $(uname -r) ≥ 5.7 (kTLS TX, SO_TXTIME, fq pacing)"
  else
    warn "kernel $(uname -r) is old: kTLS TX is not enabled by the engine automatically"
  fi
  if [ "$(id -u)" != "0" ] && [ "$APPLY" = 1 ]; then
    warn "--apply needs root"; exit 3
  fi
}

# ------------------------------------------------------------------- downloads
install_singbox() {
  local target="$BIN_DIR/sing-box"
  if [ -x "$target" ] && "$target" version 2>/dev/null | grep -q "sing-box version $SINGBOX_VERSION"; then
    say "sing-box $SINGBOX_VERSION already installed"
    return
  fi
  local arch pkg
  case "$(uname -m)" in
    x86_64) arch=amd64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) warn "unsupported arch $(uname -m)"; exit 3 ;;
  esac
  pkg="sing-box-${SINGBOX_VERSION}-linux-${arch}.tar.gz"
  say "fetching $pkg"
  if [ "$APPLY" = 1 ]; then
    local tmp; tmp=$(mktemp -d)
    curl -fL --retry 3 -o "$tmp/$pkg" "$GITHUB_BASE/v$SINGBOX_VERSION/$pkg"
    tar -xzf "$tmp/$pkg" -C "$tmp"
    install -m 0755 "$tmp/sing-box-${SINGBOX_VERSION}-linux-${arch}/sing-box" "$target"
    rm -rf "$tmp"
    "$target" version
  else
    say "would download $GITHUB_BASE/v$SINGBOX_VERSION/$pkg → $target"
    say "(in Iran this usually needs a proxy: GITHUB_BASE=https://ghproxy.net/https://github.com/SagerNet/sing-box/releases/download ./bootstrap.sh …)"
  fi
}

install_brutal_module() {
  [ "$WITH_BRUTAL" = 1 ] || return 0
  say "tcp-brutal kernel module (enables multiplex.brutal: TCP Brutal for the TLS rungs)"
  if [ "$APPLY" = 1 ]; then
    apt-get update -qq && apt-get install -y --no-install-recommends dkms build-essential linux-headers-$(uname -r)
    if [ ! -d /usr/src/tcp-brutal-1.0.0 ]; then
      git clone https://github.com/apernet/tcp-brutal /opt/tcp-brutal
      cp -r /opt/tcp-brutal/dkms /usr/src/tcp-brutal-1.0.0
      dkms add -m tcp-brutal -v 1.0.0 || true
      dkms build -m tcp-brutal -v 1.0.0 || true
      dkms install -m tcp-brutal -v 1.0.0 || true
    fi
    modprobe tcp_brutal || warn "module built but not loadable; multiplex.brutal stays off"
  else
    say "would install the apetern/tcp-brutal DKMS module"
  fi
}

# ------------------------------------------------------------------- key material
# The engine does all of it: X25519 for Reality/WireGuard, SS-2022 key material, the
# per-protocol secrets, the profile signature, and a schema-validated server.json.
# Doing this in shell is how nodes end up with a truncated base64 key at 3am.
gen_node() {
  say "generating credentials + profile + server config via the engine"
  local args=(src/cli.js init --node "$NODE_ID" --hostname "${HOSTNAME_ARG:-$(hostname -f 2>/dev/null || echo node.local)}" --outDir "$STATE_DIR")
  [ -n "$HOSTNAME_ARG" ] || HOSTNAME_ARG=$(hostname -f 2>/dev/null || echo node.local)
  # The claim and the config must agree: only advertise tcpBrutal when the module is
  # actually loaded, otherwise the engine would ship a multiplex.brutal that cannot work.
  if [ "$WITH_BRUTAL" = 1 ] && [[ "$(available_cc)" == *brutal* ]]; then
    args+=(--brutal)
  elif [ "$WITH_BRUTAL" = 1 ]; then
    warn "--with-brutal requested but tcp_brutal is not loaded yet — leaving multiplex.brutal off for this run"
  fi
  [ -n "${SAVAK_EMAIL:-}" ] && args+=(--email "$SAVAK_EMAIL")
  if [ "$APPLY" = 1 ]; then
    install -d -m 0750 "$STATE_DIR" "$RUN_DIR"
    (cd "$ENGINE" && node "${args[@]}")
    [ -f "$STATE_DIR/tls.crt" ] || {
      say "no certificate yet — self-signed ECDSA P-256 so QUIC starts before ACME lands"
      openssl req -x509 -newkey ec:<(openssl ecparam -name prime256v1) -keyout "$STATE_DIR/tls.key" \
        -out "$STATE_DIR/tls.crt" -days 825 -nodes -subj "/CN=${HOSTNAME_ARG}" \
        -addext "subjectAltName=DNS:${HOSTNAME_ARG}" 2>/dev/null
      chmod 600 "$STATE_DIR/tls.key"
      # The engine pins the SPKI for self-signed QUIC rungs; never tls.insecure.
      node --input-type=module -e "
        import { readFile, writeFile } from 'node:fs/promises';
        import { execSync } from 'node:child_process';
        import { spkiPin } from '$ENGINE/src/keys.js';
        const pub = execSync('openssl x509 -in $STATE_DIR/tls.crt -pubkey -noout', {encoding:'utf8'});
        const p = JSON.parse(await readFile('$STATE_DIR/profile.json','utf8'));
        p.servers[0].pinnedKeySha256 = spkiPin(pub);
        await writeFile('$STATE_DIR/profile.json', JSON.stringify(p, null, 2) + String.fromCharCode(10));
        console.log('pinned SPKI ' + p.servers[0].pinnedKeySha256);
      "
    }
    (cd "$ENGINE" && node src/cli.js bundle --profile "$STATE_DIR/profile.json" --node "$NODE_ID" --out "$STATE_DIR/bundle.json")
    install -m 0644 "$SCRIPT_DIR/sysctl-savak.conf" /etc/sysctl.d/90-savak.conf
    sysctl --system >/dev/null
    say "sysctl: cc=$(cat /proc/sys/net/ipv4/tcp_congestion_control 2>/dev/null) rmem_max=$(cat /proc/sys/net/core/rmem_max 2>/dev/null)"
  else
    say "would run: node ${args[*]}"
    say "would then: sign+bundle the profile, install 90-savak.conf, apply sysctl"
  fi
}

write_service() {
  say "systemd unit + measurement responder"
  local unit="[Unit]
Description=savak smart-evasion node (all ladder rungs)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$BIN_DIR/sing-box run -c $STATE_DIR/server.json -D $RUN_DIR
Restart=on-failure
RestartSec=2
CapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_RAW CAP_NET_BIND_SERVICE CAP_SYS_NICE
AmbientCapabilities=CAP_NET_ADMIN CAP_NET_RAW CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$RUN_DIR $STATE_DIR
PrivateTmp=true
LimitNOFILE=1048576
Nice=-5

[Install]
WantedBy=multi-user.target
"
  local probe="[Unit]
Description=savak measurement responder (UDP echo + throughput sink for client probes)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$ENGINE
ExecStart=$NODE_BIN $ENGINE/src/probe-service.js
Environment=SAVAK_PROBE_UDP=20125
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
DynamicUser=true
LimitNOFILE=262144
Restart=on-failure

[Install]
WantedBy=multi-user.target
"
  if [ "$APPLY" = 1 ]; then
    printf '%s\n' "$unit" > /etc/systemd/system/savak.service
    printf '%s\n' "$probe" > /etc/systemd/system/savak-probe.service
    systemctl daemon-reload
    systemctl enable --now savak-probe.service savak.service
    say "started: $(systemctl is-active savak.service) / probe: $(systemctl is-active savak-probe.service)"
  else
    printf '%s\n' "$unit"
    printf -- '----\n'
    printf '%s\n' "$probe"
  fi
}

open_ports() {
  say "firewall"
  if [ "$APPLY" = 1 ] && command -v ufw >/dev/null; then
    for p in 443/udp 443/tcp 2053/tcp 2054/tcp 8443/udp 8444/tcp 8445/tcp 16000/udp 2087/tcp 20125/udp 20126/tcp; do ufw allow "$p" >/dev/null; done
    say "ufw rules added"
  else
    say "would allow 443/udp 443/tcp 2053-2054/tcp 8443/udp 8444-8445/tcp 16000/udp 2087/tcp 20125/udp 20126/tcp"
  fi
}

verify_node() {
  say "self-check: the node's own config against the official schema"
  if [ "$APPLY" = 1 ]; then
    (cd "$ENGINE" && node src/cli.js validate "$STATE_DIR/server.json")
    say "client-side bundle for distribution:"
    say "  scp $STATE_DIR/bundle.json you@phone:   # or serve it and let the app import it"
    say "  bundle signing key (keep it!): $STATE_DIR/keys.json"
  else
    say "would run: node src/cli.js validate $STATE_DIR/server.json"
  fi
}

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
NODE_BIN=$(command -v node)
preflight
install_singbox
install_brutal_module
gen_node
write_service
open_ports
verify_node

if [ "$APPLY" != 1 ]; then
  say "DRY RUN — nothing was changed. Re-run with --apply on the node itself."
fi
