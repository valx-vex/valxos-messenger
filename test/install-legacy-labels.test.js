// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LES LABELS HISTORIQUES — ceux de l'ère cc2cc-v2 tiennent encore le port 8790
// sur une machine qui migre. L'installeur ne charge jamais les nouveaux plists
// par-dessus, et ne les arrête que sur un geste explicite (--launchd-unload).
//
// Les labels dérivés sur cette machine sont les VRAIS, chargés et en service :
// chaque test pose VALXOS_LEGACY_LABELS sur des exemples, un faux launchctl, et
// un HOME né sous mkdtemp. Le vrai launchctl n'est jamais appelé d'ici.
import test from "node:test"; import assert from "node:assert/strict";
import fs from "node:fs"; import path from "node:path";
import { environnement, fauxHome, lancer, rapport, repo } from "./aide-installeur.js";
import { spawnSync } from "node:child_process";
const LEGACY = "com.example.cc2cc-facteur:com.example.cc2cc-web";

// Faux launchctl : `print` répond « chargé » (0) pour les labels listés, 113 sinon.
function fauxLaunchctl(home, charges) {
  const journal = path.join(home, "launchctl.journal"); const script = path.join(home, "faux-launchctl");
  fs.writeFileSync(script, "#!/bin/sh\n" + `printf '%s\\t' "$@" >> ${JSON.stringify(journal)}; printf '\\n' >> ${JSON.stringify(journal)}\n` +
    `if [ "$1" = print ]; then case "$2" in ${charges.map((l) => `*/${l}) exit 0;;`).join(" ")} *) exit 113;; esac; fi\nexit 0\n`, { mode: 0o755 });
  const appels = () => fs.existsSync(journal) ? fs.readFileSync(journal, "utf8").trim().split("\n").map((l) => l.split("\t").filter(Boolean)) : [];
  return { script, appels };
}
test("--launchd-load refuse de charger tant qu'un label historique tourne (8790)", (t) => {
  const home = fauxHome(t); const faux = fauxLaunchctl(home, ["com.example.cc2cc-web"]);
  const r = lancer(home, ["--launchd-load", "--no-enable"], { VALXOS_MESSENGER_LAUNCHCTL: faux.script, VALXOS_LEGACY_LABELS: LEGACY });
  assert.notEqual(r.status, 0);
  assert.deepEqual(rapport(r).launchd.legacy_loaded, ["com.example.cc2cc-web"]);
  assert.ok(!faux.appels().some((a) => a[0] === "bootstrap"), "aucun bootstrap");
  assert.match(r.stdout, /launchctl bootout gui\/\$\(id -u\)\/com\.example\.cc2cc-web/);
});
test("--uninstall nomme les labels historiques chargés ; --launchd-unload les arrête, sans toucher leurs plists", (t) => {
  const home = fauxHome(t); const faux = fauxLaunchctl(home, ["com.example.cc2cc-facteur", "com.example.cc2cc-web"]);
  const legacy = path.join(home, "Library", "LaunchAgents", "com.example.cc2cc-web.plist");
  fs.mkdirSync(path.dirname(legacy), { recursive: true }); fs.writeFileSync(legacy, "<plist/>\n");
  const sans = lancer(home, ["--uninstall"], { VALXOS_MESSENGER_LAUNCHCTL: faux.script, VALXOS_LEGACY_LABELS: LEGACY });
  assert.ok(rapport(sans).bootout.includes("com.example.cc2cc-web"));
  assert.ok(!faux.appels().some((a) => a[0] === "bootout"));
  const avec = lancer(home, ["--uninstall", "--launchd-unload"], { VALXOS_MESSENGER_LAUNCHCTL: faux.script, VALXOS_LEGACY_LABELS: LEGACY });
  const uid = process.getuid();
  for (const l of ["com.example.cc2cc-facteur", "com.example.cc2cc-web"]) assert.ok(faux.appels().some((a) => a[0] === "bootout" && a[1] === `gui/${uid}/${l}`), l);
  assert.ok(fs.existsSync(legacy), "un plist sans marqueur n'est jamais supprimé");
  assert.equal(avec.status, 0);
});
test("--launchd-unload hors --uninstall est refusé ; sous --dry-run il montre le bootout sans l'exécuter", (t) => {
  const home = fauxHome(t); const faux = fauxLaunchctl(home, ["com.example.cc2cc-web"]);
  const env = { VALXOS_MESSENGER_LAUNCHCTL: faux.script, VALXOS_LEGACY_LABELS: LEGACY };
  const seul = lancer(home, ["--launchd-unload"], env);
  assert.equal(seul.status, 2); assert.match(seul.stderr, /--launchd-unload applies to --uninstall only/);
  assert.deepEqual(faux.appels(), [], "rien n'a été demandé à launchctl");
  const simulation = lancer(home, ["--uninstall", "--dry-run", "--launchd-unload"], env);
  assert.equal(simulation.status, 0, `${simulation.stdout}\n${simulation.stderr}`);
  assert.ok(simulation.stdout.includes(`[would run] ${faux.script} bootout gui/${process.getuid()}/com.example.cc2cc-web`));
  assert.ok(!faux.appels().some((a) => a[0] === "bootout"), "aucun bootout exécuté en dry-run");
  assert.equal(rapport(simulation).unloaded, null);
});

// TROIS ISSUES : une sonde qui n'a pas pu tourner n'est jamais un « pas chargé ».
// Deux façons de ne pas pouvoir sonder : pas de launchctl du tout, ou un `print`
// qui sort autre chose que 0 (chargé) ou 113 (pas chargé).
function fauxLaunchctlMuet(home) {
  const journal = path.join(home, "launchctl.journal"); const script = path.join(home, "faux-launchctl-muet");
  fs.writeFileSync(script, "#!/bin/sh\n" + `printf '%s\\t' "$@" >> ${JSON.stringify(journal)}; printf '\\n' >> ${JSON.stringify(journal)}\n` +
    `if [ "$1" = print ]; then echo "Unexpected failure" >&2; exit 1; fi\nexit 0\n`, { mode: 0o755 });
  const appels = () => fs.existsSync(journal) ? fs.readFileSync(journal, "utf8").trim().split("\n").map((l) => l.split("\t").filter(Boolean)) : [];
  return { script, appels };
}
for (const [cas, fabrique] of [
  ["launchctl introuvable", (home) => ({ script: path.join(home, "nulle-part", "launchctl"), appels: () => [] })],
  ["print sort 1", fauxLaunchctlMuet]
]) {
  test(`sonde impossible (${cas}) : --launchd-load refuse sans rien charger ; --uninstall finit et le dit`, (t) => {
    const home = fauxHome(t); const faux = fabrique(home);
    const env = { VALXOS_MESSENGER_LAUNCHCTL: faux.script, VALXOS_LEGACY_LABELS: LEGACY };
    const charge = lancer(home, ["--launchd-load", "--no-enable"], env);
    assert.notEqual(charge.status, 0, `${charge.stdout}\n${charge.stderr}`);
    const json = rapport(charge);
    assert.equal(json.launchd.legacy_probe, "impossible");
    assert.deepEqual(json.launchd.legacy_loaded, []);
    assert.ok(json.launchd.legacy_probe_detail.length > 0, "la sonde ratée est nommée");
    assert.ok(!faux.appels().some((a) => a[0] === "bootstrap"), "aucun bootstrap");
    assert.match(charge.stdout, /legacy-label probe could not run/);

    const retrait = lancer(home, ["--uninstall"], env);
    assert.equal(retrait.status, 0, `${retrait.stdout}\n${retrait.stderr}`);
    const r = rapport(retrait);
    assert.equal(r.legacy_probe, "impossible");
    assert.ok(!r.bootout.some((l) => LEGACY.split(":").includes(l)), `rien de non confirmé dans bootout : ${r.bootout}`);

    const arret = lancer(home, ["--uninstall", "--launchd-unload"], env);
    assert.ok(!faux.appels().some((a) => a[0] === "bootout" && LEGACY.split(":").some((l) => a[1].endsWith(`/${l}`))), "aucun bootout historique sur une sonde impossible");
    assert.equal(rapport(arret).legacy_probe, "impossible");
    assert.match(arret.stdout, /legacy-label probe could not run/);
  });
}

// LE LIEN HISTORIQUE DU PLUGIN — Run 6 (Task 11). Le plugin s'appelle
// `valxos-messenger` ; les sessions vivantes d'une maison lisent encore
// `skills/cc2cc-v2`. L'installeur pose le nouveau lien, garde l'ancien, le nomme,
// et dit le geste de retrait sans jamais l'exécuter.
test("un lien historique skills/cc2cc-v2 vers ce dépôt est gardé, nommé, et son retrait est dit — jamais fait", (t) => {
  const home = fauxHome(t);
  const skills = path.join(home, ".claude", "skills");
  const historique = path.join(skills, "cc2cc-v2");
  fs.mkdirSync(skills, { recursive: true }); fs.symlinkSync(repo, historique);
  const r = lancer(home, ["--no-enable"]);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const nouveau = path.join(skills, "valxos-messenger");
  assert.equal(fs.lstatSync(nouveau).isSymbolicLink(), true, "le nouveau lien est posé");
  assert.equal(fs.readlinkSync(nouveau), repo);
  assert.equal(fs.lstatSync(historique).isSymbolicLink(), true, "le lien historique reste (des sessions vivantes le lisent)");
  assert.equal(fs.readlinkSync(historique), repo, "le lien historique n'est pas modifié");
  assert.equal(rapport(r).legacy_plugin_link, historique);
  assert.ok(r.stdout.includes(`legacy plugin link kept (live sessions read it): ${historique}`), r.stdout);
  assert.ok(r.stdout.includes(`claude plugin disable cc2cc-v2@skills-dir && rm ${historique}`), r.stdout);
});

test("un skills/cc2cc-v2 qui ne pointe PAS vers ce dépôt n'est ni nommé ni touché", (t) => {
  const home = fauxHome(t);
  const skills = path.join(home, ".claude", "skills");
  const ailleurs = path.join(home, "autre-checkout"); fs.mkdirSync(ailleurs);
  const historique = path.join(skills, "cc2cc-v2");
  fs.mkdirSync(skills, { recursive: true }); fs.symlinkSync(ailleurs, historique);
  const r = lancer(home, ["--no-enable"]);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.equal(rapport(r).legacy_plugin_link, null);
  assert.ok(!r.stdout.includes("claude plugin disable cc2cc-v2@skills-dir"), r.stdout);
  assert.equal(fs.readlinkSync(historique), ailleurs, "un lien qui n'est pas le nôtre n'est pas touché");
});

// F1 (passe adverse du Run 6, 28/09) — UN BOOTOUT NE SURVIT PAS AU REDÉMARRAGE.
// Les plists historiques restent dans ~/Library/LaunchAgents (Camp B, sans
// marqueur, jamais touchés) : launchd les recharge à la connexion suivante, et
// la porte historique dispute 8790 à la nouvelle. Après chaque bootout
// historique réussi, l'installeur pose `launchctl disable` (réversible par
// `enable`) et le dit ; un chargement refusé n'écrit aucun plist neuf.
test("F1 — --uninstall --launchd-unload pose `disable` après chaque bootout historique, le rapporte, et dit le retour arrière", (t) => {
  const home = fauxHome(t); const faux = fauxLaunchctl(home, ["com.example.cc2cc-facteur", "com.example.cc2cc-web"]);
  const r = lancer(home, ["--uninstall", "--launchd-unload"], { VALXOS_MESSENGER_LAUNCHCTL: faux.script, VALXOS_LEGACY_LABELS: LEGACY });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const uid = process.getuid();
  const gestes = faux.appels().filter((a) => a[0] !== "print").map((a) => `${a[0]} ${a[1]}`);
  for (const l of LEGACY.split(":")) {
    const bootout = gestes.indexOf(`bootout gui/${uid}/${l}`);
    const disable = gestes.indexOf(`disable gui/${uid}/${l}`);
    assert.ok(bootout >= 0, `bootout ${l}`);
    assert.ok(disable > bootout, `disable ${l} APRÈS son bootout : ${gestes.join(" | ")}`);
    assert.match(r.stdout, new RegExp(`launchctl enable gui/\\$\\(id -u\\)/${l.replace(/\./g, "\\.")}`), `retour arrière dit pour ${l}`);
  }
  assert.ok(!gestes.some((g) => g.startsWith("disable") && g.includes("com.valxos.messenger")), "nos propres labels ne sont jamais désactivés");
  assert.deepEqual(rapport(r).legacy_disabled, LEGACY.split(":"));
});

test("F1 — sous --dry-run, le disable se montre sans s'exécuter", (t) => {
  const home = fauxHome(t); const faux = fauxLaunchctl(home, ["com.example.cc2cc-web"]);
  const r = lancer(home, ["--uninstall", "--dry-run", "--launchd-unload"], { VALXOS_MESSENGER_LAUNCHCTL: faux.script, VALXOS_LEGACY_LABELS: LEGACY });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.ok(r.stdout.includes(`[would run] ${faux.script} disable gui/${process.getuid()}/com.example.cc2cc-web`));
  assert.ok(!faux.appels().some((a) => a[0] === "disable"), "aucun disable exécuté en dry-run");
  assert.deepEqual(rapport(r).legacy_disabled, []);
});

for (const [cas, charges, muet] of [["label historique chargé", ["com.example.cc2cc-web"], false], ["sonde impossible", [], true]]) {
  test(`F1 — --launchd-load refusé (${cas}) n'écrit AUCUN plist neuf`, (t) => {
    const home = fauxHome(t);
    const faux = muet ? fauxLaunchctlMuet(home) : fauxLaunchctl(home, charges);
    const agents = path.join(home, "Library", "LaunchAgents");
    fs.mkdirSync(agents, { recursive: true });
    fs.writeFileSync(path.join(agents, "com.example.cc2cc-web.plist"), "<plist/>\n");
    const avant = fs.readdirSync(agents).sort();
    const r = lancer(home, ["--launchd-load", "--no-enable"], { VALXOS_MESSENGER_LAUNCHCTL: faux.script, VALXOS_LEGACY_LABELS: LEGACY });
    assert.notEqual(r.status, 0);
    assert.deepEqual(fs.readdirSync(agents).sort(), avant, "LaunchAgents intact : aucun plist neuf à côté du label historique");
    assert.ok(rapport(r).launchd.plists.every((p) => /not written/.test(p.status)), JSON.stringify(rapport(r).launchd.plists));
    assert.ok(!faux.appels().some((a) => a[0] === "bootstrap"), "aucun bootstrap");
  });
}

test("F1 — le doctor nomme les plists historiques restés dans LaunchAgents à côté des nôtres (rouge tant qu'ils ne sont pas désactivés, N2)", (t) => {
  const home = fauxHome(t);
  const faux = fauxLaunchctlAEtat(home);
  const agents = path.join(home, "Library", "LaunchAgents");
  fs.mkdirSync(agents, { recursive: true });
  const docteur = () => {
    const r = spawnSync(process.execPath, [path.join(repo, "src/bin/valxos-doctor.js")], {
      encoding: "utf8", env: environnement(home, { VALXOS_LEGACY_LABELS: LEGACY, VALXOS_MESSENGER_LAUNCHCTL: faux.script })
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const vide = docteur();
  assert.deepEqual(vide.checks.launchdLegacy.plists, [], "rien d'historique : rien à nommer");
  assert.equal(vide.checks.launchdLegacy.aCoteDesNotres, false);

  fs.writeFileSync(path.join(agents, "com.example.cc2cc-web.plist"), "<plist/>\n");
  fs.writeFileSync(path.join(agents, "com.valxos.messenger.web.plist"), "<plist/>\n");
  const r = docteur();
  const l = r.checks.launchdLegacy;
  assert.deepEqual(l.plists.map((p) => p.label), ["com.example.cc2cc-web"]);
  assert.equal(l.plists[0].path, path.join(agents, "com.example.cc2cc-web.plist"));
  assert.equal(l.aCoteDesNotres, true);
  assert.match(l.remede, /launchctl disable gui\/\$\(id -u\)\/com\.example\.cc2cc-web/);
  assert.equal(r.checks.launchdLegacyOk, false, "N2 : activé à côté des nôtres, le doctor rougit");
  assert.equal(vide.checks.launchdLegacyOk, true);
});

// F6 (passe adverse du Run 6, 28/09) — `VALXOS_LEGACY_LABELS=` (posée mais
// vide) sondait ZÉRO label et rendait un « ok » vert. Vide compte pour absente :
// les labels dérivés sont sondés. (Les labels dérivés portent le nom de compte :
// ils se calculent ici, jamais écrits en clair ; le faux launchctl les tient.)
test("F6 — VALXOS_LEGACY_LABELS vide compte pour absente : les labels dérivés sont sondés, le chargement refusé", async (t) => {
  const { legacyLabels } = await import("../src/lib/launchd-labels.js");
  const derives = legacyLabels({});
  assert.equal(derives.length, 2);
  assert.deepEqual(legacyLabels({ VALXOS_LEGACY_LABELS: "" }), derives);
  assert.deepEqual(legacyLabels({ VALXOS_LEGACY_LABELS: "   " }), derives);
  const home = fauxHome(t); const faux = fauxLaunchctl(home, [derives[1]]);
  const r = lancer(home, ["--launchd-load", "--no-enable"], { VALXOS_MESSENGER_LAUNCHCTL: faux.script, VALXOS_LEGACY_LABELS: "" });
  assert.notEqual(r.status, 0, "un label dérivé chargé refuse le chargement");
  assert.deepEqual(rapport(r).launchd.legacy_loaded, [derives[1]]);
  assert.ok(!faux.appels().some((a) => a[0] === "bootstrap"), "aucun bootstrap");
});

// N2 (seconde passe adverse du Run 6, 28/09) — UN PLIST HISTORIQUE PRÉSENT MAIS
// PAS CHARGÉ se désactive aussi. Arrêté à la main (`bootout` sans `disable`),
// il reste « activé sur le disque » et launchd le recharge à la connexion
// suivante. Le faux launchctl tient ici un ÉTAT : `disable`/`enable` écrivent
// dans un fichier, `print-disabled` le relit (forme macOS `"label" =>
// disabled`), `print` répond 113 (rien de chargé).
function fauxLaunchctlAEtat(home, { charges = [] } = {}) {
  const journal = path.join(home, "launchctl.journal");
  const etat = path.join(home, "launchctl.disabled");
  const script = path.join(home, "faux-launchctl-etat");
  fs.writeFileSync(etat, "");
  fs.writeFileSync(script, "#!/bin/sh\n" +
    `printf '%s\\t' "$@" >> ${JSON.stringify(journal)}; printf '\\n' >> ${JSON.stringify(journal)}\n` +
    `case "$1" in\n` +
    `  print) case "$2" in ${charges.map((l) => `*/${l}) exit 0;;`).join(" ")} *) exit 113;; esac;;\n` +
    `  print-disabled) echo "disabled services = {"; while read l; do [ -n "$l" ] && printf '\\t"%s" => disabled\\n' "$l"; done < ${JSON.stringify(etat)}; echo "}"; exit 0;;\n` +
    `  disable) echo "\${2##*/}" >> ${JSON.stringify(etat)}; exit 0;;\n` +
    `  enable) grep -v -x "\${2##*/}" ${JSON.stringify(etat)} > ${JSON.stringify(etat)}.t; mv ${JSON.stringify(etat)}.t ${JSON.stringify(etat)}; exit 0;;\n` +
    `esac\nexit 0\n`, { mode: 0o755 });
  const appels = () => fs.existsSync(journal) ? fs.readFileSync(journal, "utf8").trim().split("\n").filter(Boolean).map((l) => l.split("\t").filter(Boolean)) : [];
  return { script, appels, desactives: () => fs.readFileSync(etat, "utf8").split("\n").filter(Boolean) };
}
function plistsHistoriques(home) {
  const agents = path.join(home, "Library", "LaunchAgents");
  fs.mkdirSync(agents, { recursive: true });
  for (const l of LEGACY.split(":")) fs.writeFileSync(path.join(agents, `${l}.plist`), "<plist><dict><key>RunAtLoad</key><true/></dict></plist>\n");
  return agents;
}

test("N2 — plists historiques présents mais pas chargés : --uninstall --launchd-unload les désactive, sans bootout", (t) => {
  const home = fauxHome(t); plistsHistoriques(home); const faux = fauxLaunchctlAEtat(home);
  const r = lancer(home, ["--uninstall", "--launchd-unload"], { VALXOS_MESSENGER_LAUNCHCTL: faux.script, VALXOS_LEGACY_LABELS: LEGACY });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.deepEqual(faux.desactives().sort(), LEGACY.split(":").sort(), "chaque plist présent est désactivé");
  assert.deepEqual(rapport(r).legacy_disabled.sort(), LEGACY.split(":").sort());
  assert.ok(!faux.appels().some((a) => a[0] === "bootout" && LEGACY.split(":").some((l) => a[1].endsWith(l))), "rien n'était chargé : aucun bootout historique");
  assert.match(r.stdout, /launchctl enable gui\/\$\(id -u\)\/com\.example\.cc2cc-web/, "le retour arrière est dit");
});

test("N2 — --launchd-load refuse tant qu'un plist historique présent n'est pas désactivé, puis charge une fois désactivé", (t) => {
  const home = fauxHome(t); const agents = plistsHistoriques(home); const faux = fauxLaunchctlAEtat(home);
  const env = { VALXOS_MESSENGER_LAUNCHCTL: faux.script, VALXOS_LEGACY_LABELS: LEGACY };
  const refus = lancer(home, ["--launchd-load", "--no-enable"], env);
  assert.notEqual(refus.status, 0);
  assert.ok(!faux.appels().some((a) => a[0] === "bootstrap"), "aucun bootstrap");
  assert.ok(!fs.existsSync(path.join(agents, "com.valxos.messenger.web.plist")), "aucun plist neuf écrit");
  assert.match(refus.stdout, /launchctl disable gui\/\$\(id -u\)\/com\.example\.cc2cc-web/);
  assert.deepEqual(rapport(refus).launchd.legacy_enabled_plists.sort(), LEGACY.split(":").sort());

  assert.equal(lancer(home, ["--uninstall", "--launchd-unload"], env).status, 0);
  const charge = lancer(home, ["--launchd-load", "--no-enable"], env);
  assert.equal(charge.status, 0, `${charge.stdout}\n${charge.stderr}`);
  assert.equal(faux.appels().filter((a) => a[0] === "bootstrap").length, 2, "les deux plists neufs se chargent");
});

test("N2 — le doctor est ROUGE quand un plist historique non désactivé est à côté des nôtres, calme une fois désactivé", (t) => {
  const home = fauxHome(t); plistsHistoriques(home); const faux = fauxLaunchctlAEtat(home);
  const agents = path.join(home, "Library", "LaunchAgents");
  fs.writeFileSync(path.join(agents, "com.valxos.messenger.web.plist"), "<plist/>\n");
  const docteur = () => {
    const r = spawnSync(process.execPath, [path.join(repo, "src/bin/valxos-doctor.js")], {
      encoding: "utf8", env: environnement(home, { VALXOS_LEGACY_LABELS: LEGACY, VALXOS_MESSENGER_LAUNCHCTL: faux.script })
    });
    return JSON.parse(r.stdout);
  };
  const avant = docteur();
  assert.equal(avant.ok, false, "rouge : un plist historique activé à côté du nôtre");
  assert.deepEqual(avant.checks.launchdLegacy.nonDesactives.sort(), LEGACY.split(":").sort());
  for (const l of LEGACY.split(":")) spawnSync(faux.script, ["disable", `gui/${process.getuid()}/${l}`]);
  const apres = docteur();
  assert.deepEqual(apres.checks.launchdLegacy.nonDesactives, []);
  assert.equal(apres.checks.launchdLegacy.remede, undefined, "calme une fois désactivé");
  assert.equal(apres.checks.launchdLegacyOk, true);
});

// M2 (troisième passe adverse, 28/09) — LE RETOUR ARRIÈRE N'EST PAS F1 À
// L'ENVERS. La ligne d'annulation disait `enable` + `bootstrap` des labels
// historiques ; les nouveaux agents restaient activés sur le disque, et à la
// connexion suivante quatre agents RunAtLoad se disputaient 8790. L'annulation
// arrête ET désactive d'abord nos deux agents.
test("M2 — la ligne d'annulation désactive nos agents AVANT de réactiver les historiques", (t) => {
  const home = fauxHome(t); plistsHistoriques(home); const faux = fauxLaunchctlAEtat(home);
  const r = lancer(home, ["--uninstall", "--launchd-unload"], { VALXOS_MESSENGER_LAUNCHCTL: faux.script, VALXOS_LEGACY_LABELS: LEGACY });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const annulation = r.stdout.slice(r.stdout.indexOf("To undo"));
  for (const job of ["facteur", "web"]) {
    const disable = annulation.indexOf(`launchctl disable gui/$(id -u)/com.valxos.messenger.${job}`);
    const bootout = annulation.indexOf(`launchctl bootout gui/$(id -u)/com.valxos.messenger.${job}`);
    const enable = annulation.indexOf(`launchctl enable gui/$(id -u)/com.example.cc2cc-${job}`);
    assert.ok(bootout >= 0 && disable > bootout, `${job} : bootout puis disable de notre agent\n${annulation}`);
    assert.ok(enable > disable, `${job} : l'historique ne se réactive qu'après`);
  }
});
