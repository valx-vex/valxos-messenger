// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// UNE LETTRE RENDUE PAR LA CLI (1.1.0) — la forme d'une ligne de l'`inbox` et
// de l'`history` MCP (`decorerLesLettres`, server.js), pour `valxos-inbox` et
// `valxos-history --format json` : `etat` en tête, la ligne entière, puis
// `table` (le NOM, une chaîne : celui de la ligne, même quand le carnet ne
// connaît pas la table), `position`, `rappel` — et `chaise_nom`, le nom humain
// de la chaise qui a posté. L'en-tête se lit par `enrichirPourAffichage` (la
// règle de la position d'une table fermée y vit, une fois), sous les formes du
// LECTEUR : le nom relevé et le nom dérivé, chacun avec sa lignée, sa chaise et
// son adresse humaine (`formesDeLExpediteur`), comme le guichet MCP.
import { enrichirPourAffichage } from "../lib/database.js";
import { etatDeLaLettre } from "../lib/format.js";
import { formesDeLExpediteur } from "../lib/guichet.js";

export function formesDuLecteur(db, ...noms) {
  return [...new Set(noms.filter(Boolean).flatMap((nom) => formesDeLExpediteur(db, nom)))];
}

export function lettresRendues(db, rows, { lecteur }) {
  return enrichirPourAffichage(db, rows, { lecteur }).map(({ affichage, ...row }) => ({
    etat: etatDeLaLettre(row),
    ...row,
    table: row.table_nom ?? null,
    position: affichage.table?.position ?? null,
    chaise_nom: affichage.chaise_nom,
    rappel: affichage.rappel
  }));
}
