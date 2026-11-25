// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// L'ENVELOPPE DE SONNETTE (1.1.0, spec B §3). Ce que la sonnette dépose chez
// une chaise Codex (`codex queue`, porte Codex du Facteur) et ce que le filet
// du Stop du hook Codex donne comme raison : UNE ligne, en anglais, qui dit
// qu'une lettre attend — jamais son corps. Les deux voies arrivent au modèle
// comme une PAROLE DE L'UTILISATEUR (fait prouvé par la sonde du 21/10) : un
// corps y deviendrait une consigne. Tout texte d'un pair qui y entre est
// aplati, borné en points de code et écrit comme un littéral JSON (guillemets
// échappés, aucun retour à la ligne) :
//   - le sujet, 60 points de code ;
//   - l'expéditeur et le nom de sa chaise, 64 (Round 1 de la relecture) : le
//     nom de chaise est le `session_name` de la fiche de l'expéditeur, un texte
//     libre sans borne (`/rename`) — 3 000 caractères d'une consigne y
//     entraient tels quels, sous la voix de l'utilisateur ;
//   - la table reste nue quand elle a la forme du carnet (`[a-z0-9][a-z0-9-]
//     {0,31}`, tables.js), comme la spec l'écrit ; autrement, elle est citée.
// La destinataire est la nôtre (la lignée servie) : aplatie quand même, la
// ligne reste une ligne. La priorité (B13) est bornée à 20 points de code et
// citée comme le sujet : la ligne ne s'en remet plus à la base pour la
// normaliser (une ligne d'avant une normalisation, une écriture directe).
// « Aplatir » (B13) : TOUT séparateur de ligne Unicode (CR, LF, VT, FF, NEL
// U+0085, U+2028, U+2029) et tout caractère de contrôle devient une espace —
// `\s` seul laissait passer U+0085, qu'un terminal rend comme un saut de ligne.
// Cette fonction ne lit pas `body`, et elle est pure : aucun bureau.
export const LONGUEUR_SUJET_SONNETTE = 60;
export const LONGUEUR_NOM_SONNETTE = 64;
export const LONGUEUR_PRIORITE_SONNETTE = 20;

// La forme d'un nom de table au carnet (tables.js, `NOM_DE_TABLE`, non exportée).
const NOM_DE_TABLE = /^[a-z0-9][a-z0-9-]{0,31}$/;

function surUneLigne(valeur) {
  return String(valeur ?? "").replace(/[\s\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").trim();
}

// Aplatie, puis bornée en points de code. Exportée pour le `systemMessage` du
// Stop de Claude Code, qui recopie une clef choisie par le pair (A3).
export function borne(valeur, max) {
  return Array.from(surUneLigne(valeur)).slice(0, max).join("");
}

// Un nom d'un pair, tel qu'il entre dans une ligne qui parle au modèle : borné,
// cité en JSON. `""` (vide) quand il n'y a rien à citer. Exporté pour le
// `systemMessage` du Stop, qui nomme l'expéditeur de la même façon.
export function nomCite(valeur) {
  const nom = borne(valeur, LONGUEUR_NOM_SONNETTE);
  return nom ? JSON.stringify(nom) : "";
}

// `rows` : les lettres de CETTE sonnerie ; la première décrit l'enveloppe (la
// plus urgente, puis la plus ancienne : l'ordre de `parUrgence`).
// `autresNonLues` : ce qui attend déjà en plus, hors de cette sonnerie.
export function enveloppeDeSonnette(rows, { destinataire, autresNonLues = 0 } = {}) {
  const lettres = (Array.isArray(rows) ? rows : []).filter(Boolean);
  if (lettres.length === 0) return "";
  const [premiere] = lettres;
  const expediteur = nomCite(premiere.sender) || "\"\"";
  const chaise = nomCite(premiere.affichage?.chaise_nom);
  const morceaux = [`from ${chaise ? `${expediteur} (${chaise})` : expediteur}`];
  const table = surUneLigne(premiere.table_nom);
  if (table) morceaux.push(`table ${NOM_DE_TABLE.test(table) ? table : nomCite(table)}`);
  const sujet = borne(premiere.subject, LONGUEUR_SUJET_SONNETTE);
  if (sujet) morceaux.push(`subject ${JSON.stringify(sujet)}`);
  morceaux.push(`priority ${JSON.stringify(borne(premiere.priority, LONGUEUR_PRIORITE_SONNETTE))}`);
  const n = lettres.length;
  const autres = Number(autresNonLues) > 0 ? `; ${Number(autresNonLues)} other unread` : "";
  return `📬 VALXOS Messenger: ${n} letter${n === 1 ? "" : "s"} waiting for ${surUneLigne(destinataire)} — ${morceaux.join(", ")}${autres}. Call the inbox tool.`;
}
