#!/bin/bash
# LA MARCHE DE L'INCONNU (N3, seconde passe adverse du Run 6) — the product
# walk a stranger does, automated: pack the checkout, install it globally with
# npm 12 on a throwaway prefix and HOME (`--allow-scripts=better-sqlite3`: npm
# 12 blocks dependency install scripts by default), then `valxos-messenger
# install --dry-run`, `valxos-messenger install`, `valxos-doctor`, one
# `valxos-send` and one `valxos-inbox` against a scratch office
# (CC2CC_V2_HOME). Everything lives under one mkdtemp directory; nothing reads
# or writes the real HOME.
#
#   .github/scripts/stranger.sh <checkout> [<parent dir for the scratch>]
set -euo pipefail
REPO=$(cd "$1" && pwd -P)
PARENT=${2:-${TMPDIR:-/tmp}}
W=$(mktemp -d "$PARENT/stranger.XXXXXX"); W=$(cd "$W" && pwd -P)
NODEDIR=$(dirname "$(command -v node)")
mkdir -p "$W/home" "$W/prefix" "$W/office"
(cd "$REPO" && npm pack --pack-destination "$W" --silent >/dev/null)
TGZ=$(ls "$W"/valxos-messenger-*.tgz)

# A bare environment: the throwaway HOME, the prefix's bin first, node, the system.
run() { env -i HOME="$W/home" PATH="$W/prefix/bin:$NODEDIR:/usr/bin:/bin" CC2CC_V2_HOME="$W/office" "$@"; }
json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s.slice(s.search(/^\\{/m)));$1})"; }

echo "== node $(node --version), npm 12 global install on $W/prefix"
run npx -y npm@12 i -g "$TGZ" --allow-scripts=better-sqlite3 --prefix "$W/prefix"

echo "== valxos-messenger install --dry-run"
run valxos-messenger install --dry-run | tee "$W/dry.out" | grep -E "npm dependencies|Overall"
grep -q "Overall: ✓" "$W/dry.out"

echo "== valxos-messenger install"
run valxos-messenger install | tee "$W/install.out" | grep -E "npm dependencies|CLI links|Overall"
grep -q "Overall: ✓" "$W/install.out"

echo "== valxos-doctor"
run valxos-doctor | json 'console.log("ok="+j.ok);if(!j.ok||!j.checks.dbExists)process.exit(1)'

echo "== valxos-send (alice → bob)"
run env VALXOS_SELF=alice valxos-send --to bob --body "hello from the stranger" | json 'console.log("sent="+j.sent+" to="+j.to);if(j.sent!==true||j.to!=="bob")process.exit(1)'

echo "== valxos-inbox (bob)"
run env VALXOS_SELF=bob valxos-inbox | json 'console.log("count="+j.count);if(j.count!==1||j.messages[0].body!=="hello from the stranger")process.exit(1)'

echo "STRANGER WALK GREEN"
