#!/usr/bin/env bash
# Copy the four runtime files from this source folder to one or more checkouts.
# WARNING: replaces existing src/userplugins/StreamGuard folders in those checkouts.
set -euo pipefail
source_dir="$(cd "$(dirname "$0")/.." && pwd -P)"
if [ "$#" -lt 1 ]; then
    echo "Usage: $0 /path/to/Equicord /path/to/Vencord" >&2
    echo "Existing StreamGuard folders at the targets will be replaced." >&2
    exit 2
fi
for repo in "$@"; do
    if [ ! -d "$repo/src" ]; then
        echo "Not a checkout with a src directory: $repo" >&2
        exit 1
    fi
    parent="$repo/src/userplugins"
    mkdir -p "$parent"
    target="$parent/StreamGuard"
    if [ -e "$target" ] && [ "$(cd "$target" && pwd -P)" = "$source_dir" ]; then
        echo "Skipping the source folder itself: $target"
        continue
    fi
    echo "Replacing $target"
    rm -rf -- "$target"
    mkdir -p "$target"
    cp "$source_dir/index.tsx" "$source_dir/logic.ts" "$source_dir/compat.ts" "$source_dir/styles.css" "$target/"
done
