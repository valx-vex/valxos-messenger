#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
import { getPendingForContext, journaliserLesAliasLus, markDelivered, marquerCopiesVues } from "../lib/database.js";
import { formatAdditionalContext, formatCopies } from "../lib/format.js";
import { copiesPourMoi } from "../lib/identity.js";
import { cleDuVerrouDArret, resetStopGuard } from "../lib/stop-guard.js";
import { hookContext, readHookInput, writeStdoutJson } from "./hook-common.js";

const input = await readHookInput();
const { db, selfId, adresses, recoit } = hookContext(input);
if (!recoit) {
  // Refus de chaise : muet, rien lu, rien marqué (voir hook-common.js).
  writeStdoutJson({});
  process.exit(0);
}
const rows = getPendingForContext(db, adresses, { limit: 20 });
journaliserLesAliasLus(db, rows, selfId);
// La copie cc (Task 7) : la lettre de la lignée quand elle est à une AUTRE
// chaise (ou tenue, sans chaise désignée). Vue une fois, jamais livrée — ni
// `markDelivered` ni `resetStopGuard` ne la touchent, et le filet de Stop ne
// la cherche pas : une copie ne bloque jamais un Stop.
const cc = copiesPourMoi(db, selfId, input, { limit: 20 });
const contexte = [
  formatAdditionalContext(rows),
  formatCopies(cc.rows, cc.destinataire, cc)
].filter(Boolean).join("\n\n");

if (!contexte) {
  writeStdoutJson({});
  process.exit(0);
}

if (rows.length > 0) {
  markDelivered(db, rows, selfId, "post_tool_use_delivered");
  resetStopGuard(cleDuVerrouDArret(selfId, input.session_id || input.sessionId)); // F4 : le verrou de CETTE chaise
}
if (cc.rows.length > 0) marquerCopiesVues(db, cc.rows, cc.chaiseId);
writeStdoutJson({
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: contexte
  }
});
