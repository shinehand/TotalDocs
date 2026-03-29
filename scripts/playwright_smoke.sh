#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
PWCLI="${PWCLI:-$CODEX_HOME/skills/playwright/scripts/playwright_cli.sh}"
SESSION="${PLAYWRIGHT_CLI_SESSION:-verify-current}"
VIEWER_URL="${VIEWER_URL:-http://127.0.0.1:4174/pages/viewer.html}"
HWP_SAMPLE="${1:-$ROOT_DIR/output/playwright/inputs/goyeopje.hwp}"
HWPX_SAMPLE="${2:-$ROOT_DIR/output/playwright/inputs/incheon-2a.hwpx}"
ATTACHMENT_HWP_SAMPLE="${3:-$ROOT_DIR/output/playwright/inputs/attachment-sale-notice.hwp}"

export CODEX_HOME PLAYWRIGHT_CLI_SESSION="$SESSION"

cleanup() {
  "$PWCLI" close-all >/dev/null 2>&1 || true
}

trap cleanup EXIT

if [[ ! -f "$HWP_SAMPLE" ]]; then
  echo "HWP sample not found: $HWP_SAMPLE" >&2
  exit 1
fi

if [[ ! -f "$HWPX_SAMPLE" ]]; then
  echo "HWPX sample not found: $HWPX_SAMPLE" >&2
  exit 1
fi

if [[ ! -f "$ATTACHMENT_HWP_SAMPLE" ]]; then
  echo "Attachment HWP sample not found: $ATTACHMENT_HWP_SAMPLE" >&2
  exit 1
fi

"$PWCLI" close-all >/dev/null 2>&1 || true
"$PWCLI" open "$VIEWER_URL"
"$PWCLI" snapshot
"$PWCLI" click e15
"$PWCLI" upload "$HWP_SAMPLE"
"$PWCLI" screenshot
"$PWCLI" snapshot
"$PWCLI" click e8
"$PWCLI" upload "$HWPX_SAMPLE"
"$PWCLI" screenshot
"$PWCLI" click e8
"$PWCLI" upload "$ATTACHMENT_HWP_SAMPLE"
"$PWCLI" screenshot

echo "Playwright smoke check completed with session: $SESSION"
