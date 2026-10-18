// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// UNE QUARANTAINE SANS RAISON NOMMÉE N'EXISTE PAS (Run 6, tâche 1).
//
// Un test qu'on ne peut pas jouer ici (il exige tailscale, une maison Claude,
// ce nom d'hôte) ou qui est trop lent pour la suite de cinq minutes se met en
// quarantaine — jamais il ne s'efface. La quarantaine porte un tag
// `RUN6-Q<n>` et une raison d'une ligne, et chaque tag a sa ligne dans
// `docs/QUARANTAINE.md` (fichier, raison, comment la lever). Ce test est la
// garde de cette règle : un skip muet ou orphelin de son registre est ROUGE.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { quarantaine } from "./aide-quarantaine.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("chaque quarantaine porte un tag RUN6-Q<n> inscrit au registre et une raison d'une ligne", () => {
  const registre = fs.readFileSync(path.join(repo, "docs", "QUARANTAINE.md"), "utf8");
  for (const f of fs.readdirSync(path.join(repo, "test")).filter((n) => n.endsWith(".test.js") && n !== "quarantaine.test.js")) {
    const texte = fs.readFileSync(path.join(repo, "test", f), "utf8");
    assert.equal(
      (texte.match(/quarantaine\(/g) || []).length,
      [...texte.matchAll(/quarantaine\(\s*["'`]RUN6-Q\d+["'`]\s*,\s*["'`][^"'`]{8,}/g)].length,
      `${f} : une quarantaine sans tag ou sans raison`
    );
    for (const m of texte.matchAll(/quarantaine\(\s*["'`](RUN6-Q\d+)["'`]\s*,\s*(["'`][^"'`]{8,}["'`])/g)) {
      assert.ok(registre.includes(m[1]), `${f} : ${m[1]} absent de docs/QUARANTAINE.md`);
    }
  }
  assert.throws(() => quarantaine("RUN6-Q1", ""), /raison/);
  assert.throws(() => quarantaine("", "une raison assez longue"), /tag/);
});

test("quarantaine() rend l'option `skip` de node:test quand la condition tient, rien sinon", () => {
  assert.deepEqual(quarantaine("RUN6-Q1", "exige un démon absent ici", false), {});
  assert.deepEqual(quarantaine("RUN6-Q1", "exige un démon absent ici"), { skip: "QUARANTAINE RUN6-Q1 — exige un démon absent ici" });
});

test("le registre ne porte que des tags qui existent encore dans la suite — une levée s'y voit", () => {
  const registre = fs.readFileSync(path.join(repo, "docs", "QUARANTAINE.md"), "utf8");
  const inscrits = new Set([...registre.matchAll(/^\|\s*(RUN6-Q\d+)\s*\|/gm)].map((m) => m[1]));
  const utilises = new Set();
  for (const f of fs.readdirSync(path.join(repo, "test")).filter((n) => n.endsWith(".test.js") && n !== "quarantaine.test.js")) {
    for (const m of fs.readFileSync(path.join(repo, "test", f), "utf8").matchAll(/quarantaine\(\s*["'`](RUN6-Q\d+)["'`]/g)) utilises.add(m[1]);
  }
  for (const tag of inscrits) assert.ok(utilises.has(tag), `${tag} est au registre mais plus dans la suite : déplace sa ligne dans « Levées »`);
});

// Verdict du 18/10 : la prose disait « the two quarantines above » quand le
// tableau en listait trois. Le compte de la prose se lit dans le tableau.
test("la prose du registre compte ses quarantaines comme le tableau les liste", () => {
  const registre = fs.readFileSync(path.join(repo, "docs", "QUARANTAINE.md"), "utf8");
  const debut = registre.indexOf("## Active");
  const fin = registre.indexOf("\n## ", debut + 1);
  assert.ok(debut >= 0 && fin > debut, "sonde impossible : la section Active du registre est introuvable");
  const inscrites = [...registre.slice(debut, fin).matchAll(/^\|\s*(RUN6-Q\d+)\s*\|/gm)].length;
  const MOTS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
  assert.ok(inscrites >= 1 && inscrites < MOTS.length, `sonde impossible : ${inscrites} quarantaine(s) lue(s) dans le tableau`);
  const prose = registre.replace(/\s+/g, " ");
  assert.ok(prose.includes(`of the ${MOTS[inscrites]} quarantines above`), `la prose dit « the ${MOTS[inscrites]} quarantines above » (${inscrites} dans le tableau)`);
  assert.doesNotMatch(prose, /\bThe two quarantines above\b/, "plus de compte périmé");
});

// Un skip qui contourne quarantaine() — `t.skip(…)` dans le corps, ou
// `{ skip: … }` écrit à la main — est un skip sans tag ni registre. Mesuré le
// 27/09 : deux vivaient dans la suite (plutil absent sous Linux, chemin de
// socket trop long), la CI en comptait un sans que personne ne le voie.
test("aucun skip ne contourne quarantaine() — ni t.skip(), ni { skip: } écrit à la main", () => {
  for (const f of fs.readdirSync(path.join(repo, "test")).filter((n) => n.endsWith(".test.js") && n !== "quarantaine.test.js")) {
    const lignes = fs.readFileSync(path.join(repo, "test", f), "utf8").split("\n");
    lignes.forEach((ligne, i) => {
      assert.doesNotMatch(ligne, /\bt\.skip\(|[{,]\s*skip\s*:/, `${f}:${i + 1} : un skip hors quarantaine() — donne-lui un tag RUN6-Q<n> et sa ligne au registre`);
    });
  }
});
