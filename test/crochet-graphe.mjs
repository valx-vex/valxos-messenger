// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LE CROCHET DE RÉSOLUTION — L'ORACLE, C'EST NODE LUI-MÊME.
//
// Pourquoi ce fichier existe. Le balayage de la garde n°1 suivait les imports
// avec une expression régulière :
//
//     /(?:from|import|require)\s*\(?\s*["'](\.[^"'\n]+)["']/g
//
// Elle exige un POINT LITTÉRAL après le guillemet. Or node ne lit pas des
// guillemets, il lit une CHAÎNE : `import { d } from "../lib/derob.js"` est
// résolu exactement comme `"../lib/derob.js"` — même module, même code chargé,
// même pouvoir. La regex, elle, ne voit rien. Mesuré le 22/08 : un module posant
// `execFileSync("/bin/sh", …)` chargé dans le processus de la porte, et la suite
// entière au vert, 598 pass / 0 fail.
//
// Une liste de motifs ne ferme jamais une classe : on peut toujours écrire la
// même chose autrement (échappement unicode, casse du chemin, `node:` explicite,
// résolution par `imports` du manifeste…). Il faut donc cesser de DEVINER ce que
// le code veut dire et demander à CELUI QUI SAIT. Un import que node résout est
// un import que node a vu, quelle que soit son orthographe.
//
// Le crochet est enregistré par `module.register()` (test/sonde-graphe.mjs) et
// tourne sur SON PROPRE FIL : il n'a ni la mémoire ni la sortie standard du
// processus principal. Il journalise donc dans un FICHIER — le seul canal qui
// traverse le fil sans cérémonie, et qui survit à un processus qui s'arrête net.
import { appendFileSync } from "node:fs";

let journal = null;

export function initialize(donnees) {
  journal = donnees?.journal || null;
}

export async function resolve(specificateur, contexte, suivant) {
  const resultat = await suivant(specificateur, contexte);
  // On ne note que ce qui est un FICHIER : `node:fs` et consorts ne sont pas
  // notre code, et les inclure ferait balayer tout node sans rien prouver.
  if (journal && typeof resultat?.url === "string" && resultat.url.startsWith("file:")) {
    appendFileSync(journal, `${resultat.url}\n`);
  }
  return resultat;
}
