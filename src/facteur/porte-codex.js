// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LA PORTE CODEX DU FACTEUR (1.1.0, spec B §2, §4, §7) — sonner une chaise
// Codex avec `codex queue`, et ouvrir l'app sur le fil quand personne ne le tient.
//
// Ce que les sondes du 21/10 ont prouvé (Codex CLI 0.163.0) : `codex queue
// --thread <uuid> --message <texte>` réveille un fil ouvert et inactif (un tour
// démarre seul, en moins d'une seconde avec le démon) ; un message mis en file
// pendant un tour attend la fin du tour ; un fil fermé reste actif sur le démon,
// et `open codex://threads/<uuid>` rouvre l'app sur lui — la file part ; après
// Échap, la file se fige jusqu'au prochain prompt humain ; avant le premier tour,
// la file refuse (`no rollout found`). Et ce message arrive au modèle COMME UNE
// PAROLE DE L'UTILISATEUR : on ne dépose que l'ENVELOPPE (sonnette.js), jamais
// un corps. Jamais `codex exec resume` (B2 amendé) : un tour payant sans humain,
// et un second écrivain sur un fil ouvert.
//
// QUI REGARDE LE FIL ? La réponse de `codex queue` ne le dit qu'à moitié.
// `No active session` : personne. `no rollout found` : une session existe, sans
// tour encore (une CLI en plein premier tour, par exemple) — l'app n'y changerait
// rien, et surgir devant un terminal serait pire. Mais une file qui ACCEPTE ne
// dit pas que quelqu'un regarde : app fermée, le démon partagé prend la lettre
// et la garde (sonde P10). Pour ce cas, c'est l'app qu'on interroge
// (`appCodexOuverte`). Le pid de la fiche n'est JAMAIS un témoin (chaise-codex.js :
// il est indicatif, la moisson et le docteur le lisent, aucune décision de
// livraison) : cette porte ne le regarde pas.
//
// La marche, en entier :
//   1. `codex queue` ; la file prend l'enveloppe → `queue`, et si l'app de
//      bureau est FERMÉE (`appOuverte()` rend `false`, et lui seul), l'app
//      s'ouvre sur le fil (`queue+open`). Ouverte ou inconnue : `queue`.
//   2. Sa sortie dit `No active session` ou `no rollout found` → UNE relance,
//      la même commande par le même uuid (un démon qui hoquette).
//      · la relance passe, et la première frappe disait « personne » → l'app
//        s'ouvre sur le fil (`queue+open`) : le fil qui se charge reçoit sa file ;
//      · la relance passe après un « sans tour » → `queue` : ni détecteur, ni app ;
//      · la relance refuse en disant « personne » → l'app s'ouvre sur le fil
//        (`open`, `ok: false`) : rien n'est en file, la lettre n'est pas portée,
//        et la prochaine tournée trouvera une session ;
//      · la relance refuse encore autrement → `codex-fil-sans-session`.
//   3. L'app ne s'ouvre que sur macOS, pour une chaise `app` (ou sans porte) —
//      JAMAIS pour une chaise `cli` ou `exec` (round 1b) — et `ouvrirApp: false`
//      (`VALXOS_CODEX_OUVRIR_APP=0`) éteint tout, détecteur compris. Le Facteur
//      borne les ouvertures à une par lettre (round.js : `carried_at`, et la
//      note `facteur_codex_app_ouverte` quand la file a refusé).
//
// ⚠️ UNE PORTE QUI PEND NE BLOQUE JAMAIS LA TOURNÉE (point de revue 4). Chaque
// enfant est tué à `delaiMs`, sa sortie est BUE — stdout ET stderr : un enfant
// qui écrit plus qu'un tube ne contient se bloque, et bloquerait le Facteur avec
// lui — et la porte ENTIÈRE (la frappe, sa relance, l'ouverture) tient dans DEUX
// délais, petits-enfants compris (`lancerBorne` tue le groupe) : le bail d'une tentative (`bailMs`, liée juste avant) doit survivre à
// la sonnerie, sinon la remise se perd et la lettre resonne. Le verdict est un
// objet, jamais une exception. `codex` introuvable est un verdict comme les
// autres : la lettre attend, les hooks la servent (A9).
//
// ⚠️ CE MODULE PORTE UN LANCEUR, et ne se charge que dans les processus du
// Facteur (daemon.js, bin/facteur.js), qui le tendent à la tournée. La tournée
// lit ses règles dans porte-codex-regles.js, que ce module réexporte : la porte
// web, qui charge round.js par le guichet, ne charge jamais celui-ci
// (test/web-garde-spawn.test.js).
import { spawn as spawnReel } from "node:child_process";
import fs from "node:fs";

import { runtimePaths } from "../lib/config.js";

import {
  BUNDLE_APP_CODEX,
  DELAI_SONNETTE_MS,
  FIL_SANS_SESSION,
  PERSONNE_NE_TIENT_LE_FIL,
  argumentsDeSonnette,
  lienDuFil
} from "./porte-codex-regles.js";

export {
  BUNDLE_APP_CODEX,
  DELAI_SONNETTE_MS,
  FIL_SANS_SESSION,
  MOTIF_SONNETTE_DEJA_SONNEE,
  MOTIF_SONNETTE_DIFFEREE,
  MOTIF_SONNETTE_IMPOSSIBLE,
  PERSONNE_NE_TIENT_LE_FIL,
  PORTE_CODEX_ABSENTE,
  argumentsDeSonnette,
  lienDuFil,
  ouvertureReussie,
  ouvertureTentee
} from "./porte-codex-regles.js";

// Ce qu'on garde de la sortie d'un enfant : assez pour nommer un refus, jamais
// de quoi remplir la mémoire d'un démon avec un `codex` bavard.
const PLAFOND_SORTIE = 4096;

// Ce qu'on laisse aux tubes, après la SORTIE de l'enfant, pour livrer leurs
// dernières lignes (`close`). Au-delà, un petit-enfant qui en aurait hérité ne
// retient plus la porte : on cesse de lire, et on conclut sur la sortie.
const GRACE_APRES_SORTIE_MS = 200;

// Lance une commande, boit sa sortie (bornée), la tue au délai. Ne lève JAMAIS :
// `erreur` porte le code d'un lancement raté (`ENOENT` : introuvable), `tue` dit
// que le couperet est tombé, `code`/`signal` sont ceux de la fin. L'enfant ne lit
// pas stdin (`ignore`) : un `codex` qui attendrait une réponse ne pend pas sur
// un tube que personne n'écrit.
//
// ⚠️ UN PETIT-ENFANT NE RETIENT PAS LA PORTE (revue de la Tâche 10, constat 3).
// Node n'émet `close` qu'une fois stdout ET stderr fermés : un petit-enfant qui
// en a hérité (un enveloppeur qui lance le binaire natif) gardait la promesse
// ouverte jusqu'à sa propre fin — la tournée, et le démon avec elle, figés. Donc :
//   · l'enfant naît CHEF DE SON GROUPE (`detached`) ; au couperet, c'est le
//     groupe entier qui reçoit SIGKILL (`process.kill(-pid)`), l'enfant seul en
//     repli, nos tubes se ferment, et on conclut sur `exit` (une grâce courte
//     si même `exit` ne vient pas) ;
//   · après une sortie NORMALE, on attend `close` le temps d'une grâce courte,
//     puis on cesse de lire et on conclut. On ne tue PAS le groupe d'un enfant
//     sorti de lui-même : ce qu'il a laissé derrière lui (un démon, peut-être)
//     n'est pas à nous.
export function lancerBorne({
  commande,
  args,
  env = {},
  cwd = null,
  lancer = spawnReel,
  delaiMs = DELAI_SONNETTE_MS,
  graceMs = GRACE_APRES_SORTIE_MS
}) {
  return new Promise((resolve) => {
    let sortie = "";
    let tue = false;
    let conclu = false;
    let couperet = null;
    let grace = null;
    let enfant = null;
    const fermerLesTubes = () => {
      for (const tube of [enfant?.stdout, enfant?.stderr]) {
        try {
          tube?.destroy();
        } catch {
          /* déjà fermé */
        }
      }
    };
    const conclure = (fin) => {
      if (conclu) return;
      conclu = true;
      if (couperet) clearTimeout(couperet);
      if (grace) clearTimeout(grace);
      fermerLesTubes();
      resolve({ sortie, tue, pid: enfant?.pid ?? null, ...fin });
    };
    try {
      enfant = lancer(commande, args, {
        env: { ...process.env, ...env },
        ...(cwd ? { cwd } : {}),
        stdio: ["ignore", "pipe", "pipe"],
        detached: true
      });
    } catch (erreur) {
      conclure({ code: null, signal: null, erreur: erreur?.code || String(erreur) });
      return;
    }
    const tuerLeGroupe = () => {
      if (!enfant?.pid) return;
      try {
        process.kill(-enfant.pid, "SIGKILL");
        return;
      } catch {
        /* pas de groupe à ce numéro (lanceur qui ne détache pas) : l'enfant seul */
      }
      try {
        enfant.kill("SIGKILL");
      } catch {
        /* déjà parti */
      }
    };
    const delai = Math.max(1, Number(delaiMs) || DELAI_SONNETTE_MS);
    const echeanceDeLEnfant = Date.now() + delai;
    couperet = setTimeout(() => {
      // Round 1c : un enfant déjà sorti (sa grâce court) n'est plus à trancher.
      if (grace) return;
      tue = true;
      tuerLeGroupe();
      fermerLesTubes();
      grace = setTimeout(() => conclure({ code: null, signal: "SIGKILL", erreur: null }), graceMs);
    }, delai);
    const boire = (bloc) => {
      if (sortie.length >= PLAFOND_SORTIE) return;
      sortie += String(bloc).slice(0, PLAFOND_SORTIE - sortie.length);
    };
    enfant.stdout?.on("data", boire);
    enfant.stderr?.on("data", boire);
    // Un tube détruit peut lever en se fermant : jamais jusqu'au démon.
    enfant.stdout?.on("error", () => {});
    enfant.stderr?.on("error", () => {});
    enfant.on("error", (erreur) => conclure({ code: null, signal: null, erreur: erreur?.code || String(erreur) }));
    enfant.on("exit", (code, signal) => {
      if (tue) {
        conclure({ code, signal, erreur: null });
        return;
      }
      // UNE SORTIE NORMALE DÉSARME LE COUPERET (round 1c) : sans quoi, tombant
      // pendant la grâce, il marquait `tue` — la porte disait `codex-delai` d'une
      // enveloppe que la file avait prise — et tuait le groupe d'un enfant déjà
      // sorti. La grâce ne déborde pas l'échéance de l'enfant (vingt
      // millisecondes au moins) : la porte entière tient toujours dans ses délais.
      if (couperet) {
        clearTimeout(couperet);
        couperet = null;
      }
      const attente = Math.max(20, Math.min(Number(graceMs) || GRACE_APRES_SORTIE_MS, echeanceDeLEnfant - Date.now()));
      if (!grace) grace = setTimeout(() => conclure({ code, signal, erreur: null }), attente);
    });
    // Un lancement raté émet `error` d'abord (`conclu` tient) ; par prudence, une
    // fin sans pid et code -2 est le même constat : introuvable.
    enfant.on("close", (code, signal) => conclure({ code, signal, erreur: code === -2 && !enfant.pid ? "ENOENT" : null }));
  });
}

function refusDeLancement(tentative) {
  if (tentative.erreur === "ENOENT") return { ok: false, mode: null, erreur: "codex-introuvable" };
  if (tentative.erreur) return { ok: false, mode: null, erreur: "codex-injoignable", detail: tentative.erreur };
  if (tentative.tue) return { ok: false, mode: null, erreur: "codex-delai" };
  return null;
}

function detailDe(tentative) {
  return String(tentative.sortie || "").trim().slice(0, 200) || null;
}

const enFile = (tentative) => tentative.code === 0 && !FIL_SANS_SESSION.test(tentative.sortie);

// Une promesse qui ne rend pas la main à temps est une ouverture ratée : un
// ouvreur injecté qui pend ne retient pas la porte au-delà de son budget.
function auPlus(executer, ms) {
  return new Promise((resolve) => {
    const minuterie = setTimeout(() => resolve({ ok: false, erreur: "open-delai" }), Math.max(1, ms));
    Promise.resolve()
      .then(executer)
      .then(
        (rendu) => resolve(rendu && typeof rendu === "object" ? rendu : { ok: rendu !== false }),
        (erreur) => resolve({ ok: false, erreur: String(erreur?.code || erreur?.message || erreur) })
      )
      .finally(() => clearTimeout(minuterie));
  });
}

// L'APP DE BUREAU TOURNE-T-ELLE ? (revue de la Tâche 10, constat 1.) La sonde
// P10 l'a montré : app fermée, `codex queue --thread <uuid>` ACCEPTE la lettre
// (le fil reste actif sur le démon partagé), et seule l'ouverture de l'app sur
// le fil la fait partir. La réponse de la file ne dit donc pas si quelqu'un
// regarde ; `lsappinfo` le dit, par l'identifiant de paquet de l'app :
//   · une ligne `ASN:` → elle tourne (`true`) ;
//   · une sortie vide, code 0 → elle est fermée (`false`) ;
//   · une erreur, un enfant tué, une commande absente, une sortie inattendue,
//     un autre système → on ne sait pas (`null`), et on n'ouvre rien.
export async function appCodexOuverte({
  lancer = spawnReel,
  delaiMs = DELAI_SONNETTE_MS,
  graceMs = GRACE_APRES_SORTIE_MS,
  plateforme = process.platform
} = {}) {
  if (plateforme !== "darwin") return null;
  const fin = await lancerBorne({ commande: "lsappinfo", args: ["find", `bundleid=${BUNDLE_APP_CODEX}`], lancer, delaiMs, graceMs });
  if (fin.erreur || fin.tue || fin.code !== 0) return null;
  if (/ASN:/.test(fin.sortie)) return true;
  return String(fin.sortie).trim() === "" ? false : null;
}

// Le détecteur, sous le budget de la porte : `true`, `false` ou `null` — un
// détecteur injecté qui lève, qui pend ou qui rend autre chose qu'un booléen
// dit « on ne sait pas ».
function detecterAuPlus(detecter, ms) {
  return new Promise((resolve) => {
    const minuterie = setTimeout(() => resolve(null), Math.max(1, ms));
    Promise.resolve()
      .then(detecter)
      .then(
        (rendu) => resolve(typeof rendu === "boolean" ? rendu : null),
        () => resolve(null)
      )
      .finally(() => clearTimeout(minuterie));
  });
}

// LE DOSSIER OÙ `codex queue` EST LANCÉ (B18, marche du 22/10) : jamais le
// dossier du Facteur, qui est souvent un dépôt — Codex 0.163.0 y trouvait un
// dépôt à inspecter. `<bureau>/run/`, créé s'il manque.
// S12 (seconde passe adverse) : un `run/` qu'on ne peut pas assurer (un fichier
// à sa place, un bureau qu'on ne sait pas lire) rend `null`, et la sonnerie se
// dit alors impossible (`run-inaccessible`, `sonnerLaChaiseCodex`) — jamais un
// enfant qui hériterait du dossier courant.
export const RUN_INACCESSIBLE = "run-inaccessible";
export function dossierDeLaSonnette() {
  try {
    const dossier = runtimePaths().run;
    fs.mkdirSync(dossier, { recursive: true, mode: 0o700 });
    return fs.statSync(dossier).isDirectory() ? dossier : null;
  } catch {
    return null;
  }
}

// `fiche` : la fiche de chaise Codex (thread_id, codex_home), lue au bureau
// (`<bureau>/codex/<lignée>.json`), jamais sur la carte `peers`. `enveloppe` :
// la ligne de sonnette.js, jamais un corps. `lancer`/`ouvrir`/`appOuverte`/
// `plateforme` sont injectables pour les tests ; `ouvrir` nul lance `open <lien>`
// par `lancer`, `appOuverte` nul demande à `lsappinfo` par `lancer`.
export async function sonnerLaChaiseCodex({
  fiche,
  enveloppe,
  lancer = spawnReel,
  ouvrir = null,
  appOuverte = null,
  delaiMs = DELAI_SONNETTE_MS,
  graceMs = GRACE_APRES_SORTIE_MS,
  ouvrirApp = true,
  plateforme = process.platform,
  cwd = undefined
}) {
  if (!fiche?.thread_id || !fiche?.codex_home) return { ok: false, mode: null, erreur: "fiche-incomplete" };
  const dossier = cwd === undefined ? dossierDeLaSonnette() : cwd;
  // S12 : sans dossier sûr, aucun `codex` ne part ; la lettre attend les hooks et une tournée suivante.
  if (!dossier) return { ok: false, mode: null, erreur: RUN_INACCESSIBLE };
  const delai = Math.max(1, Number(delaiMs) || DELAI_SONNETTE_MS);
  // LE BUDGET DE LA PORTE : deux délais pour tout (la frappe, sa relance, l'ouverture).
  const echeance = Date.now() + 2 * delai;
  const reste = () => Math.max(1, Math.min(delai, echeance - Date.now()));
  const frapper = () =>
    lancerBorne({
      commande: "codex",
      args: argumentsDeSonnette(fiche, enveloppe),
      env: { CODEX_HOME: String(fiche.codex_home) },
      cwd: dossier,
      lancer,
      delaiMs: reste(),
      graceMs
    });
  const ouvrirLeFil = () => {
    const lien = lienDuFil(fiche.thread_id);
    if (ouvrir) return auPlus(() => ouvrir(lien), echeance - Date.now());
    return lancerBorne({ commande: "open", args: [lien], lancer, delaiMs: reste(), graceMs }).then((fin) => ({
      ok: !fin.erreur && !fin.tue && fin.code === 0
    }));
  };
  // L'APP NE SURGIT JAMAIS POUR UNE CHAISE DE TERMINAL (round 1b) : une chaise
  // `cli` ou `exec` vit dans un terminal ; ouvrir l'app de bureau sur son fil
  // ferait surgir une fenêtre devant quelqu'un qui tape ailleurs (et peut-être
  // un second lecteur de la file). L'enveloppe reste en file et part au prochain
  // prompt du terminal. Seule une fiche `app`, ou sans porte, ouvre l'app.
  const chaiseDeBureau = !fiche.porte || fiche.porte === "app";
  const peutOuvrir = Boolean(ouvrirApp) && plateforme === "darwin" && chaiseDeBureau;
  // La grâce de la porte vaut pour chacun de ses enfants : `codex`, `lsappinfo` et `open`.
  const detecter = appOuverte || (() => appCodexOuverte({ lancer, delaiMs: reste(), graceMs, plateforme }));
  // La file a pris l'enveloppe : l'app s'ouvre sur le fil (B2) si elle est
  // FERMÉE — `false`, et lui seul ; ouverte ou inconnue, la file attend.
  const ouvrirSiFermee = async () => {
    if (!peutOuvrir) return { ok: true, mode: "queue" };
    if ((await detecterAuPlus(detecter, echeance - Date.now())) !== false) return { ok: true, mode: "queue" };
    const ouverture = await ouvrirLeFil();
    return ouverture.ok ? { ok: true, mode: "queue+open" } : { ok: true, mode: "queue", erreur: "open-impossible" };
  };

  const premiere = await frapper();
  const refus = refusDeLancement(premiere);
  if (refus) return refus;
  if (enFile(premiere)) return ouvrirSiFermee();
  if (!FIL_SANS_SESSION.test(premiere.sortie)) {
    return { ok: false, mode: null, erreur: "codex-refus", detail: detailDe(premiere) };
  }

  // LA RELANCE PAR L'UUID : une seule, avec la même enveloppe.
  const seconde = await frapper();
  const refusSecond = refusDeLancement(seconde);
  if (refusSecond) return refusSecond;
  if (enFile(seconde)) {
    // La file a pris l'enveloppe. Si la première frappe disait que personne ne
    // tenait le fil, on ouvre l'app dessus (B2) ; après un « sans tour », non.
    if (!peutOuvrir || !PERSONNE_NE_TIENT_LE_FIL.test(premiere.sortie)) return { ok: true, mode: "queue" };
    const ouverture = await ouvrirLeFil();
    // L'ouverture qui rate ne retire rien de la file : la lettre est sonnée, le
    // fil la recevra quand il s'ouvrira. `ok` reste vrai ; `erreur` le dit.
    return ouverture.ok ? { ok: true, mode: "queue+open" } : { ok: true, mode: "queue", erreur: "open-impossible" };
  }

  // La file refuse encore. Personne ne tient le fil : l'app s'ouvre dessus, et la
  // prochaine tournée y trouvera une session. Rien n'est en file : `ok: false`.
  const echec = { ok: false, mode: null, erreur: "codex-fil-sans-session", detail: detailDe(seconde) };
  if (!peutOuvrir || !PERSONNE_NE_TIENT_LE_FIL.test(seconde.sortie)) return echec;
  const ouverture = await ouvrirLeFil();
  return ouverture.ok ? { ...echec, mode: "open" } : { ...echec, ouverture: "open-impossible" };
}
