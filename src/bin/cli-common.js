// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// `parseArgs` (la lecture de la ligne de commande et sa grammaire) vit dans
// cli-args.js : la porte web l'importe sans le patron de sortie ci-dessous.
// Les binaires continuent d'importer d'ici.
export { parseArgs } from "./cli-args.js";

// Un drapeau donné SANS valeur (le dernier de la ligne, ou suivi d'un autre
// drapeau) devient `true` dans parseArgs — EXACTEMENT la même forme qu'un
// booléen voulu (--json, --help). parseArgs ne peut pas les distinguer : lui
// seul ne sait pas que --to n'est jamais booléen. Sans ce refus, `true`
// traverse jusqu'à SQLite et sort en stacktrace plutôt qu'en refus nommé
// (remède de la revue adverse #3, C7 — prouvé : `cc2cc-send --to X --body Y --msg-id`,
// dernier drapeau sans valeur, plantait ainsi ; même chose pour --to).
function refuserSiValeurManquante(args, key) {
  if (args[key] === true) {
    process.stderr.write(`Missing value for --${key.replace(/_/g, "-")} (the flag was given without a value)\n`);
    process.exit(2);
  }
}

export function requireArg(args, key) {
  refuserSiValeurManquante(args, key);
  if (!args[key]) {
    process.stderr.write(`Missing required --${key.replace(/_/g, "-")}\n`);
    process.exit(2);
  }
  return args[key];
}

// Le pendant FACULTATIF de requireArg : absent → undefined (silence, comme
// avant) ; donné SANS valeur → le même refus propre, jamais un `true` qui
// se propagerait en silence jusqu'à l'insertion.
export function optionalArg(args, key) {
  refuserSiValeurManquante(args, key);
  return args[key];
}

export function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

// ── UNE SEULE SORTIE (Run 6, Task 8 ; mise en commun, hygiène H2) ──────────
//
// `process.exit()` juste après une grosse écriture peut TRONQUER sur un tube
// (remède de la revue adverse #3, C6 ; prouvé : l'aide de valxos-chaise, 966 octets, arrivait
// coupée à 512). Le premier remède attendait le drain… et RENDAIT la main :
// un binaire fait de blocs successifs tombait alors dans le bloc suivant
// (valxos-chaise jusqu'à « Commande inconnue », facteur du one-shot dans le
// démon — Task 8, fix rounds 1 et 2).
//
// La structure, pas le symptôme : le guichet d'un binaire est UNE fonction qui
// rend un code (`return` après chaque commande) ; `sortir()` LÈVE une
// `Sortie` au lieu de rendre la main ; `executer()` est la seule sortie, et
// `terminer()` n'est appelé qu'une fois : il attend que stdout et stderr aient
// écrit tout ce qu'on leur a confié (le rappel d'une écriture vide arrive après
// les précédentes) avant `process.exit`. Ce patron vivait recopié mot pour mot
// dans valxos-chaise.js et facteur.js ; il vit ici, une fois.
export class Sortie extends Error {
  constructor(code, message) {
    super(message || "");
    this.code = code;
  }
}

export function sortir(code, message) {
  throw new Sortie(code, message);
}

export function terminer(code) {
  let restants = 2;
  const unDeMoins = () => {
    restants -= 1;
    if (restants === 0) process.exit(code);
  };
  process.stdout.write("", unDeMoins);
  process.stderr.write("", unDeMoins);
}

// Lance le guichet (synchrone ou async), traduit une `Sortie` en message sur
// stderr + code, et sort UNE fois. Une autre erreur n'est pas avalée : elle
// remonte telle quelle (pile, code 1), comme avant la mise en commun.
export async function executer(guichet) {
  let code;
  try {
    code = await guichet();
  } catch (erreur) {
    if (!(erreur instanceof Sortie)) throw erreur;
    if (erreur.message) process.stderr.write(`${erreur.message}\n`);
    code = erreur.code;
  }
  terminer(code);
}
