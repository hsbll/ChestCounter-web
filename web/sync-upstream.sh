#!/usr/bin/env bash
# Brings the replay analyzer up to date with the original project (it changes when Fortnite changes the replay
# format) and re-applies the few changes the browser build needs (web/patches/browser.patch).
# Run from the repository root. Prints "changed=true" or "changed=false" as its last line; stops with an error,
# changing nothing that matters, if the browser changes no longer fit the new code.
set -euo pipefail

UPSTREAM="${UPSTREAM:-https://github.com/xdoofy92/ChestCounter}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

git clone --quiet --depth 1 "$UPSTREAM" "$work/upstream"
sha="$(git -C "$work/upstream" rev-parse HEAD)"
if [ "$(cat web/UPSTREAM 2>/dev/null || true)" = "$sha" ]; then
    echo "Already at upstream $sha."
    echo "changed=false"
    exit 0
fi

# Check the browser changes against the new code before touching the working tree.
if ! git -C "$work/upstream" apply --check --whitespace=nowarn "$PWD/web/patches/browser.patch"; then
    echo "::error::web/patches/browser.patch no longer applies to upstream $sha: the analyzer library changed where the browser build patches it." >&2
    exit 1
fi
git -C "$work/upstream" apply --whitespace=nowarn "$PWD/web/patches/browser.patch"

rm -rf lib src
cp -R "$work/upstream/lib" lib
cp -R "$work/upstream/src" src
cp "$work/upstream/Directory.Build.props" "$work/upstream/LICENSE" .
printf '%s\n' "$sha" > web/UPSTREAM

echo "Updated to upstream $sha."
echo "changed=true"
