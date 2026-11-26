#!/usr/bin/env bash
#
# enable-workflows.sh — one command, from your own machine, that turns CI on for this repo.
#
# Why this is a script and not something the agent does: GitHub refuses to let a GitHub App
# create or update anything under .github/workflows without the `workflows` permission, so every
# route into that path is closed for a sandbox token —
#
#   git push            → remote rejected: "refusing to allow a GitHub App to create or update
#                         workflow `.github/workflows/probe-run.yml` without `workflows` permission"
#   PUT /contents/...   → 403 "Resource not accessible by integration"
#
# A human token with `repo` scope has no such restriction, so this script exists to be run by the
# person who owns the repo. It does exactly one thing: copies a pipeline from ci/ into
# .github/workflows on main. It never edits the pipeline, never invents a keystore, and prints
# what it installed so the change is auditable afterwards.
#
#   bash android/tools/enable-workflows.sh                 # install ci/apk-only.yml
#   bash android/tools/enable-workflows.sh android-apk     # the full pipeline instead
#   bash android/tools/enable-workflows.sh --dry-run       # what it would send, without sending
#   OWNER=you/repo BRANCH=main bash android/tools/enable-workflows.sh
#
set -euo pipefail

OWNER=${OWNER:-dmj74/savak-vpn}
BRANCH=${BRANCH:-main}
DRY=0
WHICH=apk-only
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --help|-h) sed -n '2,22p' "${BASH_SOURCE[0]}"; exit 0 ;;
    apk-only|android-apk) WHICH=$a ;;
    *) echo "ناشناخته: $a  (انتظار: apk-only | android-apk | --dry-run)" >&2; exit 2 ;;
  esac
done

SRC="ci/$WHICH.yml"
DEST=".github/workflows/$WHICH.yml"
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$ROOT"
[ -f "$SRC" ] || { echo "نبود فایل: $SRC (از ریشهٔ مخزن اجرا کنید)" >&2; exit 1; }

# Install what is in the working tree — but say out loud if that file is uncommitted or edited,
# because "the CI I enabled" and "the pipeline in git" being different files is a nasty class of
# confusion (the installed workflow is live code on main, its source is nowhere to be found).
FROM="local $SRC"
if ! git diff --quiet -- "$SRC" 2>/dev/null || [ -z "$(git ls-files --error-unmatch "$SRC" 2>/dev/null || true)" ]; then
  FROM="local $SRC — **کامیت‌نشده/ویرایش‌شده**، یعنی چیزی که نصب می‌شود در هیچ branch‌ای نیست"
fi

# A workflow file is code that runs with the repo's token. Say what it does before installing it,
# so the person enabling CI reads the trust decision instead of scrolling past it.
echo "═══ در حال نصب ═══"
echo "  از:    $FROM"
echo "  به:    $OWNER/$BRANCH:$DEST"
echo "  jobs:  $(grep -cE '^  [a-z0-9-]+:$' <(sed -n '/^jobs:/,$p' "$SRC") 2>/dev/null || echo '?')"
grep -nE '^\s+(runs-on|uses|if):' "$SRC" | sed 's/^/    /' | head -14
echo "  actions‌های شخص ثالث (این‌ها token شما را می‌گیرند تا اجرا شوند):"
grep -oE "uses: [^{@#]+" "$SRC" | sed 's/uses: //;s/^ */    /' | sort -u
if [ "$DRY" = 1 ]; then
  echo; echo "--dry-run: چیزی ارسال نشد."
  exit 0
fi

command -v gh >/dev/null 2>&1 || { echo "gh لازم است (https://cli.github.com)" >&2; exit 3; }
gh auth status >/dev/null 2>&1 || { echo "اول: gh auth login" >&2; exit 3; }

# base64 of the file, exactly as the Contents API wants it. The double-encode dance is because
# gh's own --content flag does not base64, and a raw newline in a JSON string is how you end up
# with a workflow file that GitHub reports as "invalid YAML" for no visible reason.
B64=$(base64 -w0 < "$SRC")
if gh api "repos/$OWNER/contents/$DEST" --jq .sha >/dev/null 2>&1; then
  SHA=$(gh api "repos/$OWNER/contents/$DEST?ref=$BRANCH" --jq .sha)
  # An update without the current blob SHA is refused, and the refusal is the only hint you get
  # that someone else already enabled CI. Re-send with the SHA rather than clobber blindly.
  gh api -X PUT "repos/$OWNER/contents/$DEST" \
    -f message="ci: refresh $WHICH pipeline" -f branch="$BRANCH" -f sha="$SHA" -f content="$B64" \
    --jq '"به‌روزرسانی شد: " + .commit.sha[0:7]'
else
  gh api -X PUT "repos/$OWNER/contents/$DEST" \
    -f message="ci: enable the $WHICH pipeline" -f branch="$BRANCH" -f content="$B64" \
    --jq '"نصب شد: " + .commit.sha[0:7]'
fi

echo
echo "حالا (هر دو از همین ماشین، با token خودتان):"
echo "  gh workflow run '$WHICH' --repo $OWNER           # اجرای دستی"
echo "  gh run watch --repo $OWNER --exit-status          # دنبال ساخت"
echo "  git clone -q -b apk-build --depth 1 \"https://github.com/$OWNER.git\" /tmp/ab"
echo "     → /tmp/ab/savak-debug.apk + PROVENANCE.md (فقط اگر $WHICH = apk-only)"
echo "قبل از نصب روی گوشی، همان درِ CI را خودتان بزنید:"
echo "  bash android/tools/install-toolchain.sh --verify-apk /tmp/ab/savak-debug.apk"
