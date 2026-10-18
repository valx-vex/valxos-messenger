// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LA SONDE — UN SOUS-PROCESSUS QUI IMPORTE LA PORTE, ET RIEN D'AUTRE.
//
// Elle enregistre le crochet de résolution, puis importe les GRAINES dans
// l'ordre où on les lui donne. Ce que node résout pendant ce temps atterrit dans
// le journal ; c'est ce journal, et pas une lecture de source, qui devient le
// vivier de la garde n°1.
//
// ⚠️ POURQUOI UN SOUS-PROCESSUS ET PAS LE RUNNER. Importer `src/bin/valxos-web.js`
// EXÉCUTE le lanceur : il ouvrirait une vraie porte, sur un vrai port, avec un
// vrai bureau. Dans le processus des tests ce serait un chantier permanent ; ici
// c'est jetable, et le lanceur est neutralisé proprement par son PROPRE refus
// (`CC2CC_WEB_HOTE=0.0.0.0` → `verifierLHote` lève → `process.exit(2)`), c'est-
// à-dire par une garde du produit, jamais par un contournement de décor.
//
// ⚠️ ET L'ORDRE DES PHASES JOUE POUR NOUS : un graphe ESM est entièrement
// RÉSOLU avant d'être évalué. Le journal est donc complet au moment où le
// lanceur refuse — le refus n'ampute rien.
import module from "node:module";
import { pathToFileURL } from "node:url";

const journal = process.argv[2];
const graines = process.argv.slice(3);

module.register("./crochet-graphe.mjs", import.meta.url, { data: { journal } });

for (const graine of graines) {
  await import(pathToFileURL(graine).href);
}
