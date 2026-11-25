// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LE SERVICE DU RELAIS EST UNE OPTION : `--relais`, et rien d'autre, le pose.
//
// Aucun test ne touche `~/Library/LaunchAgents`, un bureau réel ni `launchctl` :
// chaque HOME naît sous mkdtemp (test/aide-installeur.js). Sans `--write`,
// `--relais` ne fait que lire et dire ce qu'il écrirait.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { MARKER, planRelaisPlist } from "../scripts/launchd/plists.js";
import { RELAIS_LABEL, SERVICES } from "../src/lib/launchd-labels.js";
import { arbre, fauxHome, lancer } from "./aide-installeur.js";

const LABEL = "com.valxos.messenger.relais";
const plistDuRelais = (home) => path.join(home, "Library", "LaunchAgents", `${LABEL}.plist`);

test("le libellé du relais n'est pas un des services de l'installation par défaut", () => {
  assert.equal(RELAIS_LABEL, LABEL);
  assert.ok(!SERVICES.some(({ label }) => label === LABEL));
});

test("l'installation par défaut ne pose pas le relais", (t) => {
  const home = fauxHome(t);
  for (const args of [["--dry-run"], ["--dry-run", "--launchd"]]) {
    const sortie = lancer(home, args);
    assert.equal(sortie.status, 0, `${sortie.stdout}\n${sortie.stderr}`);
    assert.ok(!sortie.stdout.includes(LABEL), `${args.join(" ")} nomme le relais`);
  }
  const reelle = lancer(home, ["--launchd", "--no-enable"]);
  assert.equal(reelle.status, 0, `${reelle.stdout}\n${reelle.stderr}`);
  assert.ok(!fs.existsSync(plistDuRelais(home)), "--launchd a posé le plist du relais");
});

test("--relais le pose, en dry-run d'abord : le libellé est dit, rien n'est écrit", (t) => {
  const home = fauxHome(t);
  const avant = arbre(home);
  const sortie = lancer(home, ["--relais"]);
  assert.equal(sortie.status, 0, `${sortie.stdout}\n${sortie.stderr}`);
  assert.ok(sortie.stdout.includes(LABEL), sortie.stdout);
  assert.match(sortie.stdout, /dry run/i);
  assert.deepEqual(arbre(home), avant, "un fichier a été écrit sans --write");
});

test("--relais --dry-run dit la même chose et n'écrit rien non plus", (t) => {
  const home = fauxHome(t);
  const avant = arbre(home);
  const sortie = lancer(home, ["--relais", "--dry-run"]);
  assert.equal(sortie.status, 0, `${sortie.stdout}\n${sortie.stderr}`);
  assert.ok(sortie.stdout.includes(LABEL));
  assert.deepEqual(arbre(home), avant);
});

test("--relais --write pose le plist : marqué, tournee, bureau pinglé, journaux du relais", (t) => {
  const home = fauxHome(t);
  const sortie = lancer(home, ["--relais", "--write"]);
  assert.equal(sortie.status, 0, `${sortie.stdout}\n${sortie.stderr}`);
  const plist = plistDuRelais(home);
  const texte = fs.readFileSync(plist, "utf8");
  assert.ok(texte.includes(MARKER));
  assert.doesNotMatch(texte, /__[A-Z_]+__/);
  assert.match(texte, /<string>[^<]*\/src\/bin\/relais\.js<\/string>\s*<string>tournee<\/string>/);
  const bureau = path.join(home, ".valxos-messenger");
  assert.match(texte, new RegExp(`<key>VALXOS_MESSENGER_HOME</key>\\s*<string>${bureau}</string>`));
  assert.match(texte, /<key>KeepAlive<\/key>\s*<true\/>/);
  // R40 : launchd attend 20 s par défaut après SIGTERM, puis tue. La tournée en
  // cours (15 s au plus) puis le dernier échange (15 s au plus, R37) ont 45 s.
  assert.match(texte, /<key>ExitTimeOut<\/key>\s*<integer>45<\/integer>/);
  assert.ok(texte.includes(`${bureau}/logs/relais.out.log`));
  assert.ok(texte.includes(`${bureau}/logs/relais.err.log`));
  // Il le dit : rien n'est chargé, la commande est à lancer à la main.
  assert.match(sortie.stdout, /launchctl bootstrap gui\/\$\(id -u\)/);
  // Le facteur et la porte web ne sont pas posés par ce mode.
  assert.ok(!fs.existsSync(path.join(home, "Library", "LaunchAgents", "com.valxos.messenger.facteur.plist")));
});

test("--relais --write, deux fois : la seconde ne change rien", (t) => {
  const home = fauxHome(t);
  lancer(home, ["--relais", "--write"]);
  const avant = arbre(home);
  const sortie = lancer(home, ["--relais", "--write"]);
  assert.equal(sortie.status, 0, `${sortie.stdout}\n${sortie.stderr}`);
  assert.match(sortie.stdout, /unchanged/);
  assert.deepEqual(arbre(home), avant);
});

test("--relais refuse un plist qui n'est pas le sien, sauf --force (sauvegarde gardée)", (t) => {
  const home = fauxHome(t);
  const plist = plistDuRelais(home);
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.writeFileSync(plist, "<plist>à la main</plist>\n");
  const refus = lancer(home, ["--relais", "--write"]);
  assert.notEqual(refus.status, 0);
  assert.equal(fs.readFileSync(plist, "utf8"), "<plist>à la main</plist>\n");
  const force = lancer(home, ["--relais", "--write", "--force"]);
  assert.equal(force.status, 0, `${force.stdout}\n${force.stderr}`);
  assert.ok(fs.readFileSync(plist, "utf8").includes(MARKER));
  assert.ok(fs.readdirSync(path.dirname(plist)).some((f) => f.includes(".bak.")));
});

test("--relais ne se combine pas avec les autres modes ; --write et --dry-run se contredisent", (t) => {
  const home = fauxHome(t);
  for (const autre of ["--launchd", "--launchd-load", "--uninstall", "--no-enable"]) {
    const sortie = lancer(home, ["--relais", autre]);
    assert.equal(sortie.status, 2, `${autre}: ${sortie.stdout}${sortie.stderr}`);
    assert.match(sortie.stderr, /--relais/);
  }
  const contradiction = lancer(home, ["--relais", "--write", "--dry-run"]);
  assert.equal(contradiction.status, 2);
  assert.deepEqual(arbre(home).filter((p) => p.includes("LaunchAgents")), []);
});

test("--uninstall retire le plist du relais qu'il a posé, et lui seul le nomme", (t) => {
  const home = fauxHome(t);
  lancer(home, ["--relais", "--write"]);
  assert.ok(fs.existsSync(plistDuRelais(home)));
  const sortie = lancer(home, ["--uninstall"]);
  assert.equal(sortie.status, 0, `${sortie.stdout}\n${sortie.stderr}`);
  assert.ok(!fs.existsSync(plistDuRelais(home)));
});

test("planRelaisPlist : le gabarit rendu, sans faux-semblant", () => {
  const plan = planRelaisPlist({ home: "/h", root: "/opt/valxos/cc2cc-v2", runtimeHome: "/opt/valxos/bureau", node: "/opt/homebrew/bin/node" });
  assert.equal(plan.label, LABEL);
  assert.equal(plan.path, `/h/Library/LaunchAgents/${LABEL}.plist`);
  assert.ok(plan.content.includes("<string>/opt/valxos/cc2cc-v2/src/bin/relais.js</string>"));
  assert.ok(plan.content.includes("<string>tournee</string>"));
  // R40 : une seule clef ExitTimeOut, un entier, 45.
  assert.deepEqual(plan.content.match(/<key>ExitTimeOut<\/key>\s*<[a-z]+>[^<]*<\/[a-z]+>/g),
    ["<key>ExitTimeOut</key>\n  <integer>45</integer>"]);
});
