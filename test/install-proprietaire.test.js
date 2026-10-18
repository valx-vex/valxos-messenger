// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// L'UNINSTALL NE RETIRE QUE CE QUI EST À LUI (hygiène H7).
//
// `--uninstall` jugeait un lien « à nous » par un PRÉFIXE de chaîne : la racine
// `…/pkg` avalait `…/pkg-sibling/src/bin/x.js`, le lien d'un checkout voisin
// (un worktree, une copie d'épreuve) était retiré. Et le lien du plugin était
// retiré sans même être regardé. Désormais : par segments de chemin, sur des
// chemins résolus (realpath), par un seul juge pour tous les liens.
//
// Tout se joue dans un HOME jetable : le paquet est COPIÉ dans ce HOME, son
// voisin aussi, et les liens sont posés à la main — l'uninstall n'a besoin de
// rien d'autre.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { copieDuPaquet, fauxHome, lancer, launchctlOuRienNestCharge, rapport } from "./aide-installeur.js";

function deuxCheckouts(home) {
  const paquet = copieDuPaquet(path.join(home, "co", "pkg"));
  const voisin = path.join(home, "co", "pkg-sibling");
  fs.mkdirSync(path.join(voisin, "src", "bin"), { recursive: true });
  for (const f of ["valxos-send.js", "valxos-inbox.js"]) fs.writeFileSync(path.join(voisin, "src", "bin", f), "// voisin\n");
  fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
  fs.mkdirSync(path.join(home, ".claude", "skills"), { recursive: true });
  return { paquet, voisin };
}

function desinstaller(home, paquet) {
  const faux = launchctlOuRienNestCharge(home);
  const sortie = lancer(home, ["--uninstall"], { VALXOS_MESSENGER_LAUNCHCTL: faux.script }, { racine: paquet });
  assert.equal(sortie.status, 0, `${sortie.stdout}\n${sortie.stderr}`);
  return rapport(sortie);
}

const existe = (p) => fs.lstatSync(p, { throwIfNoEntry: false }) !== undefined;

test("un lien CLI vers un checkout VOISIN (<racine>-sibling) survit à --uninstall ; le lien vers <racine> part", (t) => {
  const home = fauxHome(t);
  const { paquet, voisin } = deuxCheckouts(home);
  const bin = path.join(home, ".local", "bin");
  fs.symlinkSync(path.join(voisin, "src", "bin", "valxos-send.js"), path.join(bin, "valxos-send"));
  fs.symlinkSync(path.join(paquet, "src", "bin", "valxos-inbox.js"), path.join(bin, "valxos-inbox"));

  const json = desinstaller(home, paquet);
  assert.ok(existe(path.join(bin, "valxos-send")), "le lien du voisin est resté");
  assert.equal(fs.readlinkSync(path.join(bin, "valxos-send")), path.join(voisin, "src", "bin", "valxos-send.js"));
  assert.ok(json.kept.some((k) => k.name === "valxos-send" && /points elsewhere/.test(k.reason)), JSON.stringify(json.kept));
  assert.ok(!existe(path.join(bin, "valxos-inbox")), "le lien vers la racine est retiré");
  assert.ok(json.removed.includes(path.join(bin, "valxos-inbox")));
});

test("un lien CLI RELATIF vers la racine est reconnu comme le sien (chemin résolu, pas la chaîne écrite)", (t) => {
  const home = fauxHome(t);
  const { paquet } = deuxCheckouts(home);
  const lien = path.join(home, ".local", "bin", "valxos-inbox");
  fs.symlinkSync(path.relative(path.dirname(lien), path.join(paquet, "src", "bin", "valxos-inbox.js")), lien);
  desinstaller(home, paquet);
  assert.ok(!existe(lien), "le lien relatif vers la racine est retiré");
});

test("le lien du PLUGIN vers un checkout voisin survit à --uninstall", (t) => {
  const home = fauxHome(t);
  const { paquet, voisin } = deuxCheckouts(home);
  const plugin = path.join(home, ".claude", "skills", "valxos-messenger");
  fs.symlinkSync(voisin, plugin);
  const json = desinstaller(home, paquet);
  assert.ok(existe(plugin), "le lien du plugin d'un autre checkout est resté");
  assert.equal(fs.readlinkSync(plugin), voisin);
  assert.ok(!json.removed.includes(plugin), JSON.stringify(json.removed));
  assert.ok(json.kept.some((k) => k.name === plugin && /points elsewhere/.test(k.reason)), JSON.stringify(json.kept));
});

test("le lien du PLUGIN vers la racine est retiré", (t) => {
  const home = fauxHome(t);
  const { paquet } = deuxCheckouts(home);
  const plugin = path.join(home, ".claude", "skills", "valxos-messenger");
  fs.symlinkSync(paquet, plugin);
  const json = desinstaller(home, paquet);
  assert.ok(!existe(plugin), "le lien du plugin est retiré");
  assert.ok(json.removed.includes(plugin));
});

// F4 (passe adverse, 18/10) — L'UNINSTALL RECONNAÎT UNE CIBLE, PAS LA PROVENANCE DU LIEN.
//
// `linkLeadsInto(link, root)` jugeait « à nous » tout lien portant un nom
// publié qui MÈNE QUELQUE PART DANS la racine du paquet : un lien manuel
// `valxos-send → <racine>/README.md` partait avec les nôtres, et le dry-run le
// disait `rm …` puis « Removed: 1 ». Un lien n'est à nous que si sa cible RÉELLE
// est la cible `bin` que le manifeste déclare POUR CE NOM, résolue depuis la
// racine. Tout autre lien du même nom reste, et se nomme « not ours ».
function installerLesLiensDuTest(home, paquet) {
  const bin = path.join(home, ".local", "bin");
  fs.mkdirSync(bin, { recursive: true });
  const manuel = path.join(bin, "valxos-send"); // même nom, autre cible : le README du paquet
  fs.symlinkSync(path.join(paquet, "README.md"), manuel);
  const soeur = path.join(bin, "cc2cc-peers"); // une AUTRE cible `bin` du même paquet
  fs.symlinkSync(path.join(paquet, "src", "bin", "valxos-send.js"), soeur);
  const legitime = path.join(bin, "valxos-inbox");
  fs.symlinkSync(path.join(paquet, "src", "bin", "valxos-inbox.js"), legitime);
  return { bin, manuel, soeur, legitime };
}

test("F4 — un lien manuel vers un AUTRE fichier du paquet survit à --uninstall --dry-run et à --uninstall ; le lien légitime part", (t) => {
  const home = fauxHome(t);
  const { paquet } = deuxCheckouts(home);
  const { manuel, soeur, legitime } = installerLesLiensDuTest(home, paquet);
  const faux = launchctlOuRienNestCharge(home);
  const env = { VALXOS_MESSENGER_LAUNCHCTL: faux.script };

  const simulation = lancer(home, ["--uninstall", "--dry-run"], env, { racine: paquet });
  assert.equal(simulation.status, 0, `${simulation.stdout}\n${simulation.stderr}`);
  assert.match(simulation.stdout, /would remove/i, "le dry-run dit « would remove »");
  assert.doesNotMatch(simulation.stdout, /^Removed:/m, "et jamais « Removed »");
  assert.ok(existe(manuel) && existe(soeur) && existe(legitime), "un dry-run ne retire rien");
  const plan = rapport(simulation);
  assert.deepEqual(plan.removed, [], "le dry-run n'a rien retiré");
  assert.ok(plan.would_remove.includes(legitime), "il annonce le lien légitime");
  assert.ok(!plan.would_remove.includes(manuel), "mais pas le lien manuel : il pointait vers README.md");
  assert.ok(!plan.would_remove.includes(soeur), "ni un lien vers une autre cible bin du même paquet");

  const retrait = lancer(home, ["--uninstall"], env, { racine: paquet });
  assert.equal(retrait.status, 0, `${retrait.stdout}\n${retrait.stderr}`);
  assert.match(retrait.stdout, /^Removed: 1$/m);
  assert.ok(!existe(legitime), "le lien légitime est retiré");
  assert.equal(fs.readlinkSync(manuel), path.join(paquet, "README.md"), "le lien manuel est resté, intact");
  assert.equal(fs.readlinkSync(soeur), path.join(paquet, "src", "bin", "valxos-send.js"), "le lien d'une autre cible aussi");
  const json = rapport(retrait);
  assert.deepEqual(json.removed, [legitime]);
  for (const nom of ["valxos-send", "cc2cc-peers"]) {
    assert.ok(json.kept.some((k) => k.name === nom && /not ours/.test(k.reason) && /points elsewhere/.test(k.reason)), JSON.stringify(json.kept));
  }
  assert.match(retrait.stdout, /valxos-send: not ours/, "la liste lisible les nomme aussi");
});

test("F4 — la cible se juge sur son chemin RÉEL : un lien passant par un lien symbolique du paquet est le nôtre", (t) => {
  const home = fauxHome(t);
  const { paquet } = deuxCheckouts(home);
  const alias = path.join(home, "co", "alias-du-paquet");
  fs.symlinkSync(paquet, alias);
  const lien = path.join(home, ".local", "bin", "valxos-inbox");
  fs.symlinkSync(path.join(alias, "src", "bin", "valxos-inbox.js"), lien);
  desinstaller(home, paquet);
  assert.ok(!existe(lien), "le chemin réel est celui de la cible déclarée : le lien est retiré");
});

// J2 (jury, 18/10) — L'INDICE DIT LA VÉRITÉ. Un chemin qui existe sous un nom publié sans être
// un lien se gardait avec l'indice « not a symlink (use --force) » : `doUninstall` ne lit
// JAMAIS `force`, l'indice promettait un geste qui n'existe pas. Il dit ce qui est vrai : le
// chemin reste en place, et c'est à la main de le retirer s'il est à soi. Aucune suppression
// forcée de vrais fichiers n'est implémentée — un fichier à soi ne se retire pas à la place de
// son propriétaire.
const INDICE_PAS_UN_LIEN = "not a symlink: left in place (remove it by hand if it is yours)";

for (const [quoi, poser] of [
  ["un FICHIER ordinaire", (chemin) => fs.writeFileSync(chemin, "#!/bin/sh\n# à moi\n")],
  ["un DOSSIER", (chemin) => fs.mkdirSync(chemin)]
]) {
  test(`F4/J2 — ${quoi} sous un nom publié n'est jamais retiré, et l'indice dit « left in place », pas « --force »`, (t) => {
    const home = fauxHome(t);
    const { paquet } = deuxCheckouts(home);
    const chemin = path.join(home, ".local", "bin", "valxos-peers");
    poser(chemin);
    const faux = launchctlOuRienNestCharge(home);
    const env = { VALXOS_MESSENGER_LAUNCHCTL: faux.script };

    for (const drapeaux of [["--uninstall", "--dry-run"], ["--uninstall"], ["--uninstall", "--force"]]) {
      const sortie = lancer(home, drapeaux, env, { racine: paquet });
      assert.equal(sortie.status, 0, `${drapeaux.join(" ")} : ${sortie.stdout}\n${sortie.stderr}`);
      assert.ok(existe(chemin), `${drapeaux.join(" ")} : le chemin est resté`);
      assert.ok(
        rapport(sortie).kept.some((k) => k.name === "valxos-peers" && k.reason === INDICE_PAS_UN_LIEN),
        `${drapeaux.join(" ")} : ${JSON.stringify(rapport(sortie).kept)}`
      );
      assert.match(sortie.stdout, /valxos-peers: not a symlink: left in place \(remove it by hand if it is yours\)/, "la liste lisible dit la même chose");
      assert.doesNotMatch(sortie.stdout, /use --force/, "plus de promesse d'un --force que l'uninstall ne lit pas");
    }
  });
}
