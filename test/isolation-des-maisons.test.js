// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// AUCUN ENFANT DE TEST NE REGARDE UNE VRAIE MAISON.
//
// Un enfant lancé avec `envPropre()` héritait du vrai HOME : le scan des
// maisons (`~/.claude/sessions`) et chaque sonde de vie qui suit tombaient sur
// les séances d'une vraie personne. La preuve ne lit jamais le vrai
// `~/.claude` : elle compare les HOME, et elle fait regarder un espion.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { envPropre } from "./aide-env.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ESPION = path.join(repo, "test/aide-espion-maisons.cjs");
const vraiHome = () => os.userInfo().homedir;

function jetable(t, prefixe) {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), prefixe));
  t.after(() => fs.rmSync(dossier, { recursive: true, force: true }));
  return dossier;
}

test("envPropre() ne rend jamais le HOME réel, ni celui du parent", () => {
  const env = envPropre();
  assert.ok(env.HOME && path.isAbsolute(env.HOME), "HOME is set and absolute");
  assert.notEqual(path.resolve(env.HOME), path.resolve(vraiHome()), "not the account home");
  assert.notEqual(path.resolve(env.HOME), path.resolve(os.homedir()), "not the parent's own home");
  assert.equal("CLAUDE_CONFIG_DIR" in env, false);
});

test("envPropre() pose des maisons sur le chemin d'un dossier vide, jamais une chaîne vide", () => {
  const env = envPropre();
  for (const clef of ["CC2CC_MAISONS", "VALXOS_MAISONS"]) {
    assert.ok(env[clef] && path.isAbsolute(env[clef]), `${clef} is an absolute path`);
    assert.equal(fs.statSync(env[clef]).isDirectory(), true);
    assert.deepEqual(fs.readdirSync(env[clef]), [], `${clef} is empty`);
    assert.notEqual(path.resolve(env[clef]), path.resolve(path.join(vraiHome(), ".claude")));
  }
});

test("envPropre() : ce qu'un test pose gouverne, y compris HOME et les maisons", () => {
  const env = envPropre({ HOME: "/le/mien", CC2CC_MAISONS: "/mes/maisons" });
  assert.equal(env.HOME, "/le/mien");
  assert.equal(env.CC2CC_MAISONS, "/mes/maisons");
  assert.equal("VALXOS_MAISONS" in env, false, "the VALXOS_* twin must not outvote the test's own value");
});

test("la vraie commande `echanger`, avec un HOME explicite et sans maisons déclarées, ne regarde que la maison de ce HOME (sentinelle)", (t) => {
  const home = jetable(t, "isolation-home-");
  const bureau = jetable(t, "isolation-bureau-");
  fs.mkdirSync(path.join(home, ".claude", "sessions"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "sessions", "sentinelle.json"), "{}");
  const journal = path.join(jetable(t, "isolation-journal-"), "acces.log");
  const env = envPropre({
    HOME: home,
    CC2CC_V2_HOME: bureau,
    CC2CC_GARDE_BUREAU: "1",
    SSH_CONNECTION: "10.0.0.1 1 10.0.0.2 22",
    ESPION_JOURNAL: journal,
    ESPION_CIBLES: path.join(home, ".claude"),
    NODE_OPTIONS: `--require ${ESPION}`
  });
  delete env.CC2CC_MAISONS;
  delete env.VALXOS_MAISONS;
  fs.writeFileSync(path.join(bureau, "relais.json"), JSON.stringify({ moi: "MacBook" }));
  const entree = {
    marquer: { portees: [], rendus: [] },
    paquet: { version: 1, schema: 8, de: "Studio", pour: "MacBook", lettres: [], evenements: [], chaises: [] }
  };
  const r = spawnSync(process.execPath, [path.join(repo, "src/bin/relais.js"), "echanger", "--de", "Studio"], {
    cwd: repo, input: JSON.stringify(entree), encoding: "utf8", env, timeout: 30_000
  });
  assert.equal(r.error, undefined);
  const lignes = fs.existsSync(journal) ? fs.readFileSync(journal, "utf8").split("\n").filter(Boolean) : [];
  assert.ok(lignes.length > 0, `the child scanned its house (the sentinel); stderr: ${r.stderr}`);
  const cible = path.join(vraiHome(), ".claude");
  assert.equal(lignes.filter((l) => l.includes(` ${cible}`) && !l.includes(` ${path.join(home, ".claude")}`)).length, 0,
    "no access to the real account house");
  assert.ok(lignes.every((l) => l.includes(path.join(home, ".claude"))), "only the sentinel house was looked at");
});

test("un enfant lancé avec envPropre() n'accède à aucune maison sous le HOME réel", (t) => {
  const journal = path.join(jetable(t, "isolation-journal-"), "acces.log");
  const env = envPropre({ ESPION_JOURNAL: journal, NODE_OPTIONS: `--require ${ESPION}` });
  const r = spawnSync(process.execPath, ["-e",
    `import(${JSON.stringify(path.join(repo, "src/lib/config.js"))}).then((m) => console.log(JSON.stringify(m.maisonsConnues())))`],
  { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), [env.CC2CC_MAISONS], "the child's only house is the empty one");
  assert.equal(fs.existsSync(journal), false, "nothing under the real account home was touched");
});

test("la vraie commande `echanger` lancée par un envPropre() nu (sans HOME passé) n'accède à aucune maison sous le HOME réel", (t) => {
  const bureau = jetable(t, "isolation-bureau-");
  const journal = path.join(jetable(t, "isolation-journal-"), "acces.log");
  fs.writeFileSync(path.join(bureau, "relais.json"), JSON.stringify({ moi: "MacBook" }));
  // Plain envPropre(): no HOME, no houses passed. Only the spy and the
  // office (a throwaway one) are added; the houses are NOT declared, so the
  // child's default scan (HOME/.claude) is what the throwaway HOME protects.
  const env = envPropre({
    CC2CC_V2_HOME: bureau,
    CC2CC_GARDE_BUREAU: "1",
    SSH_CONNECTION: "10.0.0.1 1 10.0.0.2 22",
    ESPION_JOURNAL: journal,
    // Watched: the account home AND the home this test process runs under
    // (the one a child would inherit if envPropre() leaked it).
    ESPION_CIBLES: [path.join(vraiHome(), ".claude"), path.join(os.homedir(), ".claude")].join(path.delimiter),
    NODE_OPTIONS: `--require ${ESPION}`
  });
  delete env.CC2CC_MAISONS;
  delete env.VALXOS_MAISONS;
  const entree = {
    marquer: { portees: [], rendus: [] },
    paquet: { version: 1, schema: 8, de: "Studio", pour: "MacBook", lettres: [], evenements: [], chaises: [] }
  };
  const r = spawnSync(process.execPath, [path.join(repo, "src/bin/relais.js"), "echanger", "--de", "Studio"], {
    cwd: repo, input: JSON.stringify(entree), encoding: "utf8", env, timeout: 30_000
  });
  assert.equal(r.status, 0, r.stderr);
  assert.notEqual(path.resolve(env.HOME), path.resolve(vraiHome()));
  const lignes = fs.existsSync(journal) ? fs.readFileSync(journal, "utf8").split("\n").filter(Boolean) : [];
  assert.deepEqual(lignes, [], "no access under the real account home");
});
