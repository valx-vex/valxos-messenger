#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
import { getPendingForContext, journaliserLesAliasLus } from "../lib/database.js";
import { raisonDuBlocageDeStop } from "../lib/format.js";
import { cleDuVerrouDArret, evaluateStopGuard, resetStopGuard } from "../lib/stop-guard.js";
import { hookContext, readHookInput, writeStderrJson, writeStdoutJson } from "./hook-common.js";

// LA LETTRE LA PLUS URGENTE, SUR TOUT L'ENSEMBLE EN ATTENTE — deuxième round
// du même remède (review interne, IMPORTANT 1). Le premier passage (revue
// adverse #4) avait remplacé `rows[0]` par une réduction JS sur `limit:20` — mais
// un lot de 20+ lettres reste un mardi plausible ici
// (`DEFAULT_REDELIVER_AFTER_MS` = 10 min : toute lettre non accusée plus
// vieille re-rentre dans le lot, par lignée ET par chaise), et une lettre
// urgente en position 21 restait invisible : preuve reproduite, 20×LOW puis
// une HIGH juste après → Stop autorisé, l'urgente non lue — LE MÊME défaut
// que ce filet devait fermer, simplement déplacé derrière un seuil. Plus de
// fenêtre, plus de reducer : `parUrgence` (database.js) fait trancher SQLite
// sur l'ensemble entier, ce hook ne prend plus qu'UNE ligne — celle qui
// compte déjà.
const input = await readHookInput();
const { db, selfId, adresses, recoit } = hookContext(input);
if (!recoit) {
  // Refus de chaise : muet, rien lu, rien marqué (voir hook-common.js).
  writeStdoutJson({});
  process.exit(0);
}
const rows = getPendingForContext(db, adresses, { limit: 1, parUrgence: true });
journaliserLesAliasLus(db, rows, selfId);

if (rows.length === 0) {
  resetStopGuard(cleDuVerrouDArret(selfId, input.session_id || input.sessionId)); // F4 : le verrou de CETTE chaise
  writeStdoutJson({});
  process.exit(0);
}

const row = rows[0];
if (row.priority === "low") {
  // Même une lettre LOW seule (ou tout un lot de LOW) n'arrête jamais un
  // Stop — le filet ne sur-corrige pas dans l'autre sens.
  writeStdoutJson({});
  process.exit(0);
}

const decision = evaluateStopGuard(cleDuVerrouDArret(selfId, input.session_id || input.sessionId), row.msg_id, { journal: selfId });
if (!decision.shouldBlock) {
  writeStdoutJson({});
  process.exit(0);
}

writeStderrJson({
  decision: "block",
  reason: raisonDuBlocageDeStop(row),
  systemMessage: `VALXOS Messenger safety net block ${decision.guard.block_count}/3 for ${row.msg_id}`
});
process.exit(2);
