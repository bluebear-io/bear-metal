#!/bin/bash
set -euo pipefail

# GH_TOKEN is injected by the Node caller (dispatch.ts) as a GitHub App installation token.
# Write it to a private .netrc so it is never visible in ps aux.
NETRC_DIR=$(mktemp -d)
chmod 700 "$NETRC_DIR"
printf 'machine github.com login x-access-token password %s\n' "$GH_TOKEN" > "$NETRC_DIR/.netrc"
chmod 600 "$NETRC_DIR/.netrc"
unset GH_TOKEN

HOME="$NETRC_DIR" git clone https://github.com/bluebear-io/blueden
rm -rf "$NETRC_DIR"

cd blueden
scripts/clone-repos.sh
