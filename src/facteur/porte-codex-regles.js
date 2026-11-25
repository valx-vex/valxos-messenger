// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LES RÈGLES DE LA PORTE CODEX (1.1.0, spec B) — ce qui se lit sans rien lancer.
//
// La porte elle-même (porte-codex.js) lance `codex queue` et `open` : elle porte
// un lanceur. La tournée (round.js) est importée par le guichet, donc par la
// porte web (serveur.js → guichet.js → round.js), et la porte web ne charge
// AUCUN lanceur hors de l'exception nommée et comptée de postbox.js (la garde
// des lanceurs de la porte web, sous test/ : « rien de ce que l'utilisateur
// tape n'atteint une ligne de commande » — or l'enveloppe cite un sujet). Cette
// garde lit aussi les commentaires : aucun nom de lanceur n'est écrit ici, pas
// même celui de son fichier. La tournée lit donc ses règles ICI, et reçoit la
// porte de qui la lance : le démon et le one-shot du Facteur (daemon.js,
// bin/facteur.js), jamais le guichet.
// porte-codex.js réexporte tout ce module : on importe la porte d'un seul endroit.

export const DELAI_SONNETTE_MS = 5000;
export const MOTIF_SONNETTE_IMPOSSIBLE = "sonnette-codex-impossible";
export const MOTIF_SONNETTE_DEJA_SONNEE = "sonnette-codex-deja-sonnee";
// Une lettre que l'enveloppe de la tournée ne nommait pas (arrivée pendant la
// sonnerie, ou sous une autre adresse de la même chaise) : elle attend la
// tournée suivante, et y sonne dans son enveloppe à elle.
export const MOTIF_SONNETTE_DIFFEREE = "sonnette-codex-differee";
// Ce que `codex queue` répond quand la file ne prend pas l'enveloppe : aucune
// session ne tient le fil, ou le fil n'a encore aucun tour.
export const FIL_SANS_SESSION = /No active session|no rollout found/i;
// La seule réponse qui dise que PERSONNE ne tient le fil : celle qui fait ouvrir l'app.
export const PERSONNE_NE_TIENT_LE_FIL = /No active session/i;
// L'app de bureau Codex, par son identifiant de paquet : c'est elle qui déclare
// le schéma `codex://` (mesuré le 22/10 : son exécutable s'appelle « ChatGPT »,
// un nom de processus ne la trouverait pas ; son identifiant, si).
export const BUNDLE_APP_CODEX = "com.openai.codex";
// Le verdict d'une tournée à qui personne n'a tendu la porte (ni le démon, ni le
// one-shot) : la lettre attend, les hooks la servent (A9), et le journal le dit.
export const PORTE_CODEX_ABSENTE = "porte-codex-absente";

export function lienDuFil(threadId) {
  return `codex://threads/${String(threadId)}`;
}

export function argumentsDeSonnette(fiche, enveloppe) {
  return ["queue", "--thread", String(fiche.thread_id), "--message", String(enveloppe)];
}

// L'ouverture de l'app a-t-elle été TENTÉE par cette sonnerie (réussie ou non) ?
// C'est ce que le Facteur borne à une fois par lettre.
export function ouvertureTentee(verdict) {
  return (
    verdict?.mode === "queue+open" ||
    verdict?.mode === "open" ||
    verdict?.erreur === "open-impossible" ||
    verdict?.ouverture === "open-impossible"
  );
}

// L'ouverture a-t-elle RÉUSSI (l'app s'est ouverte sur le fil) ?
export function ouvertureReussie(verdict) {
  return verdict?.mode === "queue+open" || verdict?.mode === "open";
}
