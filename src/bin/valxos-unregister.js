#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
import { deriveSelf } from "../lib/config.js";
import { getDatabase, recordEvent, unregisterPeer, verdictDeDesinscription } from "../lib/database.js";
import { parseArgs, printJson, requireArg } from "./cli-common.js";

const args = parseArgs(process.argv.slice(2), {
  booleans: ["force"],
  known: ["id"],
  positionals: false,
  usage: "usage: valxos-unregister --id NAME [--force]   (--force: retire a LIVE chair, an explicit operator gesture)"
});
const id = requireArg(args, "id");
const db = getDatabase();

// N1 (seconde passe adverse, 28/09) : une chaise VIVANTE (`lignée#session`)
// ne se retire pas en passant — elle perdrait son courrier au profit du
// premier nom nu venu. Le CLI est la main de l'opérateur : `--force` est son
// geste explicite, et il se journalise.
const verdict = verdictDeDesinscription(db, id);
if (!verdict.autorise && args.force !== true) {
  recordEvent(db, null, deriveSelf(), "desinscription_refusee", { id, raison: verdict.raison, guichet: "valxos-unregister" });
  process.stderr.write(`Refused: ${id} is a live chair (${verdict.raison}). To retire it anyway: valxos-unregister --id ${id} --force\n`);
  process.exit(1);
}
const result = unregisterPeer(db, id, {
  par: deriveSelf(),
  raison: verdict.raison,
  ...(verdict.autorise ? {} : { force: true, guichet: "valxos-unregister" })
});

if (!result) {
  process.stderr.write(`Peer not found: ${id}\n`);
  process.exit(1);
}

printJson({ unregistered: true, peer: result });
