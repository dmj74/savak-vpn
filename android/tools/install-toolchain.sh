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
#   bash android/tools/install-toolchain.sh docker     # راهنمای مسیر داکر (بدون نصب روی میزبان)
#   bash android/tools/install-toolchain.sh --self-test  # آیا verify_sha واقعاً رد می‌کند؟
# چه چیزی از این محیط قابل اجرا نبود و باید صادقانه گفته شود: مسیرهای دانلود (Gradle/SDK/Go)
# اینجا مسدودند، پس سه تابع install_* روی شبکهٔ واقعی تست نشده‌اند — به‌ویژه آنجا که checksum
# ابزارک‌های Android را از repository2-3.xml می‌خواند. چیزی که اینجا اجرا و تأیید شده خودِ
# verify_sha است (--self-test: مقدار درست قبول، دست‌کاری‌شده رد، نبودِ checksum خطا) و منطق
# انتخاب/خطاها در --check.
#   PREFIX=/opt/savak bash android/tools/install-toolchain.sh
#
# چرا این‌جا: بیلد APK به چیزهایی نیاز دارد که از داخل محیطِ نوشتنِ این کد قابل گرفتن نیستند.
# چیزی که واقعاً مانع است، سطح دسترسی به میزبان است — نه نبودِ ابزار: پنج میزبانِ لازم
#   dl.google.com · maven.google.com · repo1.maven.org · services.gradle.org · go.dev
# handshakeٔ TLS‌شان می‌میرد (اندازه‌گیری‌شده، هم‌زمان با باز بودنِ github.com/api.github.com/
# codeload/npmjs/pypi که همه 200 می‌دهند):
#   curl: (35) OpenSSL SSL_connect: SSL_ERROR_SYSCALL in connection to dl.google.com:443
# پس این اسکریپت همان «تمام موارد لازم» را روی دستگاه شما نصب می‌کند و در پایان savak-debug.apk
# را تحویل می‌دهد. دو نکته که جست‌وجویشان وقتِ بازبینی را می‌گیرد (دو بار اندازه‌گیری شده):
#   - d8 در npm هست ولی به‌درد نمی‌خورد: d8-termux یک «d8.jar» می‌فرستد که jar نیست — سه فایل
#     classes*.dex است برای dalvikvm ترموکس؛ روی JVM معمولی: ClassNotFoundException.
#   - امضای APK خالص‌نویسی‌شدنی است (apk_sign_ts: v1/v2/v3 با node-forge/jks-js/pako) ولی بدون
#     dex بی‌مصرف است. و android.jar هم از GitHubِ افرادِ ناشناس پیدا می‌شود؛ برای یک VPN،
#     stubs/dexer که یک غریبه تعیین کرده یعنی او کد داخل APK را تعیین کرده — خط قرمز.
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

# ── checksums: one place, one behaviour ─────────────────────────────────────────────────────
# Every download in this script goes through verify_sha before it is unpacked. "pinned URL"
# without a checksum is a download, not a supply chain — and this repo pins libbox to a tag
# plus a sha256 for exactly that reason.
verify_sha() {   # verify_sha FILE ALGO EXPECTED_HEX
  local f=$1 algo=$2 want=$3 got
  [ -f "$f" ] || { bad "$f وجود ندارد"; return 1; }
  case "$algo" in
    sha256) got=$(sha256sum "$f" | cut -d' ' -f1) ;;
    sha1)   got=$(sha1sum "$f" | cut -d' ' -f1) ;;
    *) bad "الگوریتم $algo را نمی‌شناسم"; return 2 ;;
  esac
  want=$(printf '%s' "$want" | tr 'A-F' 'a-f' | tr -cd '0-9a-f')
  if [ -z "$want" ]; then
    bad "checksum انتظاری به دست نیامد — بیلد را ادامه نمی‌دهم (اگر میزبانِ checksum ساختارش را عوض کرده، پرچم SAVAK_SKIP_CHECKSUM=1 را صریح ست کنید)"
    return 1
  fi
  if [ "$got" != "$want" ]; then bad "checksum نمی‌خواند: $got ≠ $want"; return 1; fi
  good "checksum OK — $algo $got"
}

self_test() {
  say "خودآزمونِ verify_sha (اینجا اجرا می‌شود، نه فقط نوشته)"
  local d; d=$(mktemp -d); printf 'savak\n' > "$d/f"
  local good_sha; good_sha=$(sha256sum "$d/f" | cut -d' ' -f1)
  verify_sha "$d/f" sha256 "$good_sha"            || { say "  ✗ باید قبول می‌کرد"; exit 1; }
  if verify_sha "$d/f" sha256 "0000$good_sha" 2>/dev/null; then say "  ✗ باید رد می‌کرد"; exit 1; fi
  say "  ✓ مقدار درست accepted، مقدار دست‌کاری‌شده rejected"
  if verify_sha "$d/f" sha256 "" 2>/dev/null; then say "  ✗ فقدان checksum باید خطا باشد"; exit 1; fi
  say "  ✓ نبودِ checksum خطاست، نه «skip»"
  rm -rf "$d"
  say "self-test OK"
}

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
  # aapt2: a genuine Android tool, packaged on PyPI (the wheel forgets the exec bit).
  if [ -z "${AAPT2:-}" ]; then
    AAPT2=$(command -v aapt2 2>/dev/null || true)
    [ -n "$AAPT2" ] || AAPT2=$(ls "$HOME"/.local/lib/python3*/site-packages/aapt2/bin/Linux/aapt2 2>/dev/null | head -1 || true)
  fi
  if [ -n "${AAPT2:-}" ] && [ -x "${AAPT2:-}" ]; then good "aapt2: $("$AAPT2" version 2>&1 | head -1)"; else
    say "  · aapt2 (اختیاری، برای اعتبار res/): pip install --user aapt2 && chmod +x ~/.local/lib/python3*/site-packages/aapt2/bin/Linux/aapt2"
  fi
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
    say "  با میزبان‌های بسته، بیلد کامل APK شدنی نیست. چیزی که از PyPI/npm می‌آید و مفید است:"
    say "    npm i kotlin-compiler        → کامپایل Kotlin (چک‌های منطقی همین‌جا اجرا می‌شود)"
    say "    pip i jdk4py                 → JRE (javac ندارد؛ برای typecheck بس است)"
    say "    pip i aapt2                  → aapt2 واقعی، برای اعتبار سنجی res/ (این اسکریپت"
    say "                                   خودش پیدایش می‌کند؛ chmod +x لازم دارد)"
    say "  و این‌ها بدون آن پنج میزبان درنمی‌آیند (maven.google.com/Central/services.gradle.org/"
    say "  dl.google.com/go.dev — TLS‌شان همین‌جا قطع می‌شود): artifact‌های androidx Compose و"
    say "  AGP، android.jar قابل‌اتکا، d8 واقعی، و Go+NDK برای libbox — یعنی همان هستهٔ تانل."
    say "  «APK» بدون آن‌ها اپی است که ترافیک را محافظت نمی‌کند ولی وانمود می‌کند می‌کند؛"
    say "  آن را نمی‌سازیم."
    say ""
    say "  درست‌ترین کار همان CI است (کامیت با یک دستور، بدون clone):"
    say "    gh api -X PUT repos/<owner>/<repo>/contents/.github/workflows/apk-only.yml \\"
    say "      -f message='ci: enable the debug-APK build' -f branch=main \\"
    say '      -f content="$(base64 -w0 ci/apk-only.yml)"   # یا ci/android-apk.yml برای همهٔ چک‌ها'
    say '    (با احراز هویت خودتان — اپ Arena روی pathٔ .github/workflows/* مجاز نیست: 403)' 
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
  local zip="$PREFIX/gradle-$GRADLE_VERSION-bin.zip" dist="gradle-$GRADLE_VERSION-bin.zip"
  curl -fL --retry 3 -o "$zip" "https://services.gradle.org/distributions/$dist"
  # Gradle publishes the sha256 next to the distribution; fetch it, verify, THEN unpack.
  # (The first version of this function hashed a filename it had already deleted, and the
  # empty-result guard turned that into a silent pass. A check that checks nothing is worse
  # than no check, because it is trusted.)
  if [ "${SAVAK_SKIP_CHECKSUM:-0}" != 1 ]; then
    verify_sha "$zip" sha256 "$(curl -fsSL "https://services.gradle.org/distributions/$dist.sha256" | tr -cd '0-9a-fA-F')" || return 1
  fi
  ( cd "$PREFIX" && unzip -q -o "gradle-$GRADLE_VERSION-bin.zip" && rm -f "gradle-$GRADLE_VERSION-bin.zip" )
  [ -x "$TOOLS/bin/gradle" ] || { bad "چیزی در $TOOLS/bin/gradle نیست — zip را دستی چک کنید"; return 1; }
  good "Gradle $("$TOOLS/bin/gradle" --version 2>/dev/null | awk '/^Gradle/{print $2}')"
}

install_android() {
  local latest="commandlinetools-linux-${CMDLINE_TOOLS}_latest.zip"
  if [ ! -x "$SDK/cmdline-tools/latest/bin/sdkmanager" ]; then
    say "→ Android command-line tools ($CMDLINE_TOOLS)"
    mkdir -p "$SDK/cmdline-tools" "$PREFIX"
    local zip="$PREFIX/cmdline.zip" want=""
    curl -fL --retry 3 -o "$zip" "https://dl.google.com/android/repository/$latest"
    if [ "${SAVAK_SKIP_CHECKSUM:-0}" != 1 ]; then
      # Google publishes the checksum of every repository file inside repository2-3.xml. Split
      # the document on </archive>, keep the block that names OUR file, take its sha1. (There is
      # no per-file .sha1 URL for these, unlike Gradle — so a parse is the only option, and if
      # Google's layout changes the honest answer is "refuse", not "assume".)
      want=$(curl -fsSL "https://dl.google.com/android/repository/repository2-3.xml" \
        | awk -v RS='</archive>' -v f="$latest" 'index($0,f) && match($0,/<checksum type="sha1">[0-9a-f]+</) { s=substr($0,RSTART,RLENGTH); gsub(/[^0-9a-f]/,"",s); print s; exit }')
      if [ -z "$want" ]; then
        bad "checksum $latest از repository2-3.xml بیرون نیامد — یا ساختار XML عوض شده یا دانلود نیمه‌کاره است"
        say "  ادامه نمی‌دهیم: دانلودِ تأییدنشده نصب نمی‌شود."
        say "  اگر فایل را خودتان از منبع دیگری راستی‌آزمایی کرده‌اید، صریح بگویید:"
        say "      SAVAK_SKIP_CHECKSUM=1 bash android/tools/install-toolchain.sh"
        rm -f "$zip"; return 1
      fi
      verify_sha "$zip" sha1 "$want" || { rm -f "$zip"; return 1; }
    fi
    ( cd "$SDK/cmdline-tools" && unzip -q -o "$zip" && rm -f "$zip" \
      && { [ -d cmdline-tools ] && mv cmdline-tools latest || true; } )
  fi
  [ -x "$SDK/cmdline-tools/latest/bin/sdkmanager" ] || { bad "sdkmanager نصب نشد"; return 1; }
  export ANDROID_HOME="$SDK" ANDROID_SDK_ROOT="$SDK"
  say "→ پکیج‌های SDK — platforms;android-35 build-tools;35.0.0 ndk;27.0.12077973 platform-tools"
  yes | "$SDK/cmdline-tools/latest/bin/sdkmanager" --licenses >/dev/null 2>&1 || true
  "$SDK/cmdline-tools/latest/bin/sdkmanager" "platforms;android-35" "build-tools;35.0.0" "ndk;27.0.12077973" "platform-tools"
  good "sdkmanager: $(ls "$SDK/platforms" 2>/dev/null | tr '\n' ' ')"
  [ -x "$SDK/build-tools/35.0.0/aapt2" ] && good "aapt2 از SDK: $("$SDK/build-tools/35.0.0/aapt2" version 2>&1 | head -1)" \
    || bad "aapt2 در build-tools/35.0.0 پیدا نشد (بدون آن هیچ APK‌ای ساخته نمی‌شود)"
}

install_go() {
  if command -v go >/dev/null 2>&1; then good "Go $(go env GOVERSION | sed 's/^go//')"; return; fi
  say "→ Go"
  local ver pkg zip want=""
  ver=$(curl -fsSL "https://go.dev/VERSION?m=text" | head -1)      # not a guessed patch number
  [ -n "$ver" ] || { bad "نسخهٔ پایدار Go از go.dev/VERSION نگرفت شد"; return 1; }
  pkg="${ver}.linux-amd64.tar.gz"
  zip="$PREFIX/go.tgz"
  mkdir -p "$PREFIX"
  curl -fL --retry 3 -o "$zip" "https://go.dev/dl/$pkg"
  if [ "${SAVAK_SKIP_CHECKSUM:-0}" != 1 ]; then
    # go.dev/dl/?mode=json carries the sha256 of every published archive — parseable, no guessing.
    want=$(curl -fsSL "https://go.dev/dl/?mode=json" | python3 -c "
import json, sys
want = sys.argv[1]
for rel in json.load(sys.stdin):
    for f in rel.get('files', []):
        if f.get('filename') == want and f.get('os') == 'linux' and f.get('arch') == 'amd64':
            print(f.get('sha256', '')); raise SystemExit
" "$pkg" 2>/dev/null || true)
    verify_sha "$zip" sha256 "$want" || { rm -f "$zip"; return 1; }
  fi
  rm -rf "$PREFIX/go" && ( cd "$PREFIX" && tar xzf "$zip" && rm -f "$zip" )
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
if [ "$MODE" = "self-test" ] || [ "$MODE" = "--self-test" ]; then self_test; exit 0; fi
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
