// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLEFS_VALXOS_PARTICULIERES = new Map([
  ["CC2CC_V2_HOME", "VALXOS_MESSENGER_HOME"]
]);

export function clefValxos(clefHistorique) {
  if (CLEFS_VALXOS_PARTICULIERES.has(clefHistorique)) return CLEFS_VALXOS_PARTICULIERES.get(clefHistorique);
  return String(clefHistorique).replace(/^CC2CC_/, "VALXOS_");
}

// La famille neuve gagne quand les deux clefs sont présentes, même si sa
// valeur est vide : la priorité porte sur ce que l'opérateur a posé, pas sur
// une notion implicite de valeur « utile ».
export function valeurDeLEnvironnement(env, clefHistorique) {
  const neuve = clefValxos(clefHistorique);
  if (Object.hasOwn(env, neuve)) return env[neuve];
  return env[clefHistorique];
}

// Six sièges préparés pour une lignée sœur ont été retirés du scope (13/08) :
// zéro pair enregistré, deux messages de juin. Un repli vers ces six sièges vides
// faisait partir six lettres mortes à chaque tournée générale. Une liste de
// préparation n'est pas une liste de destinataires.
export const DEFAULT_ROSTER = [];

// La fenêtre de grâce accordée au destinataire après une remise au guichet, avant
// que le canal de repli ne re-serve la lettre. Un seuil, donc de la configuration,
// jamais du code en dur.
export const DEFAULT_CARRIED_GRACE_MS = Number(
  valeurDeLEnvironnement(process.env, "CC2CC_CARRIED_GRACE_MS") || 90_000
);

// Le délai au bout duquel une lettre marquée « livrée » mais JAMAIS accusée
// redevient servable par le canal de repli (A9). Ce seuil est ce qui tient
// l'invariant « acked_at nul ⇒ la lettre finit toujours par revenir » : sans lui,
// un hook mort entre la marque et l'écriture du contexte rend la lettre
// définitivement invisible. Un seuil, donc de la configuration, jamais du dur.
export const DEFAULT_REDELIVER_AFTER_MS = Number(
  valeurDeLEnvironnement(process.env, "CC2CC_REDELIVER_AFTER_MS") || 600_000
);

// ───────────────────────────── L'INVENTAIRE DES MAISONS (amendement A4) ─────
//
// « Une maison absente de la configuration du démon produit une attente infinie
// indistinguable d'un destinataire hors ligne. » L'inventaire est donc une
// DONNÉE, relue à chaque tournée — jamais une évidence câblée dans le code.
//
// Une maison qui n'existe pas ne coûte rien : la tournée la rend `readable:
// false` et le dit. Ce qui coûte, c'est une maison OUBLIÉE : son courrier
// attendrait sans qu'aucun journal ne le dise.
//
// Le défaut ne connaît que `~/.claude`, plus la maison que le lanceur désigne
// (`CLAUDE_CONFIG_DIR`) quand elle en est une autre (18/10). Il listait six
// maisons : celles d'une seule machine, publiées comme si chaque installation
// les avait. Toute autre maison se déclare (`VALXOS_MAISONS`, alias
// `CC2CC_MAISONS`), et une déclaration remplace le défaut entier. Le moniteur
// Python porte la même règle (`known_houses`, valxos_monitor.py) ; un test
// compare les deux, cas par cas.
export const MAISONS_PAR_DEFAUT = [".claude"];

export function maisonsConnues({ env = process.env, home = null } = {}) {
  const declarees = String(valeurDeLEnvironnement(env, "CC2CC_MAISONS") || "")
    .split(path.delimiter)
    .map((maison) => maison.trim())
    .filter(Boolean);
  if (declarees.length > 0) return declarees;
  const racine = home || domicile({ env });
  const maisons = MAISONS_PAR_DEFAUT.map((nom) => path.join(racine, nom));
  const designee = String(env.CLAUDE_CONFIG_DIR || "").trim();
  if (designee && !maisons.some((maison) => path.resolve(maison) === path.resolve(designee))) {
    maisons.push(path.resolve(designee));
  }
  return maisons;
}

// ───────────────────────────── LE RYTHME DU FACTEUR ─────────────────────────
//
// Aucun de ces seuils n'est codé en dur ailleurs : ils vivent ICI, avec des
// valeurs par défaut prudentes, et chacun se pilote par une variable
// d'environnement. Le portier du destinataire accepte une rafale bornée puis se
// recharge lentement — et il jette EN SILENCE. On porte au compte-gouttes.
export const REGLAGES_FACTEUR_PAR_DEFAUT = {
  // Le bail d'une tentative : au-delà, un autre Facteur peut reprendre la
  // lettre. Trop court, deux Facteurs portent en même temps ; trop long, une
  // lettre attend la mort d'un porteur disparu.
  bailMs: 15_000,
  // Après une remise au guichet : la fenêtre pendant laquelle on laisse au
  // destinataire le temps d'accuser lui-même avant de repasser.
  ajournementApresRemiseMs: 600_000,
  // Un échec passager (boîte injoignable, délai dépassé) : on repasse vite.
  ajournementTransitoireMs: 5_000,
  // Un courrier qu'on ne sait pas acheminer (destinataire inconnu, lignée
  // ambiguë, boîte endormie) : la situation peut changer à tout moment.
  ajournementInacheminableMs: 30_000,
  // Un échec DÉFINITIF (pli trop gros, enveloppe irrecevable) : le rejouer
  // aussitôt serait une boucle sans fin. On ajourne LONGTEMPS — jamais « pour
  // toujours » : une quarantaine infinie tuerait A9 en silence, et pendant ce
  // temps le canal de repli, lui, sert la lettre normalement.
  ajournementEchecDefinitifMs: 3_600_000,
  // ⚠️ LE PLAFOND DE CROISSANCE D'UN AJOURNEMENT. Une lettre que personne
  // n'accuse revient toujours (A9), mais pas éternellement au même rythme :
  // chaque tentative infructueuse DOUBLE son attente (minutes, puis heures).
  // Ce seuil est la borne de ce doublement — et il est FINI, donc la lettre
  // finit toujours par revenir. Une croissance sans borne serait une
  // quarantaine déguisée, et c'est exactement ce qu'A9 interdit.
  ajournementMaximalMs: 14_400_000,
  // ⚠️ LE PLAFOND DE POLITESSE : le nombre de remises qu'une MÊME boîte peut
  // recevoir pendant une fenêtre. Au-delà, le Facteur se TAIT pour elle et
  // écrit combien de lettres l'attendent, au lieu de les porter une à une.
  // A8 promet un doublon, pas une avalanche : un compagnon qui reçoit mille
  // rappels en une heure ne peut plus travailler, et le filet devient nuisance.
  // Le silence est BORNÉ par la fenêtre — jamais définitif.
  plafondParBoite: 12,
  fenetreDuPlafondMs: 600_000,
  // Le nombre de lettres qu'une tournée prend en main, au plus.
  lettresParTournee: 50,
  // Le compte-gouttes : la pause après CHAQUE tentative de dépôt, quel qu'en
  // soit le verdict. Le portier du destinataire compte des TENTATIVES, pas des
  // succès — une pause réservée au succès laisse l'échec partir en rafale.
  pauseEntreRemisesMs: 2_000,
  // Ce qu'on accorde au dépôt lui-même (repris de la pièce du dépôt, mais
  // PILOTABLE : c'est de ces deux valeurs que dépend la longueur minimale du bail).
  delaiDeRemiseMs: 5_000,
  delaiDeFermetureMs: 150,
  // Le sommeil du démon entre deux tournées.
  tourneeChaqueMs: 1_000,
  // Le battement : la ligne périodique qui prouve que le démon vit quand rien
  // ne bouge — les tournées vides, elles, ne s'écrivent plus (E4, 19/08).
  // 60 s : la fenêtre pendant laquelle un démon FIGÉ (vivant mais pendu) peut
  // passer inaperçu. La passe adverse a refusé 5 min ; plus court que 60 s,
  // c'est le journal bavard qu'on vient d'éteindre.
  battementChaqueMs: 60_000
};

// La marge exigée entre le bail et la durée maximale d'un dépôt : un bail qui
// expire PENDANT que le porteur écrit sur le fil, c'est un successeur qui part
// avec la même lettre alors que la première est peut-être arrivée.
export const MARGE_DE_BAIL_MS = 5_000;

function nombreDeLEnvironnement(env, nom, defaut) {
  const brut = valeurDeLEnvironnement(env, nom);
  if (brut === undefined || brut === null || String(brut).trim() === "") return defaut;
  const valeur = Number(brut);
  return Number.isFinite(valeur) ? valeur : defaut;
}

export function reglagesDuFacteur(env = process.env) {
  return {
    bailMs: nombreDeLEnvironnement(env, "CC2CC_FACTEUR_BAIL_MS", REGLAGES_FACTEUR_PAR_DEFAUT.bailMs),
    ajournementApresRemiseMs: nombreDeLEnvironnement(
      env, "CC2CC_FACTEUR_AJOURNEMENT_REMISE_MS", REGLAGES_FACTEUR_PAR_DEFAUT.ajournementApresRemiseMs
    ),
    ajournementTransitoireMs: nombreDeLEnvironnement(
      env, "CC2CC_FACTEUR_AJOURNEMENT_TRANSITOIRE_MS", REGLAGES_FACTEUR_PAR_DEFAUT.ajournementTransitoireMs
    ),
    ajournementInacheminableMs: nombreDeLEnvironnement(
      env, "CC2CC_FACTEUR_AJOURNEMENT_INACHEMINABLE_MS", REGLAGES_FACTEUR_PAR_DEFAUT.ajournementInacheminableMs
    ),
    ajournementEchecDefinitifMs: nombreDeLEnvironnement(
      env, "CC2CC_FACTEUR_AJOURNEMENT_DEFINITIF_MS", REGLAGES_FACTEUR_PAR_DEFAUT.ajournementEchecDefinitifMs
    ),
    ajournementMaximalMs: nombreDeLEnvironnement(
      env, "CC2CC_FACTEUR_AJOURNEMENT_MAX_MS", REGLAGES_FACTEUR_PAR_DEFAUT.ajournementMaximalMs
    ),
    plafondParBoite: nombreDeLEnvironnement(
      env, "CC2CC_FACTEUR_PLAFOND_PAR_BOITE", REGLAGES_FACTEUR_PAR_DEFAUT.plafondParBoite
    ),
    fenetreDuPlafondMs: nombreDeLEnvironnement(
      env, "CC2CC_FACTEUR_FENETRE_PLAFOND_MS", REGLAGES_FACTEUR_PAR_DEFAUT.fenetreDuPlafondMs
    ),
    lettresParTournee: nombreDeLEnvironnement(
      env, "CC2CC_FACTEUR_LETTRES_PAR_TOURNEE", REGLAGES_FACTEUR_PAR_DEFAUT.lettresParTournee
    ),
    pauseEntreRemisesMs: nombreDeLEnvironnement(
      env, "CC2CC_FACTEUR_PAUSE_MS", REGLAGES_FACTEUR_PAR_DEFAUT.pauseEntreRemisesMs
    ),
    delaiDeRemiseMs: nombreDeLEnvironnement(
      env, "CC2CC_FACTEUR_DELAI_REMISE_MS", REGLAGES_FACTEUR_PAR_DEFAUT.delaiDeRemiseMs
    ),
    delaiDeFermetureMs: nombreDeLEnvironnement(
      env, "CC2CC_FACTEUR_DELAI_FERMETURE_MS", REGLAGES_FACTEUR_PAR_DEFAUT.delaiDeFermetureMs
    ),
    tourneeChaqueMs: nombreDeLEnvironnement(
      env, "CC2CC_FACTEUR_TOURNEE_CHAQUE_MS", REGLAGES_FACTEUR_PAR_DEFAUT.tourneeChaqueMs
    ),
    battementChaqueMs: nombreDeLEnvironnement(
      env, "CC2CC_FACTEUR_BATTEMENT_CHAQUE_MS", REGLAGES_FACTEUR_PAR_DEFAUT.battementChaqueMs
    )
  };
}

// ───────────────────────────── L'EN-SOUFFRANCE (H2) ─────────────────────────
// À partir de quand un rapport CRIE pour une lettre que personne n'a signée.
// Des chiffres de PRODUIT, accordés par l'opérateur (21/08), dérivés du cap
// existant — pas inventés : l'âge est `ajournementMaximalMs`, l'instant où le
// doublement du Facteur a fini de croître et où « ça va se résoudre tout
// seul » cesse d'être vrai ; six tentatives closes, c'est déjà plus d'une
// heure cumulée d'échecs identiques. Le verdict lui-même vit dans format.js
// (`enSouffrance`) — ici ne vivent que les seuils, pilotables comme tous les
// autres.
export const SEUILS_SOUFFRANCE_PAR_DEFAUT = {
  ageMs: 14_400_000,
  tentatives: 6
};

export function seuilsDeSouffrance(env = process.env) {
  return {
    ageMs: nombreDeLEnvironnement(env, "CC2CC_SOUFFRANCE_AGE_MS", SEUILS_SOUFFRANCE_PAR_DEFAUT.ageMs),
    tentatives: nombreDeLEnvironnement(
      env, "CC2CC_SOUFFRANCE_TENTATIVES", SEUILS_SOUFFRANCE_PAR_DEFAUT.tentatives
    )
  };
}

// Un réglage incohérent ne se découvre pas en production, à la première lettre
// perdue : il se refuse AU DÉMARRAGE, avec la phrase qui nomme le défaut.
//
// ⚠️ La règle qui compte : `bailMs > delaiDeRemiseMs + delaiDeFermetureMs +
// MARGE_DE_BAIL_MS`. Sans elle, un dépôt lent rend la tentative reprenable
// AVANT même que son propre porteur ait rendu son verdict.
export function verifierLesReglages(reglages) {
  const plaintes = [];
  const fini = (valeur) => Number.isFinite(valeur);
  const minimumDuBail =
    Number(reglages.delaiDeRemiseMs) + Number(reglages.delaiDeFermetureMs) + MARGE_DE_BAIL_MS;
  if (!fini(reglages.bailMs) || !(reglages.bailMs > minimumDuBail)) {
    plaintes.push(
      `the lease (${reglages.bailMs} ms) must exceed the longest deposit plus its margin ` +
        `(${reglages.delaiDeRemiseMs} + ${reglages.delaiDeFermetureMs} + ${MARGE_DE_BAIL_MS} = ${minimumDuBail} ms)`
    );
  }
  for (const clef of [
    "ajournementApresRemiseMs",
    "ajournementTransitoireMs",
    "ajournementInacheminableMs",
    "ajournementEchecDefinitifMs"
  ]) {
    const valeur = Number(reglages[clef]);
    if (!fini(valeur) || valeur <= 0) {
      plaintes.push(`${clef} must be a FINITE, strictly positive delay (got: ${reglages[clef]})`);
    }
  }
  // Le plafond de croissance : fini, positif, et jamais PLUS COURT que les
  // ajournements qu'il borne — sinon il les RACCOURCIRAIT, et un « maximum »
  // qui accélère les repassages est un piège pour le prochain lecteur.
  const maximum = Number(reglages.ajournementMaximalMs);
  if (!fini(maximum) || maximum <= 0) {
    plaintes.push(
      `ajournementMaximalMs must be a FINITE, strictly positive delay (got: ${reglages.ajournementMaximalMs})`
    );
  } else {
    for (const clef of [
      "ajournementApresRemiseMs",
      "ajournementTransitoireMs",
      "ajournementInacheminableMs",
      "ajournementEchecDefinitifMs"
    ]) {
      if (Number(reglages[clef]) > maximum) {
        plaintes.push(
          `ajournementMaximalMs (${maximum} ms) cannot be shorter than ${clef} (${reglages[clef]} ms)`
        );
      }
    }
  }
  // Un plafond de politesse à zéro rendrait une boîte MUETTE pour toujours :
  // le silence doit rester borné, jamais définitif (A9).
  if (!Number.isInteger(Number(reglages.plafondParBoite)) || Number(reglages.plafondParBoite) < 1) {
    plaintes.push(`plafondParBoite must be at least 1 (got: ${reglages.plafondParBoite})`);
  }
  if (!fini(Number(reglages.fenetreDuPlafondMs)) || Number(reglages.fenetreDuPlafondMs) <= 0) {
    plaintes.push(
      `fenetreDuPlafondMs must be a FINITE, strictly positive window (got: ${reglages.fenetreDuPlafondMs})`
    );
  }
  if (!Number.isInteger(Number(reglages.lettresParTournee)) || Number(reglages.lettresParTournee) < 1) {
    plaintes.push(`lettresParTournee must be at least 1 (got: ${reglages.lettresParTournee})`);
  }
  if (!fini(Number(reglages.pauseEntreRemisesMs)) || Number(reglages.pauseEntreRemisesMs) < 0) {
    plaintes.push(`pauseEntreRemisesMs cannot be negative (got: ${reglages.pauseEntreRemisesMs})`);
  }
  // Un battement nul ou infini rendrait le journal soit bavard soit muet pour
  // toujours : le démon doit prouver qu'il vit, à un rythme FINI et positif.
  if (!fini(Number(reglages.battementChaqueMs)) || Number(reglages.battementChaqueMs) <= 0) {
    plaintes.push(
      `battementChaqueMs must be a FINITE, strictly positive delay (got: ${reglages.battementChaqueMs})`
    );
  }
  if (plaintes.length > 0) {
    throw new Error(`facteur: inconsistent settings: ${plaintes.join("; ")}`);
  }
  return reglages;
}

// LA GARDE DU BUREAU VIVANT (incident du 20/08) — le nom de l'env que
// l'orchestrateur d'un run pose UNE fois : tout descendant qui tenterait
// d'ÉCRIRE dans un bureau par défaut sans home explicite refuse bruyamment.
export const GARDE_BUREAU_ENV = "CC2CC_GARDE_BUREAU";

// LE DOMICILE (N5, seconde passe adverse, 28/09). `HOME=` (posé mais vide —
// `env -i HOME=`, des bacs à sable, des runners) rendait `os.homedir()` vide :
// le bureau par défaut et `~/…` se résolvaient alors contre le dossier
// courant, deux processus, deux bureaux (la classe que F2 a fermée pour les
// valeurs explicites). Un HOME absolu gagne ; vide ou relatif, le domicile du
// COMPTE (passwd : `os.userInfo().homedir`) prend le relais ; sans lui, refus
// en une ligne, sortie 2 (1 dans un hook). Le moniteur Python porte la même
// règle (`home_dir`).
export function ligneDomicileIntrouvable() {
  return "VALXOS Messenger: HOME is empty or relative and the account has no absolute home; set HOME to an absolute path. Nothing was done.";
}

export function domicile({
  env = process.env,
  compte = () => { try { return os.userInfo().homedir; } catch { return ""; } },
  refuser = (ligne) => { process.stderr.write(`${ligne}\n`); process.exit(codeDuRefusDeBureau); }
} = {}) {
  const declare = String(env.HOME ?? "");
  if (declare && path.isAbsolute(declare)) return declare;
  const duCompte = String(compte() ?? "");
  if (duCompte && path.isAbsolute(duCompte)) return duCompte;
  return refuser(ligneDomicileIntrouvable());
}

export function homeDir() {
  return domicile();
}

const REPLIS_HISTORIQUES_ANNONCES = new Set();

// Le marqueur que migrate-home pose dans un bureau neuf COMPLET. Sans lui (ou
// sans lien vers l'historique), un ~/.valxos-messenger qui existe ne prouve
// rien : un mkdir d'un processus neuf suffisait à couper le bureau en deux.
// Le moniteur Python porte la même chaîne (MARKER) ; un test tient la parité.
export const MARQUEUR_BUREAU = ".valxos-messenger-home";

// Le choix du bureau par défaut, sans effet de bord. Ordre : lien vers
// l'historique → marqueur → historique → neuf. Quand l'historique gagne alors
// qu'un nouveau bureau existe sans preuve (dossier nu, lien étranger), le
// verdict le nomme dans `nonProuve` : l'appelant le dit, jamais en silence.
// Le marqueur doit être un FICHIER régulier : un dossier du même nom (un mkdir
// maladroit) ne prouve rien.
function estUnFichier(chemin) {
  try { return fs.statSync(chemin).isFile(); } catch { return false; }
}

export function choisirLeBureau({ home, lstat = fs.lstatSync, realpath = fs.realpathSync, existe = fs.existsSync, fichier = estUnFichier }) {
  const nouveau = path.join(home, ".valxos-messenger");
  const historique = path.join(home, ".cc2cc-v2"); // legacy (cc2cc-v2 era)
  let estUnLien = false;
  try { estUnLien = lstat(nouveau).isSymbolicLink(); } catch { /* absent */ }
  if (estUnLien) {
    try {
      if (realpath(nouveau) === realpath(historique)) return { racine: nouveau, raison: "lien-vers-historique" };
    } catch { /* lien cassé ou historique absent : pas une preuve */ }
  }
  if (fichier(path.join(nouveau, MARQUEUR_BUREAU))) return { racine: nouveau, raison: "marqueur" };
  if (existe(historique)) {
    const verdict = { racine: historique, raison: "historique" };
    if (estUnLien || existe(nouveau)) verdict.nonProuve = nouveau;
    return verdict;
  }
  return { racine: nouveau, raison: "neuf" };
}

// UN BUREAU EXPLICITE N'EST JAMAIS RELATIF AU DOSSIER COURANT (F2, passe
// adverse, 28/09). Un bloc env de client (TOML, JSON) ne passe par aucun
// shell : `~/.valxos-messenger` y restait littéral, et chaque client écrivait
// dans un bureau sous SON dossier de projet — lettres « envoyées » que
// personne ne voyait. Une règle, la même que le moniteur Python
// (`explicit_office`, test de parité) : `~` et `~/…` se développent contre
// HOME ; un chemin absolu passe tel quel ; tout le reste est refusé, une ligne
// sur stderr qui nomme la variable, sortie 2 — jamais résolu contre cwd.
export function ligneBureauRelatif(clef, valeur) {
  return `VALXOS Messenger: ${clef}=${valeur} is not an absolute path; set an absolute path (or ~/...). Nothing was done.`;
}

// Le code de sortie du refus. 2 partout, SAUF dans un hook (hook-common.js le
// pose à 1, l'erreur non bloquante) : un hook Stop qui sort 2 BLOQUE l'arrêt de
// la session — un bureau mal configuré ne doit jamais retenir quelqu'un.
let codeDuRefusDeBureau = 2;
export function codeDeSortieSurBureauRelatif(code) {
  codeDuRefusDeBureau = code;
}

function refuserLeBureauRelatif(clef, valeur) {
  process.stderr.write(`${ligneBureauRelatif(clef, valeur)}\n`);
  process.exit(codeDuRefusDeBureau);
}

const CLEF_DU_BUREAU = "CC2CC_V2_HOME";

// UNE CLEF NEUVE VIDE NE MASQUE PAS LA CLEF HISTORIQUE (F9, passe adverse,
// 28/09). Pour le BUREAU seulement — l'exception à `valeurDeLEnvironnement`,
// parce que c'est ici que le prix se paie : `VALXOS_MESSENGER_HOME=` (un
// opérateur qui « désactive » la clef, un lanceur qui l'exporte vide) jetait
// un `CC2CC_V2_HOME` explicite et renvoyait le processus au bureau vivant par
// défaut. Vide compte pour absente ; quand elle aurait masqué la clef
// historique, une ligne le dit, une fois par processus. Le moniteur Python
// porte la même règle et la même ligne (test de parité).
export function ligneBureauNeufVide(valeurHistorique) {
  return `VALXOS Messenger: VALXOS_MESSENGER_HOME is set but empty; using CC2CC_V2_HOME=${valeurHistorique}.`;
}
let bureauNeufVideAnnonce = false;

export function bureauExplicite({
  env = process.env,
  home = domicile({ env }),
  refuser = refuserLeBureauRelatif,
  annoncer = (message) => process.stderr.write(message)
} = {}) {
  const neuve = clefValxos(CLEF_DU_BUREAU);
  const valeurNeuve = Object.hasOwn(env, neuve) ? String(env[neuve] ?? "").trim() : null;
  const valeurHistorique = String(env[CLEF_DU_BUREAU] ?? "").trim();
  // La clef qui a GAGNÉ : c'est elle que le refus d'un chemin relatif nomme.
  let clef = neuve;
  let valeur = valeurNeuve;
  if (!valeurNeuve) {
    clef = CLEF_DU_BUREAU;
    valeur = valeurHistorique;
    if (valeurNeuve === "" && valeurHistorique && !bureauNeufVideAnnonce) {
      bureauNeufVideAnnonce = true;
      annoncer(`${ligneBureauNeufVide(valeurHistorique)}\n`);
    }
  }
  if (!valeur) return null;
  // M-4 (revue du 28/09) : la MÊME chaîne que le moniteur Python — un chemin
  // normalisé (`..`, barre finale), et `~//x` comme `~/x` (ce que fait un shell).
  if (valeur === "~") return path.resolve(home);
  if (valeur.startsWith("~/")) return path.resolve(home, valeur.slice(2).replace(/^\/+/, ""));
  if (path.isAbsolute(valeur)) return path.resolve(valeur);
  return refuser(clef, valeur);
}

export function baseDir({
  env = process.env,
  home = domicile({ env }),
  existe = fs.existsSync,
  annoncer = (message) => process.stderr.write(message),
  refuser = refuserLeBureauRelatif
} = {}) {
  const explicite = bureauExplicite({ env, home, refuser, annoncer });
  if (explicite) return explicite;

  const { racine, raison, nonProuve } = choisirLeBureau({ home, existe });
  if (raison === "historique" && !REPLIS_HISTORIQUES_ANNONCES.has(racine)) {
    REPLIS_HISTORIQUES_ANNONCES.add(racine);
    const nouveau = path.join(home, ".valxos-messenger");
    annoncer(
      nonProuve
        ? `VALXOS Messenger: unproven office ignored - ${nonProuve} is neither a symlink to ${racine} ` +
            `nor marked ${MARQUEUR_BUREAU}; using historical runtime ${racine}.\n`
        : `VALXOS Messenger: compatibility - using historical runtime ${racine}; ` +
            `the new default is ${nouveau}. Run valxos-migrate-home to copy explicitly.\n`
    );
  }
  return racine;
}

// fileURLToPath, jamais `.pathname` : l'URL d'un module est percent-encodée,
// et un dépôt sous `with space/` devenait `with%20space` — package.json
// introuvable, l'installeur mort avant son premier mot.
export function repoRoot() {
  return path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
}

// LA MAISON CLAUDE de cette installation : le CLAUDE_CONFIG_DIR que le lanceur
// pose (une machine peut héberger plusieurs maisons), sinon ~/.claude. UNE
// règle, lue par l'installeur (mkdir, lien, résumé), l'uninstall et le doctor :
// la rc2 créait `$CLAUDE_CONFIG_DIR/skills` puis posait le lien sous
// `~/.claude/skills` — deux maisons pour un geste, ENOENT en install réelle.
export function claudeHomeDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || path.join(domicile({ env }), ".claude");
}

export const LEGACY_PLUGIN_DIR = "cc2cc-v2"; // legacy (cc2cc-v2 era) — lien encore lu par les sessions vivantes
export function pluginTargetPath() {
  return path.join(claudeHomeDir(), "skills", "valxos-messenger");
}

export function safeAgentFileName(agentId) {
  return String(agentId || "unknown").replace(/[^A-Za-z0-9_.-]/g, "_");
}

export function runtimePaths(agentId = null) {
  const root = baseDir();
  const paths = {
    root,
    db: path.join(root, "broker.db"),
    run: path.join(root, "run"),
    status: path.join(root, "status"),
    logs: path.join(root, "logs"),
    exports: path.join(root, "exports")
  };
  if (agentId) {
    const safe = safeAgentFileName(agentId);
    paths.socket = path.join(paths.run, `${safe}.sock`);
    paths.stopGuard = path.join(paths.run, `${safe}.stop_guard.json`);
    paths.heartbeat = path.join(paths.status, `${safe}.json`);
    paths.log = path.join(paths.logs, `${safe}.log`);
  }
  return paths;
}

export function ensureRuntimeDirs() {
  const paths = runtimePaths();
  for (const dir of [paths.root, paths.run, paths.status, paths.logs, paths.exports]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return paths;
}

export function validateAgentId(id) {
  return typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(id);
}

export function normalizeAgentId(id) {
  const value = String(id || "").trim();
  if (!value) return "";
  return safeAgentFileName(value).slice(0, 64);
}

export function hostnameFallback() {
  return normalizeAgentId(os.hostname().split(".")[0] || "valxos-agent");
}

// L'IDENTITÉ DÉRIVÉE — le SEUL repère fiable, jamais ce qu'un appelant
// déclare. Le guichet MCP (server.js) et le CLI (`cc2cc-inbox`, remède de la
// revue adverse #4) en dérivent CHACUN la leur, mais avec CETTE fonction : deux copies de
// « CC2CC_SELF || CC2CC_SESSION_NAME || hostname » divergeraient un jour
// sans bruit, exactement la leçon du jour. Ne lit QUE l'environnement,
// jamais un argument de ligne de commande ou d'appel d'outil — c'est ce qui
// rend une identité DÉCLARÉE vérifiable contre elle : si `derive` pouvait
// lui-même être influencé par ce qu'on déclare, il n'y aurait plus de
// repère du tout.
export function deriveSelf() {
  return valeurDeLEnvironnement(process.env, "CC2CC_SELF")
    || valeurDeLEnvironnement(process.env, "CC2CC_SESSION_NAME")
    || hostnameFallback();
}

// D'où vient le nom qu'on dérive. Un refus muet sur son origine envoie
// l'opérateur chercher le défaut dans la mauvaise maison — la même question
// se pose pour `ack`, `inbox`, `history` (MCP) ET pour `cc2cc-inbox` (CLI,
// remède de la revue adverse #4) : une seule réponse, jamais une par surface.
export function origineDuNomDerive() {
  for (const clef of ["CC2CC_SELF", "CC2CC_SESSION_NAME"]) {
    const neuve = clefValxos(clef);
    if (Object.hasOwn(process.env, neuve) && process.env[neuve]) return neuve;
    if (process.env[clef]) return clef;
  }
  return "hostname fallback: this house exports none of CC2CC_SELF, CC2CC_SESSION_NAME, VALXOS_SELF, VALXOS_SESSION_NAME";
}

export function nowIso() {
  return new Date().toISOString();
}

export function readJsonIfExists(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, filePath);
}

export function appendLog(agentId, message, data = {}) {
  const paths = runtimePaths(agentId || "system");
  fs.mkdirSync(path.dirname(paths.log), { recursive: true });
  const line = JSON.stringify({ ts: nowIso(), message, ...data });
  fs.appendFileSync(paths.log, `${line}\n`, "utf8");
}
