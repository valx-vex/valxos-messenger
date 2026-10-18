// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// L'INSTALLEUR ÉCRIT LES PLISTS LAUNCHD — et ne charge rien sans qu'on le lui
// demande en toutes lettres.
//
// Aucun test de ce fichier n'approche `~/Library/LaunchAgents`, ni un bureau
// réel, ni `launchctl` : chaque HOME naît sous mkdtemp (test/aide-installeur.js),
// le bureau y est posé explicitement, et le seul `launchctl` que ces tests
// connaissent est un script jetable qui NOTE ce qu'on lui demande au lieu de
// le faire.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { MARKER, renderPlist, verdict } from "../scripts/launchd/plists.js";
import { arbre, fauxHome, lancer, rapport, repo } from "./aide-installeur.js";
import { quarantaine } from "./aide-quarantaine.js";

const MARQUE = "<!-- written by valxos-messenger install -->";
const LABELS = ["com.valxos.messenger.facteur", "com.valxos.messenger.web"];

function dossierLaunchd(home) {
  return path.join(home, "Library", "LaunchAgents");
}

function cheminDuPlist(home, label) {
  return path.join(dossierLaunchd(home), `${label}.plist`);
}

// ── LE CRASH DE LA RC2 ──────────────────────────────────────────────────────
// `const claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(claudeHome)`
// se lit lui-même avant d'exister : sans CLAUDE_CONFIG_DIR dans l'env — c'est
// à dire sur toute machine qui n'est pas la nôtre — l'installeur meurt au
// chargement, dans TOUS ses modes, dry-run compris.
test("l'installeur démarre sans CLAUDE_CONFIG_DIR — le plugin va sous ~/.claude", (t) => {
  const home = fauxHome(t);
  const sortie = lancer(home, ["--dry-run"]);
  assert.equal(sortie.status, 0, `${sortie.stdout}\n${sortie.stderr}`);
  assert.doesNotMatch(sortie.stderr, /before initialization/);
  assert.match(sortie.stdout, new RegExp(`mkdir -p ${path.join(home, ".claude", "skills")}`));
});

// ── ÉCRIRE LES DEUX PLISTS ──────────────────────────────────────────────────
test("--launchd écrit deux plists marqués, aux chemins réels, sous ~/Library/LaunchAgents", (t) => {
  const home = fauxHome(t);
  const sortie = lancer(home, ["--launchd", "--no-enable"]);
  assert.equal(sortie.status, 0, `${sortie.stdout}\n${sortie.stderr}`);

  for (const label of LABELS) {
    const plist = cheminDuPlist(home, label);
    assert.ok(fs.existsSync(plist), `${plist} manque`);
    const texte = fs.readFileSync(plist, "utf8");
    assert.ok(texte.includes(MARQUE), `${label} ne porte pas la marque de l'installeur`);
    assert.match(texte, new RegExp(`<key>Label</key>\\s*<string>${label.replace(/\./g, "\\.")}</string>`));
    assert.doesNotMatch(texte, /__[A-Z_]+__/, `${label} garde un gabarit non substitué`);
    // L'entrée STABLE du PATH (ici le lien $home/bin/node du harnais), jamais le
    // binaire versionné qu'un `brew upgrade node` supprime — et elle mène bien
    // au node qui installe.
    const nodeDuPlist = path.join(home, "bin", "node");
    assert.ok(texte.includes(`<string>${nodeDuPlist}</string>`), `le plist n'épingle pas l'entrée stable du PATH :\n${texte}`);
    assert.equal(fs.realpathSync(nodeDuPlist), fs.realpathSync(process.execPath));
    assert.ok(texte.includes(`<string>${path.join(home, "bin")}:/usr/local/bin:/usr/bin:/bin</string>`), "le PATH du plist part du même dossier stable");
    assert.ok(texte.includes(`${path.join(home, ".valxos-messenger", "logs")}/`), "les journaux vont sous le bureau");
    // L'ancien nom ne revient pas par la porte des gabarits — on regarde la
    // SOURCE, pas le rendu : le chemin d'un checkout peut s'appeler comme il veut.
    const gabarit = fs.readFileSync(path.join(repo, "scripts", "launchd", `${label}.plist`), "utf8");
    assert.doesNotMatch(gabarit, /cc2cc/i, `le gabarit ${label} porte l'ancien nom`);
    assert.doesNotMatch(label, /cc2cc/i);
  }
  const facteur = fs.readFileSync(cheminDuPlist(home, LABELS[0]), "utf8");
  assert.ok(facteur.includes(`<string>${path.join(repo, "src", "bin", "facteur.js")}</string>`));
  const web = fs.readFileSync(cheminDuPlist(home, LABELS[1]), "utf8");
  assert.ok(web.includes(`<string>${path.join(repo, "src", "bin", "valxos-web.js")}</string>`));
  // Sans --operator, AUCUNE clef d'opérateur dans le plist : une valeur par
  // défaut ici primerait en silence sur web.env (auth.js lit l'env avant le
  // fichier), et web.env est le seul endroit prévu pour régler la porte.
  assert.doesNotMatch(web, /VALXOS_WEB_OPERATEUR<\/key>/, "le plist web ne doit pas porter d'opérateur qu'on n'a pas demandé");

  const json = rapport(sortie);
  assert.equal(json.ok, true);
  assert.equal(json.launchd.operator, null);
  assert.deepEqual(
    json.launchd.plists.map((p) => [p.label, p.path, p.status]),
    LABELS.map((label) => [label, cheminDuPlist(home, label), "written"])
  );
  assert.match(sortie.stdout, /launchctl bootstrap gui\/\$\(id -u\)/, "le résumé dit comment charger à la main");
});

test("--operator épingle l'opérateur dans le plist web, et le résumé dit qu'il prime sur web.env", (t) => {
  const home = fauxHome(t);
  const sortie = lancer(home, ["--launchd", "--no-enable", "--operator", "alice"]);
  assert.equal(sortie.status, 0, `${sortie.stdout}\n${sortie.stderr}`);
  const web = fs.readFileSync(cheminDuPlist(home, LABELS[1]), "utf8");
  assert.match(web, /<key>VALXOS_WEB_OPERATEUR<\/key>\s*<string>alice<\/string>/);
  assert.equal(rapport(sortie).launchd.operator, "alice");
  assert.match(sortie.stdout, /precedence over web\.env/, "l'opérateur épinglé prime sur web.env, et le résumé le dit");
});

// web.env est « le seul endroit prévu pour régler la porte » (valxos-web.js) :
// l'installeur ne le contredit pas en silence.
test("web.env nomme alice : sans --operator le plist ne porte pas la clef, et le résumé renvoie à web.env", (t) => {
  const home = fauxHome(t);
  const bureau = path.join(home, ".valxos-messenger");
  fs.mkdirSync(bureau, { recursive: true });
  fs.writeFileSync(path.join(bureau, "web.env"), "VALXOS_WEB_OPERATEUR=alice\n");

  const sortie = lancer(home, ["--launchd", "--no-enable"]);
  assert.equal(sortie.status, 0, `${sortie.stdout}\n${sortie.stderr}`);
  const web = fs.readFileSync(cheminDuPlist(home, LABELS[1]), "utf8");
  assert.doesNotMatch(web, /VALXOS_WEB_OPERATEUR<\/key>/);
  assert.doesNotMatch(web, /alice/, "l'installeur ne recopie pas non plus le nom de web.env dans le plist");
  assert.match(sortie.stdout, /web operator:\s+from web\.env/);
  assert.equal(rapport(sortie).launchd.webEnvOperator, true);
});

test("web.env ne nomme personne et pas de --operator : le résumé prévient que la porte refusera de démarrer", (t) => {
  const home = fauxHome(t);
  const sortie = lancer(home, ["--launchd", "--no-enable"]);
  assert.equal(sortie.status, 0, `${sortie.stdout}\n${sortie.stderr}`);
  assert.match(sortie.stdout, /web operator:\s+NOT SET/);
  assert.match(sortie.stdout, /web\.env/);
  assert.match(sortie.stdout, /--operator/);
  assert.equal(rapport(sortie).launchd.webEnvOperator, false);
});

test("un opérateur irrecevable est refusé avant tout geste", (t) => {
  const home = fauxHome(t);
  const avant = arbre(home);
  const sortie = lancer(home, ["--launchd", "--no-enable", "--operator", "pas un nom"]);
  assert.equal(sortie.status, 2, `${sortie.stdout}\n${sortie.stderr}`);
  assert.match(sortie.stderr, /VALXOS_WEB_OPERATEUR|--operator/);
  assert.deepEqual(arbre(home), avant, "un refus ne touche pas le disque");
});

test("--dry-run --launchd montre ce qui serait écrit et n'écrit RIEN", (t) => {
  const home = fauxHome(t);
  const avant = arbre(home);
  const sortie = lancer(home, ["--dry-run", "--launchd"]);
  assert.equal(sortie.status, 0, `${sortie.stdout}\n${sortie.stderr}`);
  for (const label of LABELS) {
    assert.ok(sortie.stdout.includes(`[would write] ${cheminDuPlist(home, label)}`), `le dry-run ne nomme pas ${label}`);
  }
  assert.ok(sortie.stdout.includes(`<string>${LABELS[0]}</string>`), "le dry-run montre le contenu, pas seulement le chemin");
  assert.deepEqual(arbre(home), avant, "un dry-run laisse le HOME exactement tel qu'il l'a trouvé");
  assert.equal(rapport(sortie).launchd.plists.every((p) => p.status === "would-write"), true);
});

// ── CE QUI EST DÉJÀ LÀ ──────────────────────────────────────────────────────
test("un plist étranger à la cible est refusé intact ; --force le met de côté avec une sauvegarde datée", (t) => {
  const home = fauxHome(t);
  const cible = cheminDuPlist(home, LABELS[0]);
  fs.mkdirSync(dossierLaunchd(home), { recursive: true });
  const etranger = `<?xml version="1.0"?>\n<plist version="1.0"><dict><key>Label</key><string>${LABELS[0]}</string></dict></plist>\n`;
  fs.writeFileSync(cible, etranger);

  const refus = lancer(home, ["--launchd", "--no-enable"]);
  assert.equal(refus.status, 1, `${refus.stdout}\n${refus.stderr}`);
  assert.match(refus.stderr, /did not write/);
  assert.match(refus.stderr, /--force/);
  assert.equal(fs.readFileSync(cible, "utf8"), etranger, "le fichier refusé est intact, octet pour octet");
  const json = rapport(refus);
  assert.equal(json.ok, false);
  assert.equal(json.launchd.plists[0].status, "conflict");
  assert.equal(json.launchd.plists[1].status, "written", "l'autre plist n'avait rien devant lui : il est écrit");

  const force = lancer(home, ["--launchd", "--no-enable", "--force"]);
  assert.equal(force.status, 0, `${force.stdout}\n${force.stderr}`);
  const sauvegardes = fs.readdirSync(dossierLaunchd(home)).filter((f) => f.startsWith(`${LABELS[0]}.plist.bak.`));
  assert.equal(sauvegardes.length, 1, "une sauvegarde datée, exactement une");
  assert.equal(fs.readFileSync(path.join(dossierLaunchd(home), sauvegardes[0]), "utf8"), etranger);
  assert.ok(fs.readFileSync(cible, "utf8").includes(MARQUE));
  assert.deepEqual(rapport(force).launchd.plists.map((p) => p.status), ["written", "unchanged"]);
});

test("rejouer --launchd laisse un plist identique en paix et rafraîchit le nôtre, sauvegarde gardée, quand il change", (t) => {
  const home = fauxHome(t);
  const premier = lancer(home, ["--launchd", "--no-enable"]);
  assert.equal(premier.status, 0, `${premier.stdout}\n${premier.stderr}`);
  const contenu = LABELS.map((label) => fs.readFileSync(cheminDuPlist(home, label), "utf8"));

  const second = lancer(home, ["--launchd", "--no-enable"]);
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
  assert.deepEqual(rapport(second).launchd.plists.map((p) => p.status), ["unchanged", "unchanged"]);
  assert.deepEqual(fs.readdirSync(dossierLaunchd(home)).sort(), LABELS.map((l) => `${l}.plist`), "aucune sauvegarde pour un fichier identique");
  assert.deepEqual(LABELS.map((label) => fs.readFileSync(cheminDuPlist(home, label), "utf8")), contenu);

  const troisieme = lancer(home, ["--launchd", "--no-enable", "--operator", "bob"]);
  assert.equal(troisieme.status, 0, `${troisieme.stdout}\n${troisieme.stderr}`);
  assert.deepEqual(rapport(troisieme).launchd.plists.map((p) => p.status), ["unchanged", "updated"]);
  const sauvegardes = fs.readdirSync(dossierLaunchd(home)).filter((f) => f.startsWith(`${LABELS[1]}.plist.bak.`));
  assert.equal(sauvegardes.length, 1);
  assert.equal(fs.readFileSync(path.join(dossierLaunchd(home), sauvegardes[0]), "utf8"), contenu[1], "l'ancien plist survit dans la sauvegarde");
  assert.match(fs.readFileSync(cheminDuPlist(home, LABELS[1]), "utf8"), /<key>VALXOS_WEB_OPERATEUR<\/key>\s*<string>bob<\/string>/);
});

// ── RETIRER ─────────────────────────────────────────────────────────────────
test("--uninstall retire les plists marqués, et rien d'autre", (t) => {
  const home = fauxHome(t);
  assert.equal(lancer(home, ["--launchd", "--no-enable"]).status, 0);
  // Un voisin dans le même dossier, et un plist SANS marque à l'un de nos chemins.
  const voisin = path.join(dossierLaunchd(home), "com.example.autre.plist");
  fs.writeFileSync(voisin, "<plist/>\n");
  const sansMarque = `<plist version="1.0"><dict><key>Label</key><string>${LABELS[1]}</string></dict></plist>\n`;
  fs.writeFileSync(cheminDuPlist(home, LABELS[1]), sansMarque);

  // Un faux launchctl où rien n'est chargé : la sonde des labels historiques
  // prend le chemin « ok » exprès, pas la branche « impossible » d'un PATH vide.
  const faux = fauxLaunchctl(home);
  const env = { VALXOS_MESSENGER_LAUNCHCTL: faux.script };
  const simulation = lancer(home, ["--uninstall", "--dry-run"], env);
  assert.equal(simulation.status, 0, `${simulation.stdout}\n${simulation.stderr}`);
  assert.ok(simulation.stdout.includes(`rm ${cheminDuPlist(home, LABELS[0])}`), "le dry-run annonce le retrait");
  assert.ok(fs.existsSync(cheminDuPlist(home, LABELS[0])), "et ne l'exécute pas");

  const sortie = lancer(home, ["--uninstall"], env);
  assert.equal(sortie.status, 0, `${sortie.stdout}\n${sortie.stderr}`);
  assert.ok(!fs.existsSync(cheminDuPlist(home, LABELS[0])), "le plist marqué du Facteur est retiré");
  assert.equal(fs.readFileSync(cheminDuPlist(home, LABELS[1]), "utf8"), sansMarque, "un plist sans marque reste, même à notre chemin");
  assert.equal(fs.readFileSync(voisin, "utf8"), "<plist/>\n", "le voisin n'est pas regardé");
  const json = rapport(sortie);
  assert.ok(json.removed.includes(cheminDuPlist(home, LABELS[0])));
  assert.ok(json.kept.some((k) => k.name === LABELS[1] && /no marker/.test(k.reason)), JSON.stringify(json.kept));
  assert.deepEqual(json.bootout, [LABELS[0]]);
  assert.equal(json.legacy_probe, "ok", "la sonde des labels historiques a tourné, et rien n'est chargé");
  assert.equal(rapport(simulation).legacy_probe, "ok", "le dry-run sonde aussi, par le même faux");
  assert.deepEqual(faux.appels(), [], "sans --launchd-unload, aucun geste launchctl");
  assert.ok(sortie.stdout.includes(`launchctl bootout gui/$(id -u)/${LABELS[0]}`), "le résumé dit comment arrêter le service encore chargé");
});

// ── CHARGER — SEULEMENT SUR LE MOT EXPLICITE, ET JAMAIS POUR DE VRAI ICI ────
// `print` (la sonde des labels historiques, Task 9) répond 113 — « pas chargé »
// — sauf pour les labels de `charges` : sans ça, un faux qui sort 0 pour TOUT
// ferait croire les deux labels historiques chargés et bloquerait chaque
// --launchd-load. Les sondes sont notées à part (`sondes()`) : `appels()` reste
// la liste exacte des gestes (bootstrap, bootout).
function fauxLaunchctl(home, code = 0, plainte = "", charges = []) {
  const journal = path.join(home, "launchctl.journal");
  const script = path.join(home, "faux-launchctl");
  fs.writeFileSync(
    script,
    "#!/bin/sh\n" +
      `printf '%s\\t' "$@" >> ${JSON.stringify(journal)}\n` +
      `printf '\\n' >> ${JSON.stringify(journal)}\n` +
      `if [ "$1" = print ]; then case "$2" in ${charges.map((l) => `*/${l}) exit 0;;`).join(" ")} *) exit 113;; esac; fi\n` +
      (plainte ? `echo ${JSON.stringify(plainte)} >&2\n` : "") +
      `exit ${code}\n`,
    { mode: 0o755 }
  );
  const tout = () =>
    fs.existsSync(journal)
      ? fs.readFileSync(journal, "utf8").trim().split("\n").map((ligne) => ligne.split("\t").filter(Boolean))
      : [];
  const appels = () => tout().filter((a) => a[0] !== "print");
  const sondes = () => tout().filter((a) => a[0] === "print");
  return { script, appels, sondes };
}

test("--launchd seul n'appelle jamais launchctl ; --launchd-load lance exactement `bootstrap gui/<uid> <plist>`", (t) => {
  const home = fauxHome(t);
  const faux = fauxLaunchctl(home);
  const env = { VALXOS_MESSENGER_LAUNCHCTL: faux.script, VALXOS_LEGACY_LABELS: "com.example.cc2cc-facteur:com.example.cc2cc-web" };

  const sans = lancer(home, ["--launchd", "--no-enable"], env);
  assert.equal(sans.status, 0, `${sans.stdout}\n${sans.stderr}`);
  assert.deepEqual(faux.appels(), [], "--launchd n'a rien chargé");
  assert.equal(rapport(sans).launchd.loaded, null);

  const avec = lancer(home, ["--launchd-load", "--no-enable"], env);
  assert.equal(avec.status, 0, `${avec.stdout}\n${avec.stderr}`);
  const uid = process.getuid();
  assert.deepEqual(
    faux.appels(),
    LABELS.map((label) => ["bootstrap", `gui/${uid}`, cheminDuPlist(home, label)]),
    "la commande exacte, une par plist, dans l'ordre"
  );
  assert.deepEqual(
    faux.sondes(),
    ["com.example.cc2cc-facteur", "com.example.cc2cc-web"].map((l) => ["print", `gui/${uid}/${l}`]),
    "les labels historiques sont sondés (aucun chargé) avant de charger"
  );
  const json = rapport(avec);
  assert.deepEqual(json.launchd.legacy_loaded, []);
  assert.deepEqual(
    json.launchd.loaded.map((l) => [l.label, l.ok, l.command]),
    LABELS.map((label) => [label, true, [faux.script, "bootstrap", `gui/${uid}`, cheminDuPlist(home, label)]])
  );
  assert.doesNotMatch(avec.stdout, /pass --launchd-load/, "le résumé ne demande plus de charger à la main");
});

test("un bootstrap qui échoue rend le verdict rouge et montre la plainte de launchctl", (t) => {
  const home = fauxHome(t);
  const faux = fauxLaunchctl(home, 125, "Bootstrap failed: 125: Domain does not support specified action");
  const sortie = lancer(home, ["--launchd-load", "--no-enable"], { VALXOS_MESSENGER_LAUNCHCTL: faux.script });
  assert.equal(sortie.status, 1, `${sortie.stdout}\n${sortie.stderr}`);
  const json = rapport(sortie);
  assert.equal(json.ok, false);
  assert.deepEqual(json.launchd.loaded.map((l) => l.ok), [false, false]);
  assert.match(json.launchd.loaded[0].stderr, /Bootstrap failed: 125/);
  assert.match(sortie.stdout, /Bootstrap failed: 125/, "la plainte est dans le résumé humain, pas seulement dans le JSON");
});

// `launchctl bootstrap` d'un service DÉJÀ chargé sort en 5 (« Input/output
// error ») : ce n'est pas une panne, c'est « déjà là ». L'installeur le
// reconnaît et imprime le bootout à faire à la main — jamais exécuté d'ici.
// Rouge si le plist vient d'être écrit ou rafraîchi (le service tourne sur
// l'ANCIEN fichier), vert s'il est inchangé (rien à recharger).
test("bootstrap code 5 = déjà chargé : la commande bootout est imprimée, jamais exécutée — rouge sur un plist neuf, vert sur un plist inchangé", (t) => {
  const home = fauxHome(t);
  const faux = fauxLaunchctl(home, 5, "Bootstrap failed: 5: Input/output error");
  const env = { VALXOS_MESSENGER_LAUNCHCTL: faux.script };

  const premier = lancer(home, ["--launchd-load", "--no-enable"], env);
  assert.equal(premier.status, 1, `${premier.stdout}\n${premier.stderr}`);
  const json = rapport(premier);
  assert.deepEqual(json.launchd.loaded.map((l) => [l.ok, l.alreadyLoaded]), [[false, true], [false, true]]);
  assert.match(premier.stdout, /already loaded/);
  assert.ok(premier.stdout.includes(`launchctl bootout gui/$(id -u)/${LABELS[0]}`), "le bootout à faire à la main est imprimé");
  assert.deepEqual(
    faux.appels().map((a) => a[0]),
    ["bootstrap", "bootstrap"],
    "aucun bootout n'a été exécuté : seuls les deux bootstrap"
  );

  const second = lancer(home, ["--launchd-load", "--no-enable"], env);
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
  const rejeu = rapport(second);
  assert.deepEqual(rejeu.launchd.plists.map((p) => p.status), ["unchanged", "unchanged"]);
  assert.deepEqual(rejeu.launchd.loaded.map((l) => [l.ok, l.alreadyLoaded]), [[true, true], [true, true]]);
  assert.equal(rejeu.ok, true);
});

test("--dry-run --launchd-load montre la commande et n'appelle pas launchctl", (t) => {
  const home = fauxHome(t);
  const faux = fauxLaunchctl(home);
  const avant = arbre(home);
  const sortie = lancer(home, ["--dry-run", "--launchd-load"], { VALXOS_MESSENGER_LAUNCHCTL: faux.script });
  assert.equal(sortie.status, 0, `${sortie.stdout}\n${sortie.stderr}`);
  assert.deepEqual(faux.appels(), []);
  assert.deepEqual(arbre(home), avant);
  assert.ok(sortie.stdout.includes(`[would run] ${faux.script} bootstrap gui/${process.getuid()} ${cheminDuPlist(home, LABELS[0])}`));
});

// ── LE SYSTÈME LES LIT ──────────────────────────────────────────────────────
// TROIS ISSUES : sans plutil (tout hôte qui n'est pas macOS, la CI Linux
// comprise), le format n'est PAS prouvé — et ça se dit par une quarantaine
// nommée (Run 6, RUN6-Q1), plutôt que de passer vert par absence d'instrument.
const PLUTIL_ABSENT = spawnSync("plutil", ["-help"], { encoding: "utf8" }).error?.code === "ENOENT";

test("les plists écrits sont lisibles par le système (plutil), avec la structure attendue", quarantaine("RUN6-Q1", "exige plutil (macOS) : sans lui le format des plists n'est pas prouvé sur cet hôte", PLUTIL_ABSENT), (t) => {
  const home = fauxHome(t);
  assert.equal(lancer(home, ["--launchd", "--no-enable"]).status, 0);
  const lint = spawnSync("plutil", ["-lint", ...LABELS.map((l) => cheminDuPlist(home, l))], { encoding: "utf8" });
  assert.ok(!lint.error, `SONDE IMPOSSIBLE : plutil n'a pas tourné (${lint.error?.code})`);
  assert.equal(lint.status, 0, `${lint.stdout}\n${lint.stderr}`);
  const web = spawnSync("plutil", ["-convert", "json", "-o", "-", cheminDuPlist(home, LABELS[1])], { encoding: "utf8" });
  assert.equal(web.status, 0, web.stderr);
  const dict = JSON.parse(web.stdout);
  assert.equal(dict.Label, LABELS[1]);
  assert.deepEqual(dict.ProgramArguments, [path.join(home, "bin", "node"), path.join(repo, "src", "bin", "valxos-web.js")]);
  assert.equal(dict.EnvironmentVariables.VALXOS_WEB_OPERATEUR, undefined, "pas d'opérateur épinglé sans --operator");
  assert.equal(dict.EnvironmentVariables.VALXOS_MESSENGER_HOME, path.join(home, ".valxos-messenger"));
  assert.equal(dict.EnvironmentVariables.HOME, home);
  assert.equal(dict.RunAtLoad, true);
  assert.equal(dict.KeepAlive, true);
});

// ── LE RENDU ────────────────────────────────────────────────────────────────
test("le rendu échappe le XML et refuse un gabarit qu'il ne sait pas remplir", () => {
  const gabarit = `${MARKER}\n<string>__REPO_ROOT__/x</string>`;
  assert.equal(renderPlist(gabarit, { REPO_ROOT: "/a&b<c>" }), `${MARKER}\n<string>/a&amp;b&lt;c&gt;/x</string>`);
  assert.throws(() => renderPlist(`${MARKER}\n<string>__INCONNU__</string>`, { REPO_ROOT: "/a" }), /__INCONNU__/);
  assert.throws(() => renderPlist("<string>__REPO_ROOT__</string>", { REPO_ROOT: "/a" }), /marker/);
  assert.equal(verdict({ content: "x" }, null), "write");
  assert.equal(verdict({ content: `${MARKER} x` }, `${MARKER} x`), "unchanged");
  assert.equal(verdict({ content: `${MARKER} y` }, `${MARKER} x`), "update");
  assert.equal(verdict({ content: `${MARKER} x` }, "<plist/>"), "conflict");
});

// Les gabarits se vérifient AVANT la substitution : la liste des placeholders
// vient du gabarit, jamais du texte rendu. Un contrôle fait APRÈS lisait un
// chemin d'opérateur contenant `__ODD__` comme un placeholder oublié — et
// refusait d'écrire un plist parfaitement rempli.
test("un chemin qui contient __ODD__ n'est pas un placeholder oublié — le gabarit se vérifie avant la substitution", () => {
  const gabarit = `${MARKER}\n<string>__REPO_ROOT__/src</string>`;
  assert.equal(renderPlist(gabarit, { REPO_ROOT: "/tmp/__ODD__/repo" }), `${MARKER}\n<string>/tmp/__ODD__/repo/src</string>`);
  assert.throws(
    () => renderPlist(`${MARKER}\n<string>__REPO_ROOT__/__INCONNU__</string>`, { REPO_ROOT: "/tmp/__ODD__" }),
    /__INCONNU__/,
    "le placeholder sans valeur est nommé — et c'est lui, pas le chemin"
  );
});

// Les commentaires des gabarits arrivent tels quels dans le plist posé chez
// l'opérateur : ils nomment le PRODUIT (« VALXOS Messenger »), pas
// l'identifiant du serveur MCP (`valxos_messenger`) — hygiène H5.
test("les gabarits launchd nomment le produit, pas l'identifiant souligné", () => {
  for (const label of LABELS) {
    const gabarit = fs.readFileSync(path.join(repo, "scripts", "launchd", `${label}.plist`), "utf8");
    assert.doesNotMatch(gabarit, /valxos_messenger/, `${label}.plist porte encore l'identifiant souligné`);
    assert.match(gabarit, /VALXOS Messenger/, `${label}.plist nomme le produit`);
  }
});

// ── LA DOC DIT CE QUE LE CODE FAIT ──────────────────────────────────────────
test("la doc d'installation dit « implemented », nomme les labels et les flags, et ne porte plus l'ancien nom", () => {
  const doc = fs.readFileSync(path.join(repo, "docs", "INSTALL_ONE_CLICK.md"), "utf8");
  for (const attendu of [...LABELS, "--launchd", "--launchd-load", "--launchd-unload", "--operator", "--uninstall", "--force", MARQUE]) {
    assert.ok(doc.includes(attendu), `${attendu} manque dans docs/INSTALL_ONE_CLICK.md`);
  }
  assert.doesNotMatch(doc, /cc2cc/i, "la doc d'installation ne porte plus l'ancien nom");
  assert.doesNotMatch(doc, /not yet automated|does not yet write/i, "le pas 5 n'est plus « specified »");
  assert.match(fs.readFileSync(path.join(repo, "README.md"), "utf8"), /--launchd/, "le README mentionne --launchd");
  assert.match(fs.readFileSync(path.join(repo, "src", "bin", "valxos-messenger.js"), "utf8"), /--launchd-load/, "l'aide du point d'entrée liste le flag");
  assert.match(fs.readFileSync(path.join(repo, "src", "bin", "valxos-messenger.js"), "utf8"), /--launchd-unload/, "l'aide du point d'entrée liste le geste de désinstallation");
});

// ── LE NODE QU'ON ÉPINGLE ───────────────────────────────────────────────────
// process.execPath est le binaire VERSIONNÉ (…/Cellar/node/26.7.0/bin/node) :
// un `brew upgrade node` le supprime, launchd ne peut plus lancer le Facteur
// ni la porte, et KeepAlive relance dans le vide. On préfère l'entrée STABLE —
// le `node` du PATH, ou argv0, dont le chemin réel EST ce binaire ; sinon le
// binaire lui-même, faute de mieux.
test("le node épinglé est l'entrée stable dont le chemin réel est le binaire qui installe — sinon le binaire lui-même", async (t) => {
  const { stableNodePath } = await import("../scripts/launchd/plists.js");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-node-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const versionne = path.join(tmp, "Cellar", "node", "26.7.0", "bin", "node");
  fs.mkdirSync(path.dirname(versionne), { recursive: true });
  fs.writeFileSync(versionne, "#!/bin/sh\n", { mode: 0o755 });
  const stable = path.join(tmp, "bin", "node");
  fs.mkdirSync(path.dirname(stable));
  fs.symlinkSync(versionne, stable);
  const autre = path.join(tmp, "autre", "node");
  fs.mkdirSync(path.dirname(autre));
  fs.writeFileSync(autre, "#!/bin/sh\n", { mode: 0o755 });

  // ① le node du PATH mène au binaire : c'est lui qu'on épingle
  assert.equal(stableNodePath({ execPath: versionne, argv0: "node", env: { PATH: path.join(tmp, "bin") } }), stable);
  // ② le node du PATH est un AUTRE binaire : jamais lui — le binaire qui installe
  assert.equal(stableNodePath({ execPath: versionne, argv0: "node", env: { PATH: path.join(tmp, "autre") } }), versionne);
  // ③ argv0 est un chemin qui mène au binaire et le PATH n'a rien de bon : argv0
  assert.equal(stableNodePath({ execPath: versionne, argv0: stable, env: { PATH: path.join(tmp, "autre") } }), stable);
  // ④ rien de stable nulle part : le binaire, faute de mieux
  assert.equal(stableNodePath({ execPath: versionne, argv0: "node", env: { PATH: "" } }), versionne);
  // ⑤ un dossier du PATH qui n'existe pas ne fait pas tomber la résolution
  assert.equal(
    stableNodePath({ execPath: versionne, argv0: "node", env: { PATH: [path.join(tmp, "nulle-part"), path.join(tmp, "bin")].join(path.delimiter) } }),
    stable
  );
});

// ── LA COHÉRENCE DES VERDICTS ───────────────────────────────────────────────
// Un lien en conflit reste VERT en dry-run (« would need --force ») ; un plist
// en conflit rendait le dry-run rouge, « core install failed ». Et un échec
// du seul pas launchd disait « core install failed » alors que le cœur était
// complet : le résumé nomme le pas qui a échoué.
test("--dry-run --launchd devant un plist étranger reste vert et nomme --force — comme un lien en conflit", (t) => {
  const home = fauxHome(t);
  fs.mkdirSync(dossierLaunchd(home), { recursive: true });
  fs.writeFileSync(cheminDuPlist(home, LABELS[0]), `<plist version="1.0"><dict/></plist>\n`);
  const sortie = lancer(home, ["--dry-run", "--launchd"]);
  assert.equal(sortie.status, 0, `${sortie.stdout}\n${sortie.stderr}`);
  const json = rapport(sortie);
  assert.equal(json.ok, true);
  assert.equal(json.launchd.plists[0].status, "conflict (would need --force)");
  assert.match(sortie.stdout, /would need --force/);
});

test("un échec du seul pas launchd dit « launchd step failed », jamais « core install failed »", (t) => {
  const home = fauxHome(t);
  fs.mkdirSync(dossierLaunchd(home), { recursive: true });
  fs.writeFileSync(cheminDuPlist(home, LABELS[0]), `<plist version="1.0"><dict/></plist>\n`);
  const sortie = lancer(home, ["--launchd", "--no-enable"]);
  assert.equal(sortie.status, 1, `${sortie.stdout}\n${sortie.stderr}`);
  assert.match(sortie.stdout, /Overall: ✗ core install complete, launchd step failed/);
  assert.doesNotMatch(sortie.stdout, /core install failed/);
});

// ── --operator SANS --launchd ───────────────────────────────────────────────
// Un flag qui ne s'applique à rien était avalé en silence : l'opérateur
// croyait avoir réglé la porte, rien n'avait été écrit nulle part.
test("--operator sans --launchd est refusé en le nommant, et rien n'est fait", (t) => {
  const home = fauxHome(t);
  const avant = arbre(home);
  const sortie = lancer(home, ["--no-enable", "--operator", "alice"]);
  assert.equal(sortie.status, 2, `${sortie.stdout}\n${sortie.stderr}`);
  assert.match(sortie.stderr, /--operator/);
  assert.match(sortie.stderr, /--launchd/);
  assert.deepEqual(arbre(home), avant, "un refus ne pose ni lien ni bureau");
});
