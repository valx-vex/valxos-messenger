// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LE DÉMON — le Facteur qui repart en tournée, encore et encore.
//
// Deux choses seulement vivent ici : le VERROU (un seul Facteur en tournée par
// machine) et la BOUCLE (une tournée, un sommeil, une tournée). Toute la
// mécanique du courrier est dans `round.js` — ce fichier ne sait rien des
// lettres, et c'est voulu : on doit pouvoir le lire en trente secondes avant de
// décider de l'arrêter.
//
// ⚠️ Le verrou n'est PAS la garde contre les doublons. Deux Facteurs sur deux
// machines, ou un verrou perdu, restent possibles : ce qui départage vraiment
// deux porteurs, c'est l'index unique partiel de `facteur_attempts` (une seule
// tentative active par lettre) et le bail. Le verrou évite le travail inutile,
// il ne tient aucun invariant. Ne jamais inverser ces deux rôles.
//
// ⚠️ Un verrou tenu par un mort n'est pas un verrou. Sans reprise, un Facteur
// tué par un couperet laisserait le courrier sans porteur POUR TOUJOURS — un
// silence qui viole A9 aussi sûrement qu'une lettre effacée.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { nowIso, reglagesDuFacteur, runtimePaths, verifierLesReglages } from "../lib/config.js";
import { getDatabase } from "../lib/database.js";
import { isProcessAlive, procStartOf } from "../lib/postbox.js";
import { tourneeBougee, faireLaTournee as faireLaTourneeReelle } from "./round.js";

export function cheminDuVerrou() {
  return path.join(runtimePaths().run, "facteur.verrou");
}

// ⚠️ « ABSENT » ET « ILLISIBLE » SONT DEUX SITUATIONS. Les confondre, c'est la
// course mesurée du 13/08 : trois démons lancés ensemble, DEUX partis, six essais
// sur six. Un concurrent lisait un verrou vide, en concluait « personne », et
// effaçait le verrou du tenant pour poser le sien. Un verrou qu'on ne sait pas
// lire est un verrou TENU jusqu'à preuve du contraire — et cette preuve n'existe
// pas, donc on ne vole pas.
export function etatDuVerrou(chemin) {
  let brut;
  try {
    brut = fs.readFileSync(chemin, "utf8");
  } catch (erreur) {
    if (erreur?.code === "ENOENT") return { present: false, illisible: false, tenant: null };
    return { present: true, illisible: true, tenant: null };
  }
  try {
    return { present: true, illisible: false, tenant: JSON.parse(brut) };
  } catch {
    return { present: true, illisible: true, tenant: null };
  }
}

export function lireLeVerrou(chemin) {
  return etatDuVerrou(chemin).tenant;
}

// Le journal du Facteur : NDJSON sur la sortie d'erreur. JAMAIS un corps de
// lettre — on porte le courrier des autres, on n'en répète rien (le Facteur
// DOIT le lire pour plier l'enveloppe ; c'est le journal qui n'en garde rien,
// voir round.js).
export function journalNdjson(ligne) {
  try {
    process.stderr.write(`${JSON.stringify({ ts: nowIso(), ...ligne })}\n`);
  } catch {
    /* un journal qui n'écrit pas ne fait pas rater une tournée */
  }
}

// ⚠️ UN NUMÉRO DE PROCESSUS SE RECYCLE. Le système en réattribue un tous les
// jours, et un verrou qui ne connaît QUE le numéro prend alors le premier
// inconnu venu pour un Facteur vivant : le courrier s'arrête POUR TOUJOURS,
// sous launchd en boucle de respawn, sans un mot. C'est exactement le défaut que
// la tournée a corrigé pour les boîtes aux lettres — l'heure de démarrage EN
// PLUS du numéro — et le verrou mérite le même remède.
//
// Le doute profite toujours au tenant : verrou d'avant ce remède (sans heure),
// ou heure illisible, on ne vole PAS le verrou. Voler à tort, c'est deux
// Facteurs ; refuser à tort, c'est une tournée de retard.
function tenantRecycle(tenant, heureDeDemarrage) {
  const inscrite = tenant?.proc_start ? String(tenant.proc_start) : "";
  if (!inscrite) return false;
  const vivante = heureDeDemarrage(Number(tenant.pid));
  if (!vivante) return false;
  return String(vivante) !== inscrite;
}

export function prendreLeVerrou(
  chemin,
  { pid = process.pid, estVivant = isProcessAlive, heureDeDemarrage = procStartOf } = {}
) {
  fs.mkdirSync(path.dirname(chemin), { recursive: true });
  const naissance = heureDeDemarrage(pid) || null;
  // ⚠️ LE VERROU NAÎT COMPLET. Créer le fichier PUIS l'écrire laisse, entre les
  // deux, un verrou qui EXISTE et qui est VIDE — et un concurrent qui le lit
  // conclut « personne ». La fenêtre n'est pas théorique : l'appel à /bin/ps
  // juste au-dessus (`heureDeDemarrage`, ~15 ms) synchronise tous les
  // concurrents PILE dessus. Mesuré : trois démons ensemble, deux partis, 6/6.
  //
  // Le contenu s'écrit donc dans un brouillon, et le brouillon prend son nom
  // définitif par un lien DUR : `link` est atomique et REFUSE d'écraser — c'est
  // l'exclusion mutuelle et la naissance complète dans le même geste.
  const poser = () => {
    const brouillon = path.join(path.dirname(chemin), `.facteur.verrou.${crypto.randomUUID()}`);
    try {
      fs.writeFileSync(brouillon, `${JSON.stringify({ pid, proc_start: naissance, depuis: nowIso() })}\n`, {
        mode: 0o600
      });
      try {
        fs.linkSync(brouillon, chemin);
        return true;
      } catch (erreur) {
        if (erreur?.code !== "EEXIST") throw erreur;
        return false;
      }
    } finally {
      // Un brouillon ne survit jamais à sa tentative : il ne verrouille rien et
      // personne ne le lit.
      try {
        fs.unlinkSync(brouillon);
      } catch {
        /* déjà parti */
      }
    }
  };
  const jeton = {
    chemin,
    pid,
    procStart: naissance,
    relacher() {
      const tenant = lireLeVerrou(chemin);
      // On ne relâche que SON PROPRE verrou : effacer celui d'un autre serait
      // ouvrir la porte à deux Facteurs. Et « le sien », c'est le numéro ET
      // l'heure de naissance : un successeur qui hérite du numéro n'hérite pas
      // du verrou.
      if (tenant && Number(tenant.pid) !== Number(pid)) return false;
      if (tenant?.proc_start && naissance && String(tenant.proc_start) !== String(naissance)) return false;
      try {
        fs.unlinkSync(chemin);
        return true;
      } catch {
        return false;
      }
    }
  };

  if (poser()) return jeton;
  const etat = etatDuVerrou(chemin);
  // Un verrou illisible (vide, tronqué, corrompu) n'est PAS une place libre.
  // Voler ici, c'est deux Facteurs en tournée ; attendre, c'est une tournée de
  // retard. Le doute profite au tenant, comme pour l'heure de naissance.
  if (etat.illisible) return null;
  const tenant = etat.tenant;
  if (tenant?.pid && estVivant(Number(tenant.pid)) && !tenantRecycle(tenant, heureDeDemarrage)) return null;
  try {
    fs.unlinkSync(chemin);
  } catch {
    /* quelqu'un l'a repris entre-temps : le second essai tranchera */
  }
  return poser() ? jeton : null;
}

export function sommeil(ms, signal = null) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const minuteur = setTimeout(fini, ms);
    function fini() {
      clearTimeout(minuteur);
      signal?.removeEventListener?.("abort", fini);
      resolve();
    }
    signal?.addEventListener?.("abort", fini, { once: true });
  });
}

export async function demarrerLeFacteur(options = {}) {
  const {
    db = null,
    verrou = cheminDuVerrou(),
    tours = Infinity,
    signal = null,
    journal = journalNdjson,
    depsDeTournee = {},
    reglages = {},
    attendre = sommeil,
    horloge = () => Date.now(),
    faireLaTournee = faireLaTourneeReelle,
    prendreLeVerrou: prendreLeVerrouInjecte = prendreLeVerrou
  } = options;

  // Un réglage incohérent se refuse AU DÉMARRAGE, jamais à la première lettre.
  const complets = verifierLesReglages({ ...reglagesDuFacteur(), ...reglages });

  // LE BUREAU S'OUVRE AVANT QUE LE VERROU NE NAISSE. L'ordre inverse laissait
  // un verrou ORPHELIN sur le disque dès que l'ouverture ratait — et elle rate
  // pour de bon : sous la garde du bureau vivant (`CC2CC_GARDE_BUREAU`), un
  // démon visant le vrai bureau posait son verrou, PUIS se faisait refuser le
  // broker, et le verrou restait au sol SUR LE BUREAU REFUSÉ (mesuré le 21/08 :
  // `run/facteur.verrou` présent après le refus). Même défaut pour toute autre
  // ouverture qui échoue — disque plein, base corrompue, permissions : le
  // `getDatabase()` était HORS du try/finally qui relâche.
  //
  // L'inversion est sans prix : ouvrir la base n'exclut personne (WAL, plusieurs
  // lecteurs-écrivains), donc un second Facteur qui n'obtiendra pas le verrou
  // n'aura fait qu'ouvrir un fichier pour rien — et le point d'entrée réel
  // (`src/bin/facteur.js`) ouvrait DÉJÀ la base avant d'appeler ici. Le verrou,
  // lui, ne peut pas être idempotent : c'est justement son rôle.
  const bureau = db || getDatabase();

  const jeton = prendreLeVerrouInjecte(verrou);
  if (!jeton) {
    journal({ evenement: "facteur_deja_en_tournee", verrou });
    return { parti: false, tours: 0 };
  }

  let faites = 0;
  try {
    journal({
      evenement: "facteur_en_service",
      pid: process.pid,
      tournee_chaque_ms: complets.tourneeChaqueMs,
      battement_chaque_ms: complets.battementChaqueMs
    });
    // Le battement : les tournées vides ne s'écrivent plus (round.js), alors le
    // démon prouve qu'il vit à intervalle régulier, en disant combien de
    // tournées sont restées muettes depuis le dernier battement.
    let tourneesSilencieuses = 0;
    let dernierBattement = horloge();
    while (faites < tours && !signal?.aborted) {
      const bilan = await faireLaTournee(bureau, { ...depsDeTournee, reglages: complets, journal });
      faites += 1;
      if (!(bilan && tourneeBougee(bilan))) tourneesSilencieuses += 1;
      const maintenant = horloge();
      if (maintenant - dernierBattement >= complets.battementChaqueMs) {
        journal({ evenement: "facteur_battement", tournees_silencieuses: tourneesSilencieuses });
        tourneesSilencieuses = 0;
        dernierBattement = maintenant;
      }
      if (faites < tours && !signal?.aborted) await attendre(complets.tourneeChaqueMs, signal);
    }
    // Le dernier segment de vie ne se perd pas : les tournées muettes
    // accumulées depuis le dernier battement se disent AVANT la sortie.
    if (tourneesSilencieuses > 0) {
      journal({ evenement: "facteur_battement", tournees_silencieuses: tourneesSilencieuses });
    }
  } finally {
    jeton.relacher();
    journal({ evenement: "facteur_hors_service", tours: faites });
  }
  return { parti: true, tours: faites };
}
