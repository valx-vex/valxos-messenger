// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// L'INSTALLEUR ET LA MAISON CLAUDE — une seule règle pour dire où va le plugin.
//
// Une machine peut héberger plusieurs maisons Claude Code : le lanceur pose
// CLAUDE_CONFIG_DIR. La rc2 créait `$CLAUDE_CONFIG_DIR/skills` puis posait le
// lien dans `~/.claude/skills/cc2cc-v2` — deux maisons pour un seul geste. En
// install réelle sous CLAUDE_CONFIG_DIR : ENOENT (le parent n'existe pas), le
// plugin n'est jamais posé, et le dry-run annonçait un succès sur ce chemin.
//
// Tout ici se joue dans un HOME jetable (test/aide-installeur.js) ; la maison
// déclarée est un dossier de ce HOME, jamais une maison réelle.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { copieDuPaquet, environnement, fauxHome, lancer, launchctlOuRienNestCharge, rapport, repo } from "./aide-installeur.js";

// Le lien porte l'identifiant du plugin depuis Run 6 (Task 11), formerly `cc2cc-v2`.
const LIEN = path.join("skills", "valxos-messenger");

function docteur(home, ajouts = {}) {
  return spawnSync(process.execPath, [path.join(repo, "src", "bin", "valxos-doctor.js")], {
    encoding: "utf8",
    cwd: repo,
    env: environnement(home, ajouts)
  });
}

test("sans CLAUDE_CONFIG_DIR, le dry-run annonce le plugin sous ~/.claude", (t) => {
  const home = fauxHome(t);
  const sortie = lancer(home, ["--dry-run"]);
  assert.equal(sortie.status, 0, `${sortie.stdout}\n${sortie.stderr}`);
  const cible = path.join(home, ".claude", LIEN);
  assert.ok(sortie.stdout.includes(`mkdir -p ${path.join(home, ".claude", "skills")}`), sortie.stdout);
  assert.ok(sortie.stdout.includes(`ln -s ${repo} ${cible}`), sortie.stdout);
  assert.ok(sortie.stdout.includes("[would run] claude plugin enable valxos-messenger@skills-dir"), sortie.stdout);
  assert.equal(rapport(sortie).pluginTarget, cible);
  assert.equal(rapport(sortie).legacy_plugin_link, null, "aucun lien historique dans une maison neuve");
});

test("avec CLAUDE_CONFIG_DIR, le dry-run annonce la VRAIE cible — sous cette maison, pas sous ~/.claude", (t) => {
  const home = fauxHome(t);
  const maison = path.join(home, "maison-claude");
  const sortie = lancer(home, ["--dry-run"], { CLAUDE_CONFIG_DIR: maison });
  assert.equal(sortie.status, 0, `${sortie.stdout}\n${sortie.stderr}`);
  assert.ok(sortie.stdout.includes(`mkdir -p ${path.join(maison, "skills")}`), sortie.stdout);
  assert.ok(sortie.stdout.includes(`ln -s ${repo} ${path.join(maison, LIEN)}`), sortie.stdout);
  assert.ok(!sortie.stdout.includes(path.join(home, ".claude")), "aucune mention de ~/.claude quand la maison est déclarée");
  assert.equal(rapport(sortie).pluginTarget, path.join(maison, LIEN));
});

test("avec CLAUDE_CONFIG_DIR, l'install réelle pose le lien sous cette maison et nulle part ailleurs ; le doctor le voit ; l'uninstall le retire", (t) => {
  const home = fauxHome(t);
  const maison = path.join(home, "maison-claude");
  const env = { CLAUDE_CONFIG_DIR: maison };
  const cible = path.join(maison, LIEN);

  const install = lancer(home, ["--no-enable"], env);
  assert.equal(install.status, 0, `${install.stdout}\n${install.stderr}`);
  assert.equal(fs.lstatSync(cible).isSymbolicLink(), true, `${cible} n'est pas un lien`);
  assert.equal(fs.readlinkSync(cible), repo);
  assert.equal(fs.existsSync(path.join(home, ".claude")), false, "rien n'est posé sous ~/.claude");
  assert.equal(rapport(install).pluginTarget, cible);

  const diag = docteur(home, env);
  assert.equal(diag.status, 0, diag.stderr);
  const { checks } = JSON.parse(diag.stdout);
  assert.equal(checks.pluginTarget, cible);
  assert.equal(checks.pluginTargetExists, true);

  const faux = launchctlOuRienNestCharge(home);
  const retrait = lancer(home, ["--uninstall"], { ...env, VALXOS_MESSENGER_LAUNCHCTL: faux.script });
  assert.equal(retrait.status, 0, `${retrait.stdout}\n${retrait.stderr}`);
  assert.ok(rapport(retrait).removed.includes(cible), retrait.stdout);
  assert.equal(rapport(retrait).legacy_probe, "ok", "la sonde des labels historiques a tourné, et rien n'est chargé");
  assert.ok(faux.sondes().length > 0, "la sonde est passée par le faux launchctl");
  assert.deepEqual(faux.appels(), [], "sans --launchd-unload, aucun geste launchctl");
  assert.equal(fs.lstatSync(cible, { throwIfNoEntry: false }), undefined, "le lien est retiré");
});

// LE MÉDECIN NE CRÉE PLUS LE BUREAU (Q3, 18/10) — L'INSTALLEUR LE FAIT NAÎTRE. Le README envoie
// l'inconnu de `valxos-messenger install` à `valxos-doctor` (« Verify the installation »), et la
// marche de la CI joue le même enchaînement. Quand le médecin créait la base qu'il constatait, ce
// vert-là était un mensonge ; maintenant qu'il ne crée rien, une install qui laisserait le bureau
// à naître au premier envoi rendrait ROUGE le premier constat d'une install saine.
test("une install réelle fait naître le bureau : le médecin qui suit voit dbExists:true et ok:true", (t) => {
  const home = fauxHome(t);
  const env = { CLAUDE_CONFIG_DIR: path.join(home, "maison-claude") };

  const install = lancer(home, ["--no-enable"], env);
  assert.equal(install.status, 0, `${install.stdout}\n${install.stderr}`);
  assert.equal(rapport(install).office.ok, true, "l'installeur dit le bureau");
  assert.equal(rapport(install).office.path, path.join(home, ".valxos-messenger", "broker.db"));
  assert.ok(fs.existsSync(path.join(home, ".valxos-messenger", "broker.db")), "la base existe");
  assert.match(install.stdout, /office database: +✓/, "et le résumé lisible le dit");

  const diag = docteur(home, env);
  assert.equal(diag.status, 0, diag.stderr);
  const verdict = JSON.parse(diag.stdout);
  assert.equal(verdict.checks.dbExists, true, "le bureau est là, et le médecin ne l'a pas créé");
  assert.equal(verdict.ok, true, JSON.stringify(verdict.checks, null, 1));
  assert.match(install.stdout, /doctor: +✓ green/, "l'installeur, qui joue le médecin à la fin, le voit vert aussi");
});

test("un dry-run n'ouvre ni ne crée le bureau, et dit ce qu'il ferait", (t) => {
  const home = fauxHome(t);
  const sortie = lancer(home, ["--dry-run"], { CLAUDE_CONFIG_DIR: path.join(home, "maison-claude") });
  assert.equal(sortie.status, 0, `${sortie.stdout}\n${sortie.stderr}`);
  assert.ok(!fs.existsSync(path.join(home, ".valxos-messenger")), "aucun bureau créé");
  assert.match(sortie.stdout, /\[would open\] .*broker\.db/);
  assert.equal(rapport(sortie).office.ok, true);
  assert.match(sortie.stdout, /office database: +— .*\(dry run: not opened\)/, "le résumé ne met pas un ✓ sur un bureau qu'il n'a pas ouvert");
});

test("sans CLAUDE_CONFIG_DIR, l'install réelle pose le lien sous ~/.claude et l'uninstall le retire", (t) => {
  const home = fauxHome(t);
  const cible = path.join(home, ".claude", LIEN);
  const install = lancer(home, ["--no-enable"]);
  assert.equal(install.status, 0, `${install.stdout}\n${install.stderr}`);
  assert.equal(fs.readlinkSync(cible), repo);
  const faux = launchctlOuRienNestCharge(home);
  const retrait = lancer(home, ["--uninstall"], { VALXOS_MESSENGER_LAUNCHCTL: faux.script });
  assert.equal(retrait.status, 0, `${retrait.stdout}\n${retrait.stderr}`);
  assert.equal(fs.lstatSync(cible, { throwIfNoEntry: false }), undefined);
  assert.equal(rapport(retrait).legacy_probe, "ok");
  assert.deepEqual(faux.appels(), [], "sans --launchd-unload, aucun geste launchctl");
});

// ── HOME ABSENT ─────────────────────────────────────────────────────────────
// `process.env.HOME || require("node:os").homedir()` : `require` n'existe pas
// dans un module ES — un environnement sans HOME faisait mourir l'installeur
// d'une ReferenceError au lieu de se rabattre sur le domicile du compte.
// Dry-run seulement : sans HOME, le repli est le domicile RÉEL, et un test
// n'y écrit rien.
test("HOME absent de l'environnement : l'installeur démarre quand même", (t) => {
  const home = fauxHome(t);
  const env = environnement(home);
  delete env.HOME;
  const sortie = spawnSync(process.execPath, [path.join(repo, "scripts", "install.js"), "--dry-run"], {
    encoding: "utf8",
    cwd: repo,
    env
  });
  assert.equal(sortie.status, 0, `${sortie.stdout}\n${sortie.stderr}`);
  assert.doesNotMatch(sortie.stderr, /require is not defined/);
});

// ── UN DÉPÔT SOUS UN CHEMIN AVEC ESPACE ─────────────────────────────────────
// `new URL(import.meta.url).pathname` rend un chemin PERCENT-ENCODÉ : sous
// `with space/`, repoRoot() (config.js) et le dossier des gabarits (plists.js)
// devenaient `with%20space` — package.json introuvable, gabarits introuvables,
// et l'installeur mourait avant son premier mot.
test("un dépôt sous « with space/ » s'installe : repoRoot() et les gabarits résolvent le vrai chemin", (t) => {
  const home = fauxHome(t);
  const paquet = copieDuPaquet(path.join(home, "with space", "pkg"));
  const sortie = lancer(home, ["--dry-run", "--launchd"], {}, { racine: paquet });
  assert.equal(sortie.status, 0, `${sortie.stdout}\n${sortie.stderr}`);
  assert.equal(rapport(sortie).repo, paquet, "repoRoot() rend le chemin tel quel, espace compris");
  assert.ok(
    sortie.stdout.includes(`<string>${path.join(paquet, "src", "bin", "facteur.js")}</string>`),
    "le plist rendu porte le chemin avec l'espace"
  );
  assert.doesNotMatch(sortie.stdout, /%20/, "aucun %20 ne fuit dans ce qui serait écrit");
});
