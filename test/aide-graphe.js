// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// ── LE VIVIER DE LA GARDE N°1 : CE QUE NODE CHARGE, PAS CE QU'UNE REGEX LIT ──
//
// Ce fichier ne porte AUCUN test, et son nom ne finit pas par `.test.js` : c'est
// délibéré (même raison que `aide-porte.js` — `garde-bureau.test.js` rejoue tout
// ce qui porte ce suffixe).
//
// ── CE QU'IL REMPLACE ────────────────────────────────────────────────────────
//
// Deux fichiers de la garde recopiaient le MÊME marcheur de graphe, écrit à la
// main :
//
//     /(?:from|import|require)\s*\(?\s*["'](\.[^"'\n]+)["']/g
//
// Il exige un POINT LITTÉRAL après le guillemet. Mesuré le 22/08, sur le vrai
// dépôt : `import { d } from "../lib/derob.js"` est résolu par node
// exactement comme `"../lib/derob.js"` — le module entre dans le processus de la
// porte avec son `execFileSync("/bin/sh", …)`, la regex ne le voit pas, il
// n'entre jamais dans le vivier, et la suite reste verte : 598 pass / 0 fail.
//
// Allonger la regex n'aurait rien fermé. Ce qui l'a écrite peut l'écrire
// autrement — concaténation, casse du chemin, indirection par le manifeste. LA
// DOCTRINE EST DONC AILLEURS : on cesse de deviner ce que le code veut dire, et
// on demande à celui qui SAIT. Le résolveur de node EST l'oracle.
//
// ── CE QUI RESTE, ET POURQUOI LES DEUX ENSEMBLES S'ADDITIONNENT ──────────────
//
// La descente de répertoire dans `src/web/` NE DISPARAÎT PAS. Un fichier posé là
// et pas encore importé — une source oubliée, un module écrit hier et branché
// demain — doit être vu quand même ; et la page, le style, les polices ne sont
// importés par personne et se servent pourtant. Les deux ensembles se
// COMPLÈTENT : ce que node charge, plus ce que le répertoire contient.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { envPropre } from "./aide-env.js";

// Les graines : par où la porte commence à exister. Le lanceur est en DERNIER —
// c'est le seul qui s'arrête net (voir sonde-graphe.mjs).
export const GRAINES = [
  path.join("src", "web", "serveur.js"),
  path.join("src", "web", "auth.js"),
  path.join("src", "bin", "valxos-web.js")
];

// LES ANCRES — le chemin EXACT que la passe adverse du 22/08 a mesuré
// (serveur → guichet → round → postbox, deux processus lancés par un seul
// `POST /api/poster`). Si le journal du crochet ne les contient pas, ce n'est
// pas « un graphe un peu court » : c'est une SONDE IMPOSSIBLE, et l'appelant
// doit rougir. Un journal vide rendrait la garde verte pour la pire des raisons.
export const ANCRES_DU_GRAPHE = [
  "src/web/serveur.js",
  "src/web/auth.js",
  "src/bin/valxos-web.js",
  "src/lib/guichet.js",
  "src/facteur/round.js",
  "src/lib/postbox.js",
  "src/lib/config.js"
];

// CE QUE LE SOUS-PROCESSUS COÛTE, MESURÉ (22/08, sept tirs sur ce Mac) :
// 105, 101, 106, 101, 101, 103, 100 ms — médiane 101 ms, lancement du node
// appelant COMPRIS. Une seule fois par fichier de test, le résultat étant
// mémorisé ci-dessous ; deux fichiers de garde s'en servent, donc ~0,2 s sur une
// suite qui tourne entre 15 et 50 s selon la charge de la machine.
// Un test que personne ne lance plus est un test mort : le prix est dit, et il
// est petit. S'il grossissait un jour, la sortie à couper est le lanceur (la
// seule graine qui exécute quelque chose), pas le crochet.
let memo = null;

// LE JOURNAL DE CE QUE NODE A RÉSOLU, rendu en chemins RELATIFS à la racine du
// dépôt, triés. Trois issues : conforme, incohérence, ou sonde impossible —
// cette dernière est rendue telle quelle dans `.probleme`, jamais silencieuse.
export function grapheCharge(racine) {
  if (memo) return memo;

  const bureau = fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-graphe-"));
  const journal = path.join(bureau, "resolus.txt");
  fs.writeFileSync(journal, "");
  try {
    const issue = spawnSync(
      process.execPath,
      [path.join(racine, "test", "sonde-graphe.mjs"), journal, ...GRAINES.map((g) => path.join(racine, g))],
      {
        cwd: racine,
        encoding: "utf8",
        timeout: 60_000,
        env: {
          ...envPropre(),
          // Un plancher jetable : la sonde ne touche JAMAIS le bureau vivant.
          CC2CC_V2_HOME: bureau,
          // Le lanceur refuse cet hôte et sort en 2 — après que node a résolu
          // tout le graphe, et avant d'ouvrir quoi que ce soit. C'est une garde
          // du PRODUIT qui l'arrête, pas un décor qui le contourne.
          CC2CC_WEB_HOTE: "0.0.0.0"
        }
      }
    );

    const lignes = fs
      .readFileSync(journal, "utf8")
      .split("\n")
      .map((ligne) => ligne.trim())
      .filter(Boolean);

    const fichiers = new Set();
    for (const url of lignes) {
      let absolu;
      try {
        absolu = fs.realpathSync(new URL(url).pathname);
      } catch {
        continue;
      }
      const relatif = path.relative(racine, absolu);
      // Hors du dépôt, ou dans les dépendances : ce n'est pas notre code, et
      // balayer tout npm ne prouverait rien.
      if (relatif.startsWith("..") || path.isAbsolute(relatif)) continue;
      if (relatif.split(path.sep).includes("node_modules")) continue;
      fichiers.add(relatif);
    }

    memo = {
      fichiers: [...fichiers].sort(),
      // De quoi écrire un message d'échec qui dit ce qui s'est passé, pas
      // seulement qu'il s'est passé quelque chose.
      probleme: issue.error ? String(issue.error.message) : null,
      code: issue.status,
      stderr: String(issue.stderr || "").slice(-2000)
    };
    return memo;
  } finally {
    fs.rmSync(bureau, { recursive: true, force: true });
  }
}
