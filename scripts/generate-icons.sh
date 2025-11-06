#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p icons
while IFS=' ' read -r basename extension; do
  src="scripts/${basename}.base64"
  dst="icons/${basename}.${extension}"
  if [[ ! -f "$src" ]]; then
    echo "Missing $src" >&2
    exit 1
  fi
  base64 -d "$src" > "$dst"
  echo "Wrote $dst"
done <<'LIST'
icon16 png
icon16-gray png
icon32 png
icon32-gray png
icon48 png
icon48-gray png
icon128 png
icon128-gray png
LIST
