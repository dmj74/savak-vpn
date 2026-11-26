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
# Compiled: engine/ (scoring, ladder table, bundle model), security/ (Ed25519 + canonical
# JSON), service/ (VPN lifecycle, backends, TUN bridge), BootReceiver, the two runners in
# tools/, and MainActivity.kt.
#
# The UI file used to be excluded with the reasoning "Compose needs ~40 androidx symbols;
# stubbing them would assert nothing". That was wrong in the part that mattered: the stubs are
# thin, but the *other side* of every one of those calls is code in this repo — a renamed
# `BundleHolder.stage` parameter, a `R.string` that res-check cannot see through, a
# `TunnelPrefs` method the ViewModel invented. Reading that boundary is not a check; this is.
# What it still cannot prove is androidx's own signatures (no Compose plugin, no runtime jars),
# so a misread of *their* API passes here and fails in Gradle — stated in every stub header.
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

# MainActivity needs kotlinx-coroutines (StateFlow/CoroutineScope) for real: stubbing a
# concurrency library would be the one way to make this leg lie about the thing it exists to
# check. It is located beside the compiler rather than stubbed — and it is nearly always
# *there*: `unzip -p kotlin-compiler.jar META-INF/MANIFEST.MF` lists
# `Class-Path: … kotlinx-coroutines-core-jvm.jar`, so a kotlinc that runs at all resolves it.
# The skip branch below is for wrappers that resolve it elsewhere; it reports, never drops.
SRC=(
  "$MOD"/app/src/main/java/ir/savak/client/engine/*.kt
  "$MOD"/app/src/main/java/ir/savak/client/security/*.kt
  "$MOD"/app/src/main/java/ir/savak/client/service/*.kt
  "$MOD"/app/src/main/java/ir/savak/client/BootReceiver.kt
  "$TOOLS"/ParityMain.kt
  "$TOOLS"/ProfileCheckMain.kt
)

coroutines_jar() {
  # Every probe is guarded: `set -euo pipefail` turns a failing `$(…)` substitution into an
  # abort, which would look like a broken app instead of a missing toolchain.
  local bases=() cand found
  [ -n "${KOTLIN_COMPILER_JAR:-}" ] && bases+=("$(dirname "$KOTLIN_COMPILER_JAR")")
  if command -v kotlinc >/dev/null 2>&1; then
    local real; real=$(readlink -f "$(command -v kotlinc)" 2>/dev/null || true)
    [ -n "$real" ] && bases+=("$(dirname "$real")" "$(dirname "$(dirname "$real")")/lib")
  fi
  for base in "${bases[@]}"; do
    for cand in "$base" "$base/../lib" "$base/../../lib"; do
      [ -d "$cand" ] || continue
      found=$(find "$cand" -maxdepth 1 -name 'kotlinx-coroutines-core-jvm*.jar' 2>/dev/null | head -1 || true)
      if [ -n "$found" ]; then printf '%s\n' "$found"; return 0; fi
    done
  done
  return 0
}

CPARGS=()
UI_LEG=0
jar=$(coroutines_jar)
if [ -n "$jar" ]; then
  CPARGS=(-classpath "$jar")
  UI_LEG=1
  SRC+=("$MOD"/app/src/main/java/ir/savak/client/MainActivity.kt)
  echo "  · UI leg: MainActivity.kt compiled against $(basename "$jar") + androidx stubs"
else
  echo "  ⚠ kotlinx-coroutines jar not found beside kotlinc — MainActivity.kt NOT compiled this run"
  echo "    (this leg covers engine/security/service only; npm i -g kotlin-compiler ships the jar)"
fi


# The Compose-runtime stub is the one stub that itself needs coroutines (`collectAsState` is an
# extension on StateFlow). Leaving it in when the jar is missing would trade a reported skip for
# a cascade of unresolved references — indistinguishable from a broken app.
STUBSET=()
for f in "$STUBS"/*.kt; do
  # The whole androidx set exists for MainActivity — the activity/compose stubs reference
  # @Composable, so half of them would not compile without the other half.
  if [ -z "$jar" ] && [[ "$(basename "$f")" == AndroidX_* ]]; then continue; fi
  STUBSET+=("$f")
done

# The count includes the UI file when the UI leg is on: a report that says "11 files" while
# compiling 12 would understate the one thing this leg just started covering.
MODULES=$(find "$MOD/app/src/main/java/ir/savak/client/engine" "$MOD/app/src/main/java/ir/savak/client/security" "$MOD/app/src/main/java/ir/savak/client/service" -name '*.kt' | wc -l)
[ "$UI_LEG" = 1 ] && MODULES=$((MODULES + 1))
echo "compiling $MODULES module files (+ BootReceiver, the two runners) and ${#STUBSET[@]} stub files"
kotlinc_bin -nowarn -include-runtime -d "$OUT/savak-check.jar" "${CPARGS[@]}" \
  "${STUBSET[@]}" \
  "${SRC[@]}"

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
