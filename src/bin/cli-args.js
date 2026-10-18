// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LA LECTURE DE LA LIGNE DE COMMANDE, SEULE — `parseArgs` et sa grammaire.
//
// Ce bloc vivait dans cli-common.js, à côté du patron de sortie. Il est séparé
// pour une raison d'import, pas de logique : le lanceur de la porte web
// (`valxos-web`) doit lire `-h`/`--help` et refuser un drapeau inconnu AVANT
// d'ouvrir quoi que ce soit (F3, revue finale, 18/10), et tout module que la
// porte charge passe sous la garde des lanceurs de la suite de tests, dont le
// détecteur lit les mots, commentaires compris : le nom français de la
// fonction de sortie de cli-common.js lui ressemble à un lancement de
// processus. Importer cli-common.js dans la porte aurait obligé à inscrire ce
// fichier aux exceptions de la garde (« une exception de fichier autorise TOUT
// ce que le fichier contiendra demain ») ou à desserrer son détecteur. Ce
// module-ci ne contient aucun lanceur : la porte l'importe tel quel, et
// cli-common.js le ré-exporte pour tous les autres binaires, qui n'ont rien à
// changer.
import fs from "node:fs";

// ÉCRIRE TOUT, PUIS SORTIR (C2, FIX-C, 18/10). `process.exit()` juste après
// `process.stdout.write()` coupait le texte sur un tube : sous macOS un tube est
// asynchrone, l'écriture part en deux temps et la sortie emporte le second —
// `valxos-chaise -h | wc -c` rendait 512 octets (parfois 1024) sur 1235, et le
// refus d'un drapeau inconnu 512 ou 1024 sur 1275. Attendre le rappel de
// l'écriture ne convient pas ici : `parseArgs` est SYNCHRONE, et ses appelants
// comptent sur le fait qu'il ne rend jamais la main après un refus ou une aide
// (rendre la main, c'était laisser `facteur --une-tourne` démarrer le démon).
// Le texte s'écrit donc EN ENTIER, de façon synchrone, avant la sortie.
//   · tant que `process.stdout` n'a pas été touché, le descripteur est celui que
//     le shell a donné : sur un tube il est bloquant, et l'écriture attend le lecteur ;
//   · si quelqu'un l'a déjà touché (donc passé en non bloquant) et que le tube est
//     plein (EAGAIN), on attend le lecteur deux millisecondes et on reprend, au
//     lieu de jeter le reste ;
//   · toute autre erreur (EPIPE : le lecteur est parti ; EBADF : pas de sortie) ne
//     laisse rien à sauver, et la sortie garde son code.
const PAUSE = new Int32Array(new SharedArrayBuffer(4));
function ecrireToutPuisSortir(descripteur, texte, code) {
  const octets = Buffer.from(texte, "utf8");
  let ecrits = 0;
  while (ecrits < octets.length) {
    try {
      ecrits += fs.writeSync(descripteur, octets, ecrits, octets.length - ecrits);
    } catch (erreur) {
      if (erreur.code !== "EAGAIN") break;
      Atomics.wait(PAUSE, 0, 0, 2);
    }
  }
  process.exit(code);
}

// "--clé=valeur" NE S'ARRÊTAIT NULLE PART (review interne, dernière vague) :
// cette fonction ne reconnaît que "--clé valeur" (espace-séparé) — un token
// "--from=alice" devenait une clé LITTÉRALE "from=alice" (le seul `.replace`
// ici touche les tirets, jamais le signe =) qui ne matchait plus JAMAIS
// "from", donc un refus posé sur `args.from` ne se déclenchait jamais pour
// cette orthographe-là. Pas un trou d'identité (la review a vérifié que
// chaque forme retombe sur la boîte du POSTEUR, jamais celle visée) — une
// autre orthographe qui esquive un refus voulu, un succès silencieux là où
// un refus nommé était attendu. Le refus vit ICI, avant toute ouverture de
// base, partagé par CHAQUE CLI qui appelle parseArgs — pas recopié par
// script comme le refus --from de valxos-inbox.js l'aurait été sinon.
// `booleans` (review interne, vague suivante — RÉGRESSION d'un correctif
// antérieur de facteur.js, historique privé) : SANS déclaration, un drapeau
// consomme le mot suivant dès qu'il ne commence pas par "--" — correct pour --to alpha, FAUX pour un
// drapeau purement booléen (--une-tournee, --silencieux) : `facteur
// --une-tournee BAREWORD` rendait `args.une_tournee = "BAREWORD"` (une
// chaîne), le test `=== true` de facteur.js échouait, et la ligne de
// commande basculait dans le démon SANS BORNE au lieu du one-shot demandé —
// reproduit, process tué par un garde-fou de 5 s, jamais rendu la main. Un
// nom listé ici ne consomme JAMAIS le mot suivant, quel qu'il soit ; défaut
// `[]`, donc RÉTROCOMPATIBLE — chaque appelant qui ne déclare rien garde
// exactement son ancien comportement.
//
// `known` (F7, passe adverse du Run 6, 28/09) : la liste des drapeaux que le
// bin lit (forme `snake_case`, les booléens compris). Un drapeau hors liste
// rend l'usage (`usage`) et sort 2 ICI, avant que le bin n'ouvre la base ou ne
// prenne un verrou : `facteur --une-tourne` (faute de frappe) démarrait le
// DÉMON. Sans `known`, l'ancien comportement (tout accepté) reste.
//
// N4 (seconde passe adverse, 28/09) : avec `known`, le TIRET SEUL et le MOT NU
// sont tranchés aussi. `-h` (ou `--help` quand le bin ne le lit pas) affiche
// l'usage et sort 0 ; tout autre `-x` est un drapeau inconnu (sortie 2) — et
// n'est jamais pris pour la valeur du drapeau précédent ; `positionals:
// false` refuse un mot nu (sortie 2). `facteur -h` et `facteur une-tournee`
// démarraient le démon ; `valxos-send --to bob -h` postait « -h ».
export function parseArgs(argv, { booleans = [], known = null, usage = "", positionals = true } = {}) {
  const boolSet = new Set(booleans);
  if (known) return parseArgsDeclares(argv, { boolSet, connus: new Set([...known, ...booleans]), usage, positionals });
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      out._.push(token);
      continue;
    }
    if (token.includes("=")) refuserLeSigneEgal(token, boolSet);
    const key = token.slice(2).replace(/-/g, "_");
    if (boolSet.has(key)) {
      out[key] = true;
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

// La revue adverse, en construisant la carte de couverture : le conseil disait « use --X
// VALUE (space-separated) » même pour un drapeau déclaré BOOLÉEN, qui
// n'attend jamais de valeur.
function refuserLeSigneEgal(token, boolSet) {
  const drapeau = token.slice(2).split("=")[0];
  const conseil = boolSet.has(drapeau.replace(/-/g, "_"))
    ? `--${drapeau} does not take a value; use --${drapeau} alone`
    : `use --${drapeau} VALUE (space-separated) instead`;
  ecrireToutPuisSortir(2, `--${drapeau}=... is not accepted; ${conseil}.\n`, 2);
}

// LA GRAMMAIRE DES DRAPEAUX DÉCLARÉS (N4, puis M1 de la troisième passe
// adverse, 28/09). Un jeton n'est lu comme drapeau qu'en POSITION de drapeau :
// après un drapeau à valeur (déclaré, non booléen), le jeton suivant est SA
// VALEUR, quoi qu'il ressemble — `--body "- milk"` et `--body "-h"` envoient
// ce corps-là (avant : « unknown flag », ou l'usage et une sortie 0 sans
// envoi). En position de drapeau : `-h` (ou `--help` quand le bin ne le lit
// pas) affiche l'usage et sort 0 ; un `--x` non déclaré, un `-x`, ou un mot nu
// quand `positionals: false`, sortent 2 avant que le bin n'ouvre quoi que ce
// soit. `--` termine les options : ce qui suit est positionnel.
// UNE exception, et elle est de sûreté : un jeton qui est EXACTEMENT un des
// drapeaux déclarés de ce bin (`--une-tournee`, `--to`…) n'est jamais pris pour
// une valeur — la valeur manque, et les refus existants le disent. Sans elle,
// `facteur --seulement-la-lettre --une-tournee` prenait « --une-tournee » pour
// l'identifiant de lettre, perdait le one-shot et démarrait le DÉMON.
function parseArgsDeclares(argv, { boolSet, connus, usage, positionals }) {
  const avecUsage = (ligne) => `${ligne}\n${usage ? `${usage.trimEnd()}\n` : ""}Nothing was done.\n`;
  const refuser = (ligne) => ecrireToutPuisSortir(2, avecUsage(ligne), 2);
  const cle = (token) => token.slice(2).replace(/-/g, "_");
  const aValeur = (token) => token.startsWith("--") && !token.includes("=") && connus.has(cle(token)) && !boolSet.has(cle(token));
  const estUnDrapeauDeclare = (token) => token !== undefined && token.startsWith("--") && !token.includes("=") && connus.has(cle(token));

  // L'aide d'abord, mais seulement en position de drapeau.
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--") break;
    if (token === "-h" || (token === "--help" && !connus.has("help"))) {
      ecrireToutPuisSortir(1, `${usage ? usage.trimEnd() : "usage: see the documentation"}\n`, 0);
    }
    if (aValeur(token) && i + 1 < argv.length && !estUnDrapeauDeclare(argv[i + 1])) i += 1;
  }

  const out = { _: [] };
  let finDesOptions = false;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!finDesOptions && token === "--") {
      finDesOptions = true;
      continue;
    }
    if (!finDesOptions && token.startsWith("--")) {
      if (token.includes("=")) refuserLeSigneEgal(token, boolSet);
      const key = cle(token);
      if (!connus.has(key)) refuser(`unknown flag: ${token}`);
      if (boolSet.has(key)) {
        out[key] = true;
      } else if (i + 1 < argv.length && !estUnDrapeauDeclare(argv[i + 1])) {
        out[key] = argv[i + 1];
        i += 1;
      } else {
        out[key] = true; // valeur absente : `optionalArg`/`requireArg` la refusent en la nommant
      }
      continue;
    }
    if (!finDesOptions && token.startsWith("-") && token !== "-") refuser(`unknown flag: ${token}`);
    if (positionals === false) refuser(`unexpected argument: ${token}`);
    out._.push(token);
  }
  return out;
}
