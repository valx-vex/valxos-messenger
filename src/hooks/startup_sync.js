#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
import { servirSousLeBudget } from "../lib/budget-courrier.js";
import { getPendingForContext, journaliserLesAliasLus } from "../lib/database.js";
import { copiesPourMoi } from "../lib/identity.js";
import { cleDuVerrouDArret, resetStopGuard } from "../lib/stop-guard.js";
import { hookContext, readHookInput, writeStdoutJson } from "./hook-common.js";

// SessionStart est le hook qui DIT la ligne « compatibility - using historical runtime » (1.1.0,
// Tâche 8) : une fois par session. PostToolUse et Stop se taisent (`taireLaLigneDeCompatibilite`).
const input = await readHookInput();
const { db, selfId, adresses, recoit } = hookContext(input);
if (!recoit) {
  // Refus de chaise : muet, rien lu, rien marqué (voir hook-common.js).
  writeStdoutJson({});
  process.exit(0);
}
const enAttente = getPendingForContext(db, adresses, { limit: 50 });
journaliserLesAliasLus(db, enAttente, selfId);
// La copie cc (Task 7) : la lettre de la lignée quand elle est à une AUTRE
// chaise (ou tenue, sans chaise désignée). Vue une fois, jamais livrée — ni
// `markDelivered` ni `resetStopGuard` ne la touchent, et le filet de Stop ne
// la cherche pas : une copie ne bloque jamais un Stop. Une lettre de table
// fermée (`sans_copie`) n'arrive jamais ici (1.1.0, `getCopiesPourChaise`).
const cc = copiesPourMoi(db, selfId, input, { limit: 50 });

if (enAttente.length === 0 && cc.rows.length === 0) {
  writeStdoutJson({});
  process.exit(0);
}

// LE BUDGET (1.1.0, Tâche 7) : Claude Code range dans un fichier tout ce qu'un crochet rend
// au-delà d'environ 10 000 caractères, et le modèle n'en lit qu'un aperçu. `servirSousLeBudget`
// choisit ce qui tient (9 000 caractères au plus, copies comprises), puis marque et met en forme
// d'un seul tenant : une lettre n'est tamponnée `session_start_delivered` que si son corps entier est
// dans la sortie, une copie n'est vue (`cc_vu`) que si elle est montrée. Ce qui ne tient pas attend
// sans marque ; une lettre trop longue pour jamais tenir seule est annoncée (`announced`), au plus
// trois fois, et `inbox` la lit entière.
// LA MARQUE AVANT LA FORME (1.1.0, Tâche 8), gardée pour ce qui se montre : `markDelivered` compte
// le re-service, et `enrichirPourAffichage` lit ce compte en base pour nommer le rappel
// (`Reminder: n`) — il compte CE service-ci. La marque est posée avant l'écriture du contexte, comme
// avant : un hook mort entre les deux laisse la fenêtre de re-service rattraper la lettre (A9).
// `enrichirPourAffichage` (1.1.0) : la table, le nom de chaise et le rappel, pour l'en-tête et rien
// d'autre ; le lecteur est cette boîte (`adresses`) — la position d'une table fermée ne se montre
// qu'à un membre.
const servi = servirSousLeBudget(db, {
  lettres: enAttente,
  cc,
  adresses,
  selfId,
  etiquette: "session_start_delivered",
  via: "session_start",
  limit: 50
});
// Le verrou d'arrêt ne repart que si une lettre a vraiment été livrée : une annonce n'est pas une
// livraison, et le filet de Stop garde ses trois blocages pour une lettre qui attend.
if (servi.livrees.length > 0) {
  resetStopGuard(cleDuVerrouDArret(selfId, input.session_id || input.sessionId)); // F4 : le verrou de CETTE chaise
}
if (!servi.texte) {
  writeStdoutJson({});
  process.exit(0);
}
writeStdoutJson({
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: servi.texte
  }
});
