// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
//
// N3 (seconde passe adverse du Run 6, 28/09) — LA MARCHE DE L'INCONNU EST
// AUTOMATISÉE. Sous npm 12, `npm i -g valxos-messenger` laissait un paquet qui
// plante à chaque commande, et rien ne le voyait avant un inconnu. La CI joue
// la marche entière : `npm pack`, installation globale npm 12 sur un préfixe et
// un HOME jetables avec `--allow-scripts=better-sqlite3`, `install --dry-run`,
// `install`, `valxos-doctor`, un `valxos-send`, un `valxos-inbox`, sur Node 22
// et 26. Le même script tourne en local (.github/scripts/stranger.sh).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repo = path.resolve(new URL("..", import.meta.url).pathname);

test("N3 — la CI a un job « stranger » qui joue la marche de l'inconnu sur Node 22 et 26", () => {
  const flux = fs.readFileSync(path.join(repo, ".github/workflows/tests.yml"), "utf8");
  const job = flux.slice(flux.search(/^  stranger:/m));
  assert.ok(flux.search(/^  stranger:/m) > 0, "le job stranger existe");
  assert.match(job, /node: \[22, 26\]/);
  assert.match(job, /\.github\/scripts\/stranger\.sh/);
  const script = fs.readFileSync(path.join(repo, ".github/scripts/stranger.sh"), "utf8");
  for (const geste of ["npm pack", "npm@12", "--allow-scripts=better-sqlite3", "--prefix", "valxos-messenger install --dry-run",
    "valxos-messenger install", "valxos-doctor", "valxos-send", "valxos-inbox", "CC2CC_V2_HOME"]) {
    assert.ok(script.includes(geste), `le script joue : ${geste}`);
  }
  assert.ok(fs.statSync(path.join(repo, ".github/scripts/stranger.sh")).mode & 0o111, "le script est exécutable");
});

// Revue finale (28/09), « tests les plus faibles » n°1 : la garde ci-dessus ne
// fait que lire deux fichiers. Celle-ci JOUE la marche — lente et réseau (npm
// 12 téléchargé), donc en quarantaine sauf `VALXOS_TESTS_LENTS=1` ; le job CI
// `stranger` joue le même script à chaque poussée.
import { spawnSync } from "node:child_process";
import os from "node:os";
import { quarantaine } from "./aide-quarantaine.js";

test("N3 — la marche de l'inconnu tourne vraiment et finit verte", quarantaine("RUN6-Q3", "lent et réseau : installation npm 12 globale", !process.env.VALXOS_TESTS_LENTS), () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-stranger-"));
  const r = spawnSync(path.join(repo, ".github/scripts/stranger.sh"), [repo, scratch], { encoding: "utf8", timeout: 600_000 });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /STRANGER WALK GREEN/);
});
