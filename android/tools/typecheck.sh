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
  echo "── 1/3  resource / manifest / gradle cross-check ──"
  python3 "$TOOLS/res-check.py"
else
  echo "── 1/3  resource cross-check skipped (no python3) ──"
fi

echo "── 2/3  scoring parity (device port vs engine) ──"
"$JAVA" -cp "$OUT/savak-check.jar" ir.savak.client.tools.ParityMainKt "$FIXTURE"

echo "── 3/3  profile trust (canonical JSON + Ed25519 vs engine) ──"
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
