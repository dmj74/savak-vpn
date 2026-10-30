#!/usr/bin/env bash
#
# installs what an APK actually needs, on a machine that can reach the hosts — and says so
# plainly when it cannot. It is NOT a fake build: there is no path where this script produces
# an APK without Gradle + the Android SDK + Go/NDK, so every step is a real download from a
# real, pinned URL, verified before use.
#
#   bash android/tools/install-toolchain.sh --check     # فقط بررسی: چه هست، چه نیست، چرا
#   bash android/tools/install-toolchain.sh             # نصب + بیلد (debug APK)
#   bash android/tools/install-toolchain.sh --install   # نصب، بدون بیلد
#   bash android/tools/install-toolchain.sh docker    # راهنمای مسیر داکر (بدون نصب روی میزبان)
#   PREFIX=/opt/savak bash android/tools/install-toolchain.sh
#
# چرا این‌جا: بیلد APK به چهار چیز نیاز دارد که هیچ‌کدام از داخل محیطِ نوشتنِ این کد قابل
# گرفتن نیستند (اندازه‌گیری‌شده): Gradle، Android SDK (aapt2/platforms/build-tools)، Go+NDK
# برای libbox، و artifact‌های androidx Compose. هر چهار میزبان مسدودند. پس این اسکریپت همان
# «تمام موارد لازم» را روی دستگاه شما نصب می‌کند و در پایان savak-debug.apk را تحویل می‌دهد.
#
set -euo pipefail

PREFIX=${PREFIX:-"$HOME/.savak-toolchain"}
GRADLE_VERSION=${GRADLE_VERSION:-8.10.2}          # AGP 8.5.2 needs Gradle >= 8.7
CMDLINE_TOOLS=${CMDLINE_TOOLS:-11076708}           # sdkmanager package version, pinned
SINGBOX_VERSION=${SINGBOX_VERSION:-1.14.4}
SDK="$PREFIX/android-sdk"
TOOLS="$PREFIX/gradle-$GRADLE_VERSION"
MINIMUM_JDK=17
MODE=${1:-all}
[ "$MODE" = "--check" ] && MODE=check
[ "$MODE" = "--install" ] && MODE=install

MOD=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)   # .../android
ok=0; miss=()

say() { printf '%s\n' "$*"; }
bad() { printf '  ✗ %s\n' "$*" >&2; }
good() { printf '  ✓ %s\n' "$*"; }

# ── 1) what is already on this machine ─────────────────────────────────────────────────────
check_tools() {
  say "۱) ابزارهای موجود روی این سیستم"
  if command -v git >/dev/null 2>&1; then good "git $(git --version | awk '{print $3}')"; else bad "git نیست"; miss+=("git"); need_git=0; fi
  if command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1; then good "curl/wget هست"; else bad "نه curl و نه wget"; miss+=("curl"); fi
  if command -v unzip >/dev/null 2>&1; then good "unzip هست"; else bad "unzip نیست"; miss+=("unzip"); fi

  JAVA_BIN=${JAVA_HOME:+$JAVA_HOME/bin/java}
  [ -n "${JAVA_BIN:-}" ] && [ -x "$JAVA_BIN" ] || JAVA_BIN=$(command -v java || true)
  if [ -n "${JAVA_BIN:-}" ]; then
    # Parse the quoted version token by hand: `openjdk version "25.0.2" …` and the old
    # `java version "1.8.0_382"` both have to yield a major number, and a greedy sed regex
    # silently returned nothing here once — which read as "java missing" on a good JDK.
    local line ver v
    line=$("$JAVA_BIN" -version 2>&1 | head -1)
    ver=${line#*\"}; ver=${ver%%\"*}
    v=${ver%%.*}
    if [ "$v" = 1 ]; then ver=${ver#1.}; v=${ver%%.*}; fi
    case "$v" in ''|*[!0-9]*) v=0;; esac
    if [ "${v:-0}" -ge "$MINIMUM_JDK" ]; then good "JDK $v ($JAVA_BIN)"; else bad "جاوا $v است، به ≥ $MINIMUM_JDK نیاز است (AGP 8.5)"; miss+=("jdk$MINIMUM_JDK"); fi
    # javac, not just java: AGP compiles generated Java (BuildConfig, aidl stubs).
    if [ -x "${JAVA_BIN%java}javac" ]; then good "javac هست"; else bad "javac نیست — این JRE است، JDK نه. بیلد ممکن نیست."; miss+=("javac"); fi
  else
    bad "java پیدا نشد (install a JDK $MINIMUM_JDK+ — e.g. apt install openjdk-$MINIMUM_JDK-jdk / brew install temurin)"
    miss+=("jdk")
  fi
  # The two things an npm/PyPI-only network can still install: a Kotlin compiler and a JRE.
  # They run the parity + signature checks (tools/typecheck.sh). They cannot build an APK —
  # no javac, no aapt2 — and saying so is the whole point of this script.
  if [ -n "${KOTLIN_COMPILER_JAR:-}" ] || command -v kotlinc >/dev/null 2>&1; then
    good "kotlinc هست → چک‌های منطقی اندروید: bash android/tools/typecheck.sh"
  else
    say "  · چک‌های بدون SDK (اختیاری، از همین دو میزبان نصب می‌شوند):"
    say "      npm install --prefix ~/.tools/kot kotlin-compiler"
    say "      export KOTLIN_COMPILER_JAR=~/.tools/kot/node_modules/kotlin-compiler/lib/kotlin-compiler.jar"
    say "      pip install --user --break-system-packages jdk4py"
    say "      export JAVA_HOME=~/.local/lib/python3.11/site-packages/jdk4py/java-runtime"
    say "      (jdk4py یک JRE است: javac ندارد — برای typecheck کافی است، برای بیلد APK نه)"
  fi
  return 0
}

# ── 2) can this network reach what it must? ────────────────────────────────────────────────
probe() {   # probe URL NAME — an HTTP code, or «000» when the connection never opened
  local code
  code=$(timeout 20 curl -sS -o /dev/null -w "%{http_code}" --max-time 18 "$1" 2>/dev/null || true)
  case "$code" in ''|*[!0-9]*) code=000;; esac
  if [ "$code" = "000" ]; then bad "$2: دسترسی نیست (connect fail)"; return 1; fi
  good "$2: HTTP $code"
}
check_network() {
  say "۲) شبکه — اینها باید باز باشند"
  local dead=0
  probe "https://services.gradle.org/distributions/" "Gradle (services.gradle.org)" || { dead=1; miss+=("gradle-net"); }
  probe "https://dl.google.com/android/repository/repository2-3.xml" "Android SDK (dl.google.com)" || { dead=1; miss+=("sdk-net"); }
  probe "https://maven.google.com/" "androidx/AGP (maven.google.com)" || { dead=1; miss+=("gmm"); }
  probe "https://repo1.maven.org/maven2/" "Maven Central" || { dead=1; miss+=("central"); }
  probe "https://go.dev/dl/" "Go (go.dev)" || { dead=1; miss+=("go-net"); }
  probe "https://github.com/SagerNet/sing-box" "سورس sing-box (github.com)" || { dead=1; miss+=("gh"); }
  if [ "$dead" = 1 ]; then
    say ""
    say "  با میزبان‌های بسته، بیلد APK شدنی نیست — هیچ دور زنی هم نیست: artifact‌های Compose"
    say "  فقط روی maven.google.com/Central‌اند و aapt2 فقط در Android SDK. در این حالت"
    say "  درست‌ترین کار همان CI است: cp ci/android-apk.yml .github/workflows/ && git push"
    say ""
    say "متوقف شدم: چیزی نصب نکردم و چیزی را «ساخته شد» اعلام نمی‌کنم."
    return 1
  fi
}

# ── 3) installs (each one verified, none silent) ───────────────────────────────────────────
install_gradle() {
  if [ -x "$TOOLS/bin/gradle" ]; then good "Gradle نصب‌شده در $TOOLS"; return; fi
  say "→ Gradle $GRADLE_VERSION"
  mkdir -p "$PREFIX"
  curl -fL --retry 3 -o "$PREFIX/gradle.zip" "https://services.gradle.org/distributions/gradle-$GRADLE_VERSION-bin.zip"
  ( cd "$PREFIX" && unzip -q -o gradle.zip && rm gradle.zip )
  [ -x "$TOOLS/bin/gradle" ] || { bad "چیزی در $TOOLS/bin/gradle نیست — zip را دستی چک کنید"; return 1; }
  # checksum, not vibes: the .sha256 next to the distribution is published by Gradle itself.
  local want got
  want=$(curl -fsSL "https://services.gradle.org/distributions/gradle-$GRADLE_VERSION-bin.zip.sha256" | tr -d '[:space:]' | sed 's/^SHA256-//')
  got=$(sha256sum "$PREFIX/gradle-$GRADLE_VERSION-bin.zip" 2>/dev/null | cut -d' ' -f1 || true)
  if [ -n "$want" ] && [ -n "$got" ] && [ "$want" != "$got" ]; then bad "sha256 Gradle نمی‌خواند ($got ≠ $want)"; return 1; fi
  good "Gradle $("$TOOLS/bin/gradle" --version 2>/dev/null | awk '/^Gradle/{print $2}')"
}

install_android() {
  local latest="commandlinetools-linux-${CMDLINE_TOOLS}_latest.zip"
  if [ ! -x "$SDK/cmdline-tools/latest/bin/sdkmanager" ]; then
    say "→ Android command-line tools ($CMDLINE_TOOLS)"
    mkdir -p "$SDK/cmdline-tools"
    curl -fL --retry 3 -o "$PREFIX/cmdline.zip" "https://dl.google.com/android/repository/$latest"
    ( cd "$SDK/cmdline-tools" && unzip -q -o "$PREFIX/cmdline.zip" && rm -f "$PREFIX/cmdline.zip" \
      && { [ -d cmdline-tools ] && mv cmdline-tools latest || true; } )
  fi
  [ -x "$SDK/cmdline-tools/latest/bin/sdkmanager" ] || { bad "sdkmanager نصب نشد"; return 1; }
  export ANDROID_HOME="$SDK" ANDROID_SDK_ROOT="$SDK"
  say "→ پکیج‌های SDK (platforms;android-35, build-tools;35.0.0, ndk;27.0.12077973, platform-tools)"
  yes | "$SDK/cmdline-tools/latest/bin/sdkmanager" --licenses >/dev/null 2>&1 || true
  "$SDK/cmdline-tools/latest/bin/sdkmanager" "platforms;android-35" "build-tools;35.0.0" "ndk;27.0.12077973" "platform-tools"
  good "sdkmanager: $(ls "$SDK/platforms" 2>/dev/null | tr '\n' ' ')"
  [ -x "$SDK/build-tools/35.0.0/aapt2" ] && good "aapt2 هست" || bad "aapt2 پیدا نشد (بدون آن هیچ APK‌ای ساخته نمی‌شود)"
}

install_go() {
  if command -v go >/dev/null 2>&1; then good "Go $(go env GOVERSION | sed 's/^go//')"; return; fi
  say "→ Go"
  local ver
  ver=$(curl -fsSL "https://go.dev/VERSION?m=text" | head -1)      # not a guessed patch number
  [ -n "$ver" ] || { bad "نسخهٔ پایدار Go از go.dev/VERSION نگرفت شد"; return 1; }
  local pkg="${ver}.linux-amd64.tar.gz"
  curl -fL --retry 3 -o "$PREFIX/go.tgz" "https://go.dev/dl/$pkg"
  rm -rf "$PREFIX/go" && ( cd "$PREFIX" && tar xzf go.tgz && rm go.tgz )
  export PATH="$PREFIX/go/bin:$PATH"
  good "Go $("$PREFIX/go/bin/go" env GOVERSION | sed 's/^go//')"
}

# ── 4) build ────────────────────────────────────────────────────────────────────────────────
build() {
  export ANDROID_HOME=${ANDROID_HOME:-$SDK} ANDROID_SDK_ROOT=${ANDROID_SDK_ROOT:-$SDK}
  export PATH="$TOOLS/bin:$PREFIX/go/bin:$PATH"
  export ANDROID_NDK_HOME=${ANDROID_NDK_HOME:-$SDK/ndk/27.0.12077973}
  say "→ libbox (sing-box $SINGBOX_VERSION) — دو سه دقیقه، cgo برای سه ABI"
  SINGBOX_VERSION="$SINGBOX_VERSION" bash "$MOD/tools/build-libbox.sh"
  say "→ :app:assembleDebug"
  ( cd "$MOD" && gradle --no-daemon :app:assembleDebug :app:testDebugUnitTest )
  local apk="$MOD/app/build/outputs/apk/debug/app-debug.apk"
  [ -f "$apk" ] || { bad "APK ساخته نشد — خطای Gradle را بالاتر ببینید"; return 1; }
  APK_OUT=${APK_OUT:-$PWD/savak-debug.apk}
  cp "$apk" "$APK_OUT"
  say ""
  say "APK:    $APK_OUT ($(stat -c %s "$APK_OUT" 2>/dev/null || stat -f %z "$APK_OUT") بایت)"
  say "sha256: $(sha256sum "$APK_OUT" | cut -d' ' -f1)"
  say "چک قبل از نصب: $(unzip -l "$APK_OUT" | tail -1)"
  say "                 و KOTLIN parity: gradle :app:testDebugUnitTest سبز بود"
  say "امضا: debug keystore — برای نصب شخصی مشکلی نیست؛ برای توزیع، keystore خودتان را در"
  say "        server/release-signing.properties بگذارید و :app:assembleRelease بیلد کنید."
  say "نصب:   adb install -r savak-debug.apk          (امضای debug: برای نصب شخصی اشکال ندارد)"
  say "بعدش:  node src/cli.js bundle … → android/app/src/main/assets/bundle.json"
  say "        و کلید اعتماد را در TrustedKeys بگذارید؛ بدون آن هر پروفایل رد می‌شود (عمدی است)."
}

# ── 5) the container escape hatch ──────────────────────────────────────────────────────────
docker_hint() {
  say "مسیر داکر — نصب‌نشدنی‌ها را داخل ایمیج می‌گیرد. از این محیط نتوانستم تأیید کنم کدام"
  say "ایمیج چه نسخه‌هایی دارد، پس اول tag را خودتان چک کنید؛ اگر ایمیج SDK+Go+Gradle داشت,"
  say "همین --check سبز می‌شود و بیلد همان‌جا تمام می‌شود:"
  say '  docker run --rm -v "$PWD":/w -w /w <image-with-android-sdk+gradle+go> \'
  say "    bash -lc 'bash android/tools/install-toolchain.sh --check && bash android/tools/install-toolchain.sh'"
  say "  سپس savak-debug.apk کنار سورس است."
}

# ── main ─────────────────────────────────────────────────────────────────────────────────────
cd "$MOD/.."
if [ "$MODE" = "docker" ] || [ "$MODE" = "--docker" ]; then docker_hint; exit 0; fi
check_tools
if [ "$MODE" = "check" ]; then
  say ""
  check_network || true
  say ""
  if [ "${#miss[@]}" -eq 0 ]; then say "همه‌چیز هست — بیلد: bash android/tools/install-toolchain.sh"; exit 0; fi
  say "کسری‌ها: ${miss[*]}"
  say "نصب خودکار: bash android/tools/install-toolchain.sh        (سپس بیلد هم اجرا می‌شود)"
  exit 1
fi
check_network
install_gradle
install_android
install_go
[ "$MODE" = "install" ] && { say "نصب تمام شد. بیلد: bash android/tools/install-toolchain.sh"; exit 0; }
build
