#!/usr/bin/env bash
#
# Builds sing-box's mobile binding (libbox) as a Maven-installed AAR so Gradle can consume
# it, and prints the sha256 — because an unpublished binary that the app silently links is
# how a VPN ends up shipping a different core than the one that was reviewed.
#
#   ./tools/build-libbox.sh                 # → android/third_party/maven (gitignored)
#   SINGBOX_VERSION=1.14.4 ./tools/build-libbox.sh
#
# Needs: go ≥ 1.23, Android NDK r27 + SDK 35 (ANDROID_HOME/ANDROID_NDK_HOME or ANDROID_NDK).
# CI does this in .github/workflows/android-apk.yml; locally, Android Studio's SDK manager
# can install both.
#
set -euo pipefail

SINGBOX_VERSION=${SINGBOX_VERSION:-1.14.4}
GOMOBILE_PKG=${GOMOBILE_PKG:-golang.org/x/mobile/cmd/gomobile@latest}
JAVAPKG=${JAVAPKG:-org.savak.core}
ANDROIDAPI=${ANDROIDAPI:-26}
REPO_DIR=${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/third_party/maven}
WORK=${WORK:-/tmp/savak-libbox-build}
GROUP=org.savak.core
ARTIFACT=libbox

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing dependency: $1" >&2; exit 3; }; }
need go
need git

if [ -z "${ANDROID_NDK_HOME:-}" ] && [ -z "${ANDROID_NDK:-}" ]; then
  for c in "$ANDROID_HOME/ndk"/* "$HOME/Android/Sdk/ndk"/*; do
    [ -d "$c" ] && export ANDROID_NDK_HOME="$c"
  done
fi
[ -n "${ANDROID_NDK_HOME:-}${ANDROID_NDK:-}" ] || { echo "no Android NDK found (install ndk;27.* via sdkmanager, or set ANDROID_NDK_HOME)" >&2; exit 3; }
echo "NDK: ${ANDROID_NDK_HOME:-$ANDROID_NDK}"

SRC=$WORK/sing-box-$SINGBOX_VERSION
if [ ! -d "$SRC/experimental/libbox" ]; then
  mkdir -p "$WORK"
  # A pinned tag, not a branch: the config the engine emits is validated against 1.14.4's
  # schema, so the core on the device must be the same version or that guarantee is a lie.
  git clone --depth 1 --branch "v$SINGBOX_VERSION" https://github.com/SagerNet/sing-box "$SRC"
fi

cd "$SRC"
echo "gomobile bind (this compiles the whole Go core for 3 ABIs — a few minutes)"
export GOFLAGS=-buildvcs=false
go install "$GOMOBILE_PKG"
export PATH="$PATH:$(go env GOPATH)/bin"
gomobile init >/dev/null
mkdir -p "$WORK/out"
gomobile bind -target=android -androidapi "$ANDROIDAPI" -javapkg "$JAVAPKG" \
  -o "$WORK/out/$ARTIFACT.aar" \
  github.com/sagernet/sing-box/experimental/libbox

# ---- install into a plain maven repo layout (aar + pom is all Gradle needs)
DEST="$REPO_DIR/${GROUP//.//}/$ARTIFACT/$SINGBOX_VERSION"
mkdir -p "$DEST"
install -m 0644 "$WORK/out/$ARTIFACT.aar" "$DEST/$ARTIFACT-$SINGBOX_VERSION.aar"
cat > "$DEST/$ARTIFACT-$SINGBOX_VERSION.pom" <<POM
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>$GROUP</groupId>
  <artifactId>$ARTIFACT</artifactId>
  <version>$SINGBOX_VERSION</version>
  <packaging>aar</packaging>
  <description>sing-box v$SINGBOX_VERSION mobile binding (gomobile), built for savak</description>
</project>
POM

SHA=$(sha256sum "$DEST/$ARTIFACT-$SINGBOX_VERSION.aar" | cut -d' ' -f1)
printf '%s\n' "$SHA" > "$DEST/$ARTIFACT-$SINGBOX_VERSION.aar.sha256"

echo
echo "installed: $DEST/$ARTIFACT-$SINGBOX_VERSION.aar"
echo "sha256:    $SHA"
echo "version:   sing-box v$SINGBOX_VERSION ($(git -C "$SRC" rev-parse HEAD | cut -c1-12))"
echo
echo "Record that sha256 next to the release you build, and check the generated class names"
echo "against ir.savak.client.service.LibBoxReflect:"
if command -v unzip >/dev/null; then
  unzip -Z1 "$DEST/$ARTIFACT-$SINGBOX_VERSION.aar" 'classes.jar' >/dev/null 2>&1 \
    && unzip -l "$DEST/$ARTIFACT-$SINGBOX_VERSION.aar" | sed -n '1,4p' || true
fi
