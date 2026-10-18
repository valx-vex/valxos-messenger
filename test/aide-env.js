// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// L'ENVIRONNEMENT D'UN ENFANT DE TEST PART DE CELUI DU LANCEUR — MOINS SON
// BUREAU, SA MAISON ET SES GARDES.
//
// Presque chaque test qui lance un processus du produit lui pose un bureau
// jetable avec la clef historique (`CC2CC_V2_HOME: root`). Or la famille
// VALXOS_* GAGNE quand les deux clefs sont présentes (config.js,
// `valeurDeLEnvironnement`) : un lanceur qui exporte VALXOS_MESSENGER_HOME
// envoyait donc TOUS ces enfants dans le même bureau — le sien. Mesuré le
// 29/08 : ~80 tests rouges, et la suite qui ne finit plus (verrou du Facteur
// et sockets partagés entre fichiers joués en parallèle). Même classe pour
// CLAUDE_CONFIG_DIR (le doctor et l'installeur suivent la maison du lanceur)
// et pour la garde du bureau vivant, qu'un orchestrateur pose pour ses runs.
//
// La règle est donc unique et vit ici : ce qu'un test pose explicitement
// gouverne ; ce que le lanceur avait exporté pour LUI ne descend jamais.
export const CLEFS_DU_LANCEUR = [
  "VALXOS_MESSENGER_HOME",
  "CC2CC_V2_HOME",
  "CLAUDE_CONFIG_DIR",
  "CC2CC_GARDE_BUREAU",
  "VALXOS_GARDE_BUREAU",
  // L'identité du lanceur (Run 6, 27/09) : une session enregistrée au
  // Messenger exporte son nom, et `VALXOS_SELF` battait le `CC2CC_SELF` posé
  // par le test — 28 rouges et deux fichiers pendus. SESSION_NAME aussi : un
  // test qui ne pose que lui perdait contre le SELF hérité.
  "VALXOS_SELF",
  "CC2CC_SELF",
  "VALXOS_SESSION_NAME",
  "CC2CC_SESSION_NAME"
];

// AUCUN ENFANT NE LAISSE DE BYTECODE DANS L'ARBRE (C1, FIX-C, 18/10). Le moniteur
// est un script Python que les tests chargent par `importlib` : sans cette
// variable, chaque chargement écrit `src/monitor/__pycache__/*.pyc`, qui porte
// le chemin absolu de la source (donc le nom du compte). `files` retire ces
// fichiers du paquet ; ici on évite de les écrire. Ce qu'un test pose gouverne.
export function envPropre(ajouts = {}) {
  const env = { ...process.env };
  for (const clef of CLEFS_DU_LANCEUR) delete env[clef];
  return { ...env, PYTHONDONTWRITEBYTECODE: "1", ...ajouts };
}

// LE BUREAU EN-PROCESSUS. Un test qui écrivait `process.env.CC2CC_V2_HOME =
// racine` posait la clef HISTORIQUE — et perdait contre la clef neuve que le
// lanceur avait exportée : mesuré le 29/08, 36 fichiers créaient le bureau du
// lanceur et y déposaient leurs fiches. Ici la clef neuve du lanceur tombe
// d'abord ; le bureau du test gouverne, par la même clef que les tests ont
// toujours écrite.
export function poserLeBureau(racine) {
  delete process.env.VALXOS_MESSENGER_HOME;
  process.env.CC2CC_V2_HOME = racine;
  return racine;
}
