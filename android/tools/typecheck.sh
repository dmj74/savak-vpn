#!/usr/bin/env bash
#
# Compiles the Android module's logic with kotlinc alone — no Android SDK, no Gradle, no
# network — and then RUNS the engine↔app parity check on the generated fixture.
#
#   JAVA_HOME=/path/to/jdk kotlinc available?  →  bash android/tools/typecheck.sh
#
# Why: the CI build (ci/android-apk.yml) is the only thing that compiles against the real
# SDK, and it needs a workflow file this repo's agent token may not write. That should not
# mean "the Kotlin is unverified": type errors, wrong member names, and a scorer that
# drifted from engine/src/score.js are all catchable here, in seconds, on any laptop.
#
# Compiled on purpose: engine/ (scoring, ladder table, bundle model), security/ (Ed25519 +
# canonical JSON), service/ (VPN lifecycle + backends), BootReceiver, and the two runners in
# tools/. Deliberately NOT compiled: MainActivity.kt — Compose needs ~40 androidx symbols;
# stubbing them would assert nothing. Gradle/CI covers it.
#
set -euo pipefail

TOOLS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
MOD=$(cd "$TOOLS/.." && pwd)
STUBS="$TOOLS/kotlinc-stubs"
OUT=${OUT:-$(mktemp -d)}
FIXTURE=${FIXTURE:-$MOD/app/src/test/resources/parity/golden.json}

if command -v kotlinc >/dev/null 2>&1; then
  kotlinc_bin() { kotlinc "$@"; }
elif [ -n "${KOTLIN_COMPILER_JAR:-}" ] && [ -n "${JAVA_HOME:-}" ]; then
  kotlinc_bin() { "$JAVA_HOME/bin/java" -cp "$KOTLIN_COMPILER_JAR" org.jetbrains.kotlin.cli.jvm.K2JVMCompiler "$@"; }
else
  echo "need kotlinc on PATH, or KOTLIN_COMPILER_JAR + JAVA_HOME set" >&2
  echo "  (npm i -g kotlin-compiler gives the jar; jdk4py on PyPI gives a JDK with no root)" >&2
  exit 3
fi

echo "compiling $(find "$MOD/app/src/main/java/ir/savak/client/engine" "$MOD/app/src/main/java/ir/savak/client/security" "$MOD/app/src/main/java/ir/savak/client/service" -name '*.kt' | wc -l) module files + stubs"
kotlinc_bin -nowarn -include-runtime -d "$OUT/savak-check.jar" \
  "$STUBS"/*.kt \
  "$MOD"/app/src/main/java/ir/savak/client/engine/*.kt \
  "$MOD"/app/src/main/java/ir/savak/client/security/*.kt \
  "$MOD"/app/src/main/java/ir/savak/client/service/*.kt \
  "$MOD"/app/src/main/java/ir/savak/client/BootReceiver.kt \
  "$TOOLS"/ParityMain.kt \
  "$TOOLS"/ProfileCheckMain.kt

JAVA=${JAVA:-java}
[ -n "${JAVA_HOME:-}" ] && JAVA="$JAVA_HOME/bin/java"

# Leg 1 needs no JVM at all, and it runs first because a missing resource is the cheapest
# thing on this list to fix.
if command -v python3 >/dev/null 2>&1; then
  echo "── 1/4  resource / manifest / gradle cross-check ──"
  python3 "$TOOLS/res-check.py"
else
  echo "── 1/4  resource cross-check skipped (no python3) ──"
fi

# A real Android tool, from a package registry: `pip install aapt2` ships the Linux binary
# (without the exec bit). It validates resource XML the same way Gradle's aapt2 step does.
# What it cannot do here is `link` — that needs a framework android.jar, and pulling one from
# some stranger's repo as an input to a VPN build is not a shortcut worth taking.
AAPT2=${AAPT2:-$(command -v aapt2 || true)}
if [ -z "$AAPT2" ] && command -v python3 >/dev/null 2>&1; then
  AAPT2=$(python3 - <<'PYQ' 2>/dev/null || true
import os, sysconfig
for base in {sysconfig.get_paths()["purelib"], os.path.expanduser("~/.local/lib")}:
    pass
import glob
cands = glob.glob(os.path.expanduser("~/.local/lib/python3*/site-packages/aapt2/bin/Linux/aapt2")) + \
        glob.glob("/usr/lib/python3*/site-packages/aapt2/bin/Linux/aapt2") + \
        glob.glob("/usr/local/lib/python3*/site-packages/aapt2/bin/Linux/aapt2")
print(cands[0] if cands else "")
PYQ
)
fi
echo "── 2/4  aapt2 resource compile ──"
if [ -n "$AAPT2" ]; then
  [ -x "$AAPT2" ] || chmod +x "$AAPT2" 2>/dev/null || true
  tmp=$(mktemp -d); bad=0
  for f in $(find "$MOD/app/src/main/res" -name '*.xml' | sort); do
    if ! out=$("$AAPT2" compile "$f" -o "$tmp" 2>&1); then
      bad=$((bad+1)); printf '  ✗ %s\n%s\n' "${f#$MOD/}" "$out" >&2
    fi
  done
  n=$(find "$MOD/app/src/main/res" -name '*.xml' | wc -l)
  if [ "$bad" = 0 ]; then
    echo "  ✓ $("$AAPT2" version 2>&1 | head -1) — $n resource file(s) compiled"
  else
    echo "aapt2 compile FAILED on $bad file(s)" >&2; exit 1
  fi
  rm -rf "$tmp"
else
  echo "  skipped — no aapt2 (get one with: pip install --user aapt2)" >&2
fi

echo "── 3/4  scoring parity (device port vs engine) ──"
"$JAVA" -cp "$OUT/savak-check.jar" ir.savak.client.tools.ParityMainKt "$FIXTURE"

echo "── 4/4  profile trust (canonical JSON + Ed25519 vs engine) ──"
ENGINE=${ENGINE:-$(cd "$MOD/../engine" && pwd)}
PROFILES=${PROFILE_DIR:-$OUT/init}
if command -v node >/dev/null 2>&1 && [ -f "$ENGINE/src/cli.js" ]; then
  (cd "$ENGINE" && node src/cli.js init --hostname check.example.net --node chk-1 --outDir "$PROFILES" >/dev/null)
  KEY_ID=$(node -e 'const j=require(process.argv[1]);console.log(j.profileSigning.keyId)' "$PROFILES/keys.json")
  PUB=$(node -e 'const j=require(process.argv[1]).profileSigning;console.log(j.publicKeyB64 ?? j.publicKey)' "$PROFILES/keys.json")
  "$JAVA" -cp "$OUT/savak-check.jar" ir.savak.client.tools.ProfileCheckMainKt "$PROFILES/profile.json" "$KEY_ID" "$PUB"
else
  echo "skipped: node or engine/src/cli.js not found (parity above still ran)" >&2
fi
