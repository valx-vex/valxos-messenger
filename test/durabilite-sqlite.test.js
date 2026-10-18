// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LA DURABILITÉ EFFECTIVE DE SQLITE — MESURÉE, PAS GREPPÉE.
//
// rev-t8 (29/08/2026) : une correction du README a déclaré « `synchronous=NORMAL`
// était une affirmation fausse » parce qu'aucun pragma de ce nom n'existe dans
// src/. Le grep disait vrai, la conclusion était fausse : better-sqlite3
// compile `SQLITE_DEFAULT_WAL_SYNCHRONOUS=1` (deps/defines.gypi), donc en WAL
// la durabilité effective EST NORMAL — sans une ligne à nous. Ce fichier ouvre
// la base DU PRODUIT (`openDatabase`) dans un bureau jetable, sous un
// environnement minimal, et lit ce que le moteur répond ; les vitrines et
// docs/FACTEUR.md doivent dire ce mot-là et pas un autre. Si la dépendance
// change son défaut, c'est ICI que ça rougit — jamais dans une phrase qui
// garderait l'air vraie.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repo = path.resolve(new URL("..", import.meta.url).pathname);
const lire = (relatif) => fs.readFileSync(path.join(repo, relatif), "utf8");
const NOMS = { 0: "OFF", 1: "NORMAL", 2: "FULL", 3: "EXTRA" };

// Un sous-processus, un bureau jetable, rien d'hérité : HOME factice, TMPDIR
// dans ce HOME, le bureau désigné explicitement (CC2CC_V2_HOME), pas de garde
// armée, pas de variable de la session qui lance la suite.
let memo = null;
function mesurer() {
  if (memo) return memo;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-durabilite-"));
  const bureau = path.join(home, "bureau");
  fs.mkdirSync(bureau);
  try {
    const sonde = spawnSync(process.execPath, ["--input-type=module", "-e",
      `import { openDatabase } from ${JSON.stringify(path.join(repo, "src", "lib", "database.js"))};
       const db = openDatabase();
       console.log(JSON.stringify({
         journal_mode: db.pragma("journal_mode", { simple: true }),
         synchronous: db.pragma("synchronous", { simple: true }),
         options: db.prepare("PRAGMA compile_options").all().map((r) => r.compile_options).filter((o) => /SYNCHRONOUS/.test(o))
       }));`],
      { encoding: "utf8", env: { PATH: process.env.PATH || "", HOME: home, TMPDIR: home, CC2CC_V2_HOME: bureau, LC_ALL: "C", TZ: "UTC" } });
    assert.equal(sonde.status, 0, `SONDE IMPOSSIBLE — la base du produit ne s'ouvre pas dans un bureau jetable :\n${sonde.stderr}`);
    assert.ok(fs.existsSync(path.join(bureau, "broker.db")), "la base ouverte est celle du bureau jetable");
    memo = JSON.parse(sonde.stdout.trim().split("\n").pop());
    return memo;
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("la base du produit tourne en WAL avec synchronous=NORMAL — le défaut compilé de better-sqlite3 pour WAL, sans pragma dans src/", () => {
  const mesure = mesurer();
  assert.equal(mesure.journal_mode, "wal", "le journal est WAL (database.js le demande)");
  assert.equal(mesure.synchronous, 1, `synchronous mesuré = ${mesure.synchronous} (${NOMS[mesure.synchronous]}) — attendu 1 (NORMAL)`);
  assert.ok(mesure.options.includes("DEFAULT_WAL_SYNCHRONOUS=1"), `le défaut vient de la compilation de better-sqlite3 (options vues : ${mesure.options.join(", ")})`);

  // Aucun pragma `synchronous` dans src/ : le mot vient du moteur, pas d'une
  // ligne à nous — le jour où quelqu'un en pose un, la phrase « défaut compilé »
  // des vitrines devient fausse, et ce test le dit.
  const porteurs = [];
  const marcher = (dossier) => {
    for (const entree of fs.readdirSync(dossier, { withFileTypes: true })) {
      const chemin = path.join(dossier, entree.name);
      if (entree.isDirectory()) marcher(chemin);
      else if (/\.(js|mjs|py)$/.test(entree.name) && /synchronous/i.test(fs.readFileSync(chemin, "utf8"))) porteurs.push(path.relative(repo, chemin));
    }
  };
  marcher(path.join(repo, "src"));
  assert.deepEqual(porteurs, [], "aucun pragma synchronous dans src/ — sinon les vitrines doivent cesser de dire « défaut compilé »");
});

test("les vitrines et docs/FACTEUR.md disent le mot que le moteur répond, et d'où il vient", () => {
  const mot = NOMS[mesurer().synchronous];
  for (const fichier of ["README.md", "README.fr.md", "docs/FACTEUR.md"]) {
    assert.ok(lire(fichier).includes(`\`synchronous=${mot}\``), `${fichier} dit \`synchronous=${mot}\` — le mot mesuré, pas un autre`);
  }
  // `\s+` : les vitrines coupent leurs lignes à 80 colonnes.
  assert.match(lire("README.md"), /WAL\s+mode\s+with\s+`synchronous=NORMAL`\s+—\s+better-sqlite3's\s+compiled\s+default\s+for\s+WAL/, "la vitrine anglaise dit d'où vient le mot");
  assert.match(lire("README.fr.md"), /mode\s+WAL\s+avec\s+`synchronous=NORMAL`\s+—\s+le\s+défaut\s+compilé\s+de\s+better-sqlite3\s+pour\s+WAL/, "la vitrine française aussi");
  for (const fichier of ["README.md", "README.fr.md"]) {
    assert.doesNotMatch(lire(fichier), /default durability|durabilité par défaut/, `${fichier} ne cache plus le mot derrière « défaut »`);
  }
});
