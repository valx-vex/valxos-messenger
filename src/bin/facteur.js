#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LE GUICHET DU FACTEUR — le point d'entrée.
//
//   node src/bin/facteur.js --une-tournee     une seule tournée, puis le bilan
//   node src/bin/facteur.js                   le démon : tournée, sommeil, tournée
//   node src/bin/facteur.js --tours 3         un nombre borné de tournées
//   node src/bin/facteur.js --maisons a:b     l'inventaire des maisons à servir
//   node src/bin/facteur.js --seulement-la-lettre L42   CELLE-CI, et rien d'autre
//
// Le bilan part sur la sortie STANDARD (du JSON, pour être lu par un banc), le
// journal sur la sortie d'ERREUR (du NDJSON, une ligne par événement). Ni l'un
// ni l'autre ne contient jamais le corps d'une lettre.
//
// Les codes de sortie : 0 la tournée a eu lieu · 2 la ligne de commande est
// refusée (on n'a PAS démarré) · 3 un autre Facteur tenait le verrou · 4 le mode
// une-lettre n'a rien pris (rouge visible, jamais un silence à zéro).
import path from "node:path";

import { maisonsConnues, reglagesDuFacteur } from "../lib/config.js";
import { openDatabase } from "../lib/database.js";
import { demarrerLeFacteur, journalNdjson } from "../facteur/daemon.js";
import { faireLaTournee, tourneeBougee } from "../facteur/round.js";
import { Sortie, executer, optionalArg, parseArgs } from "./cli-common.js";

// UNE SEULE SORTIE : `principal()` rend un code (`return` après le refus,
// après le one-shot, après le démon), `Sortie` remplace les `process.exit()`
// du milieu, et `executer()` sort une fois, après le drain de stdout et
// stderr. Le patron et son histoire (Task 8, fix round 2 : le one-shot qui
// tombait dans le DÉMON derrière un lecteur de stderr lent) vivent dans
// cli-common.js.

// LE PARSEUR PARTAGÉ, ENFIN (review interne, MOYEN) : ce fichier avait sa
// PROPRE boucle de lecture d'options (mots EXACTS,
// `mot === "--seulement-la-lettre"`), donc "--seulement-la-lettre=L42" ne
// matchait AUCUNE branche et disparaissait en silence : `filtreDemande`
// restait faux, la garde plus bas (« un filtre sans identifiant porterait
// tout le courrier ») ne voyait rien à refuser, et la tournée portait TOUT
// le courrier plutôt que la seule lettre demandée — preuve reproduite avant
// ce remède, --seulement-la-lettre=L2 sur trois lettres dues en carriait
// trois. Même défaut pour --tours=3 (restait Infinity, démon sans borne —
// reproduit aussi, exit par timeout) et --silencieux=x (revue adverse, sans danger
// mais même trou). `parseArgs` refuse maintenant tout token "--clé=valeur"
// AVANT que ce fichier ne voie quoi que ce soit.
// ⚠️ « le SEUL des sept binaires » (ma propre phrase, un correctif antérieur) était
// FAUSSE : valxos-peers.js avait le même trou par une autre porte
// (`args.includes("--all")` sur l'argv brut, routé dans la même vague que
// celle-ci) — je ne l'avais pas vérifié avant d'écrire « seul ». valxos-doctor.js
// ne lit vraiment aucun drapeau, donc n'était concerné par aucune des deux
// formes — mais ça ne veut PAS dire que le reste était audité : valxos-chaise.js
// avait la MÊME classe de trou pour --json/--help (revue adverse, en construisant la
// carte de couverture qu'aucun de nous n'avait faite), invisible à tous les
// tests existants parce qu'ils mettent --json en dernier. La phrase juste,
// vérifiée une par une : valxos-peers.js et valxos-chaise.js ont reçu le même
// remède que ce fichier ; valxos-doctor.js n'avait rien à recevoir. Aucune
// affirmation de compte total sur les sept — celle-là s'est trompée deux fois
// aujourd'hui, ça suffit. L'historique ne se réécrit pas (le correctif antérieur,
// dans l'historique privé, garde sa phrase fausse) ; ce commentaire-ci, vivant,
// la corrige.
//
// --une-tournee et --silencieux sont déclarés BOOLÉENS (voir cli-common.js)
// pour la même raison que la garde ci-dessus existe : sans cette
// déclaration, `facteur --une-tournee BAREWORD` lit BAREWORD comme la
// VALEUR de --une-tournee (une chaîne, jamais `true`), le test `=== true`
// échoue, et la ligne de commande bascule dans le démon SANS BORNE au lieu
// du one-shot demandé — régression du premier passage de ce remède,
// reproduite (process tué par un garde-fou de test, jamais rendu la main),
// refermée à la racine plutôt que patchée localement ici.
const USAGE_DU_FACTEUR = `usage: facteur [--une-tournee] [--tours N] [--maisons a:b] [--seulement-la-lettre ID] [--silencieux]
  (no flag: the daemon, which takes run/facteur.verrou and carries real mail)`;

function lireLesOptions(argv) {
  const args = parseArgs(argv, {
    booleans: ["une_tournee", "silencieux"],
    known: ["tours", "maisons", "seulement_la_lettre"],
    positionals: false,
    usage: USAGE_DU_FACTEUR
  });

  const uneTournee = args.une_tournee === true;
  const silencieux = args.silencieux === true;

  // --tours SANS valeur retombait sur Number(undefined) = NaN, en silence :
  // `faites < NaN` est toujours faux, donc le démon se déclarait hors
  // service sans avoir fait une seule tournée — un silence différent, mais
  // un silence quand même. optionalArg refuse proprement au lieu de deviner
  // (même remède que --limit sur cc2cc-inbox, revue adverse #3, C7). Et --tours
  // NON-NUMÉRIQUE (--tours abc) retombait sur le MÊME NaN par une porte
  // différente — reproduit, {parti:true, tours:0} sortait comme un succès :
  // une faute de frappe démarrait le démon, il ne tournait jamais, et
  // rapportait que tout allait bien.
  const toursBrut = optionalArg(args, "tours");
  let tours = Infinity;
  if (toursBrut !== undefined) {
    tours = Number(toursBrut);
    if (Number.isNaN(tours)) {
      throw new Sortie(2, `--tours must be a number (got ${JSON.stringify(toursBrut)})`);
    }
  }

  // --maisons SANS valeur retombait sur "".split(délimiteur).filter(Boolean)
  // = [] — un tableau VIDE, mais VRAI en JS : `options.maisons || maisonsConnues()`
  // gardait ce [] plutôt que de retomber sur la liste connue, et la tournée
  // servait ZÉRO maison en silence. Même remède.
  const maisonsBrut = optionalArg(args, "maisons");
  const maisons = maisonsBrut
    ? String(maisonsBrut)
        .split(path.delimiter)
        .map((maison) => maison.trim())
        .filter(Boolean)
    : null;

  // --seulement-la-lettre GARDE sa forme dédiée : présent SANS valeur (le
  // dernier mot de la ligne, ou avalé par le drapeau suivant) doit rendre
  // filtreDemande vrai ET seulementLaLettre null, pour que LE REFUS JSON
  // PROPRE À CE FICHIER (plus bas, « seulement-la-lettre-sans-identifiant »)
  // se déclenche — c'est LUI le garde-fou qui compte ici, structuré et
  // journalisé, pas le message générique « Missing value » de optionalArg.
  const seulementBrut = args.seulement_la_lettre;
  const filtreDemande = seulementBrut !== undefined;
  const seulementLaLettre = typeof seulementBrut === "string" ? seulementBrut.trim() || null : null;

  return { uneTournee, tours, maisons, silencieux, seulementLaLettre, filtreDemande };
}

async function principal() {
  const options = lireLesOptions(process.argv.slice(2));

  // Un filtre demandé sans identifiant n'est pas un filtre : on ne part PAS. Rien
  // n'est ouvert, rien n'est pris — le refus arrive avant le bureau de poste.
  if (options.filtreDemande && !options.seulementLaLettre) {
    process.stderr.write(
      `${JSON.stringify({
        evenement: "facteur_refus",
        motif: "seulement-la-lettre-sans-identifiant",
        detail: "--seulement-la-lettre requires a letter id: without it, the round would carry ALL the mail"
      })}\n`
    );
    return 2;
  }

  const journal = options.silencieux ? () => {} : journalNdjson;
  const maisons = options.maisons || maisonsConnues();
  const db = openDatabase();

  if (options.uneTournee) {
    const bilan = await faireLaTournee(db, { maisons, journal, seulementLaLettre: options.seulementLaLettre });
    // Un one-shot n'a pas de battement : sa tournée se dit TOUJOURS au journal,
    // même muette — un stderr vide ressemblerait à un job launchd cassé.
    if (!tourneeBougee(bilan)) journal({ evenement: "facteur_tournee", ...bilan });
    process.stdout.write(`${JSON.stringify(bilan)}\n`);
    db.close();
    // Le mode une-lettre qui n'a rien pris rend un ROUGE VISIBLE : un identifiant
    // mal recopié ne doit pas ressembler à une tournée tranquille.
    return options.seulementLaLettre && bilan.prises === 0 ? 4 : 0;
  }

  // L'arrêt propre : le verrou se relâche, la tournée en cours se termine. Une
  // tentative interrompue n'est pas une lettre perdue — son bail expire et la
  // lettre repart (A9).
  const arret = new AbortController();
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      journal({ evenement: "facteur_rappele", signal });
      arret.abort();
    });
  }

  const resultat = await demarrerLeFacteur({
    db,
    tours: options.tours,
    signal: arret.signal,
    journal,
    depsDeTournee: { maisons, seulementLaLettre: options.seulementLaLettre },
    reglages: reglagesDuFacteur()
  });
  process.stdout.write(`${JSON.stringify(resultat)}\n`);
  db.close();
  return resultat.parti ? 0 : 3;
}

await executer(principal);
