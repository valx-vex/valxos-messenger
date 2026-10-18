// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
//
// THE FRONT DOOR — the files a stranger looks for before reading a line of
// code: CONTRIBUTING.md, SECURITY.md, .editorconfig, the GitHub issue and
// pull request templates, dependabot.  They lived only in the public export
// (written there on 2026-08-23) and drifted at once: "the gate is 631 tests"
// while the suite had 689.  Since 2026-08-29 (rev-t8) they are tracked here,
// mirrored like everything else, and this file keeps them honest:
//
//   - no test COUNT written in prose — the gate is a command, and the number
//     changes with every test added; a count in a document is a lie in waiting;
//   - the gate is `node --test test/*.test.js`, and `npm test` runs exactly
//     that command (CHANGELOG, Changed) — a document telling contributors to
//     avoid `npm test` describes a repository that no longer exists;
//   - every link resolves: a relative path exists, an anchor is a heading of
//     the file it points at (GitHub's slug), the repository URL is the one in
//     package.json;
//   - every fact a document cites about the code exists in the code: the
//     files it names, the exported function, the dependency count, the
//     refusal labels of the web door.
//
// The oracle is the tree and the code, never the documents themselves.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { envPropre, poserLeBureau } from "./aide-env.js";
import { fauxHome, lancer, launchctlOuRienNestCharge, rapport } from "./aide-installeur.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(repo, relative), "utf8");
const exists = (relative) => fs.existsSync(path.join(repo, relative));
const pkg = JSON.parse(read("package.json"));

const GATE = "node --test test/*.test.js";
const REPOSITORY_URL = pkg.repository.url.replace(/^git\+/, "").replace(/\.git$/, "");

const FRONT_DOOR = [
  "CONTRIBUTING.md",
  "SECURITY.md",
  ".editorconfig",
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/feature_request.yml",
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/dependabot.yml",
  ".github/workflows/tests.yml"
];
const PROSE = FRONT_DOOR.filter((f) => /\.(md|yml)$/.test(f) && !f.endsWith("tests.yml"));

// GitHub's heading slug: lowercase, punctuation dropped, spaces to hyphens.
function slug(heading) {
  return heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s+/g, "-");
}

function headings(relative) {
  return [...read(relative).matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map((m) => slug(m[1]));
}

// Every link a document carries: markdown `[..](target)`, the templates'
// `(../blob/main/<path>#anchor)`, and the `url:` lines of config.yml.
function links(relative) {
  const text = read(relative);
  const found = [];
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) found.push(m[1]);
  for (const m of text.matchAll(/^\s*url:\s*(\S+)/gm)) found.push(m[1]);
  return found;
}

test("the front door exists in the tree — every file a stranger looks for", () => {
  for (const relative of FRONT_DOOR) assert.ok(exists(relative), `${relative} is tracked here, not only in the export`);
  assert.match(read(".editorconfig"), /^root = true/m, ".editorconfig is a root");
});

test("no test count is written in prose: the gate is a command, not a number", () => {
  for (const relative of PROSE) {
    const text = read(relative);
    const counts = [...text.matchAll(/\b\d{3,4}\s+tests?\b/g)].map((m) => m[0]);
    assert.deepEqual(counts, [], `${relative} writes a test count: ${counts.join(", ")} — the number changes with every test added`);
  }
});

test("the gate is `node --test test/*.test.js`, `npm test` runs exactly that, and the documents say so", () => {
  assert.equal(pkg.scripts.test, GATE, "npm test is the gate itself");
  const workflow = read(".github/workflows/tests.yml");
  assert.ok(workflow.includes(GATE), "the CI runs the gate verbatim");
  for (const relative of ["CONTRIBUTING.md", ".github/PULL_REQUEST_TEMPLATE.md", ".github/ISSUE_TEMPLATE/bug_report.yml"]) {
    assert.ok(read(relative).includes(GATE), `${relative} names the gate verbatim`);
  }
  // Emphasis stripped first: "Do **not** use `npm test`" hid behind the bold.
  const contributing = read("CONTRIBUTING.md").replace(/[*_]{1,2}/g, "");
  assert.match(contributing, /`npm test` runs exactly that command/, "CONTRIBUTING.md says npm test IS the gate");
  assert.doesNotMatch(contributing, /(not|never|avoid|do not|does not)[^\n.]{0,20}`npm test`/i,
    "CONTRIBUTING.md no longer warns against npm test — it runs the gate");
});

test("every link of the front door resolves: files exist, anchors are headings, the repository URL is package.json's", () => {
  let checked = 0;
  for (const relative of PROSE) {
    for (const link of links(relative)) {
      checked += 1;
      let target = link;
      if (target.startsWith(REPOSITORY_URL)) {
        const rest = target.slice(REPOSITORY_URL.length);
        // `<repo>#anchor` is the README; `<repo>/security/…` and `<repo>/issues` are GitHub's own pages.
        if (rest.startsWith("#")) target = `README.md${rest}`;
        else { assert.match(rest, /^\/(security|issues)/, `${relative}: ${link} points at a page of the repository`); continue; }
      } else if (/^https?:\/\//.test(target)) {
        assert.fail(`${relative}: ${link} leaves the repository — only ${REPOSITORY_URL} is expected here`);
      }
      target = target.replace(/^\.\.\/blob\/main\//, "");
      const [file, anchor] = target.split("#");
      assert.ok(exists(file), `${relative}: ${link} → ${file} does not exist`);
      if (anchor) assert.ok(headings(file).includes(anchor), `${relative}: ${link} → no heading "${anchor}" in ${file}`);
    }
  }
  assert.ok(checked >= 6, `the front door carries links to check (${checked} seen)`);
});

test("CONTRIBUTING.md cites files, a function and a dependency count that exist", () => {
  const contributing = read("CONTRIBUTING.md");
  for (const relative of ["src/web/serveur.js", "src/web/public/app.js", "src/facteur/round.js", "src/lib/guichet.js", "SECURITY.md"]) {
    assert.ok(contributing.includes(relative), `CONTRIBUTING.md names ${relative}`);
    assert.ok(exists(relative), `${relative} exists`);
  }
  assert.match(contributing, /`faireLaTournee`/, "the heavy spot in round.js is named");
  assert.match(read("src/facteur/round.js"), /^export (async )?function faireLaTournee\b/m, "and it is exported from there");
  const count = Object.keys(pkg.dependencies).length;
  assert.match(contributing, new RegExp(`There are ${["zero", "one", "two", "three", "four", "five"][count]}\\b`),
    `CONTRIBUTING.md counts the runtime dependencies as they are (${count})`);
  assert.match(read(".github/PULL_REQUEST_TEMPLATE.md"), /src\/lib\/guichet\.js/, "the PR template names the single posting implementation");
});

test("SECURITY.md's known issues describe the door as it is: the refusal labels exist, the cookie is what it says", () => {
  const security = read("SECURITY.md");
  const server = read("src/web/serveur.js");
  const auth = read("src/web/auth.js");
  for (const label of ["lettre-inconnue", "pas-mon-courrier"]) {
    assert.ok(security.includes(label), `SECURITY.md names the label ${label}`);
    assert.ok(server.includes(`"${label}"`), `the door really answers ${label}`);
  }
  assert.match(security, /`\?t=`/, "the token-in-first-URL trade is written");
  assert.match(auth, /searchParams\.get\("t"\)/, "and the door reads that parameter");
  assert.match(security, /`Secure`/, "the missing Secure flag is written");
  assert.doesNotMatch(auth, /;\s*Secure\b/, "and the cookie really has no Secure flag");
  assert.match(auth, /HttpOnly; SameSite=Strict/, "what the cookie does carry");
  assert.match(security, /At-least-once/, "the delivery rule is stated");
});

// F11 (passe adverse du Run 6, 28/09) — LE README COMPTE CE QUE package.json
// PUBLIE. « The nine `cc2cc-*` executables » quand il y en avait dix : neuf
// plus dix plus deux ne font pas les 22 de la phrase suivante.
test("F11 — le README compte les exécutables comme package.json les publie", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
  const noms = Object.keys(pkg.bin);
  const anciens = noms.filter((n) => n.startsWith("cc2cc-")).length;
  const neufs = noms.filter((n) => n.startsWith("valxos-") && n !== "valxos-messenger").length;
  assert.equal(anciens + neufs + 2, noms.length, "sonde impossible : le décompte ne couvre pas tout le bin");
  const MOTS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
  const readme = fs.readFileSync(path.join(repo, "README.md"), "utf8").replace(/\s+/g, " ");
  assert.ok(readme.includes(`The ${MOTS[anciens]} \`cc2cc-*\` executables`), `le README doit dire ${MOTS[anciens]} cc2cc-*`);
  assert.ok(readme.includes(`the ${MOTS[neufs]} \`valxos-*\` names`), `le README doit dire ${MOTS[neufs]} valxos-*`);
  assert.ok(readme.includes(`publishes ${noms.length} CLI entry points`), `le README doit dire ${noms.length} entrées`);
});

// ── LA VITRINE DIT CE QUI A ÉTÉ PROUVÉ, QUAND, ET CE QUI RÉVEILLE ───────────
//
// Publication du 18/10/2026. Le README est la page npm : l'inconnu le lit
// SANS le dépôt. Ces gardes tiennent la table des harnais (une ligne par
// harnais, Gemini CLI et Antigravity CLI distincts, une colonne « réveillé
// par le Facteur » où seul Claude Code dit oui), chaque « Proven » daté, les
// limites de Claude Code 2.1.302, et les corrections de l'audit du paquet
// (la suite ne voyage pas dans le paquet, les liens du guide partent au dépôt
// public, une doc française le dit). L'oracle reste le code et l'arbre :
// les codes cités viennent de src/, les ancres sont des titres réels.

function section(texte, titre) {
  const debut = texte.indexOf(`\n## ${titre}`);
  assert.ok(debut >= 0, `section « ## ${titre} » introuvable`);
  const fin = texte.indexOf("\n## ", debut + 4);
  return texte.slice(debut, fin < 0 ? undefined : fin);
}

// Une table markdown : l'en-tête, puis chaque ligne en cellules nettoyées.
function table(texteDeSection) {
  const lignes = texteDeSection.split("\n").filter((l) => /^\|/.test(l));
  assert.ok(lignes.length >= 3, "sonde impossible : aucune table dans la section");
  const cellules = (l) => l.split("|").slice(1, -1).map((c) => c.trim());
  return { entete: cellules(lignes[0]), lignes: lignes.slice(2).map(cellules) };
}

const HARNAIS_PROUVES = ["Claude Code", "Codex CLI", "Gemini CLI", "Antigravity CLI (agy)", "OpenCode", "Hermes"];

for (const [fichier, titre, colonne, oui, non, autre] of [
  // « oui » est borné à ce que le reçu du 18/10 a vu : la session interactive.
  ["README.md", "Harness support", "Woken by the Facteur", /^yes, interactive sessions \(see details\)$/, /^no\b/, "Any other MCP client"],
  ["README.fr.md", "Harnais pris en charge", "Réveillé par le Facteur", /^oui, en session interactive \(voir détails\)$/, /^non\b/, "Tout autre client MCP"]
]) {
  test(`${fichier} — une ligne par harnais (Gemini CLI ≠ Antigravity CLI), et seul Claude Code est réveillé par le Facteur`, () => {
    const { entete, lignes } = table(section(read(fichier), titre));
    const reveil = entete.indexOf(colonne);
    assert.ok(reveil > 0, `la table a une colonne « ${colonne} »`);
    const noms = lignes.map((cellules) => cellules[0].replace(/\*\*/g, ""));
    assert.deepEqual(noms, [...HARNAIS_PROUVES, autre], "les harnais, dans l'ordre, chacun sa ligne");
    for (const cellules of lignes) {
      const nom = cellules[0].replace(/\*\*/g, "");
      assert.match(cellules[reveil], nom === "Claude Code" ? oui : non, `${nom} : colonne « ${colonne} »`);
    }
  });
}

test("README — le paragraphe « What wakes a session » : seules les sessions Claude Code sont réveillées, les autres relèvent", () => {
  const en = read("README.md").replace(/\s+/g, " ");
  assert.ok(en.includes("**What wakes a session.** Only Claude Code sessions are woken"), "la phrase anglaise");
  assert.ok(en.includes("calling `inbox` (MCP) or `valxos-inbox` (CLI) itself; nothing rings"), "les autres harnais relèvent eux-mêmes");
  // Deux mécanismes, deux preuves : la poussée du Facteur contre un socket de
  // substitution (la suite), le réveil par le moniteur en direct (18/10).
  for (const fait of [
    "the Facteur delivers to the session's own messaging socket, and, on a wake, the plugin monitor prints it",
    // PREUVES/facteur-push-live.md (18/10/2026) : la poussée observée en production.
    "The Facteur's push into a live Claude Code 2.1.302 session was observed in the authors' house on 18/10/2026 (eight letters delivered to the session socket by the previous release's courier, whose connection logic the 1.0.0 courier keeps unchanged); the test suite verifies the 1.0.0 courier against a stand-in socket; the in-session wake through the plugin monitor was verified live the same day."
  ]) assert.ok(en.includes(fait), `README.md : ${fait}`);
  assert.doesNotMatch(en, /There is no real-time push, no presence/, "« no real-time push » sans borne contredit la table");
  assert.ok(en.includes("There is no real-time push outside a Claude Code session, no presence, no typing indicator. Elsewhere a letter waits until the recipient collects it."), "la phrase bornée");
  const fr = read("README.fr.md").replace(/\s+/g, " ");
  assert.ok(fr.includes("**Ce qui réveille une session.** Seules les sessions Claude Code sont réveillées"), "la phrase française");
  for (const fait of [
    "le Facteur remet la lettre au socket de messagerie propre à la session, et, sur un réveil, le moniteur du plugin l'affiche",
    "La poussée du Facteur dans une session Claude Code 2.1.302 vivante a été observée dans la maison des auteurs le 18/10/2026 (huit lettres remises au socket de la session par le Facteur de la release précédente, dont le Facteur 1.0.0 garde la logique de connexion inchangée) ; la suite de tests vérifie le Facteur 1.0.0 contre un socket de substitution ; le réveil en session par le moniteur du plugin a été vérifié en direct le même jour."
  ]) assert.ok(fr.includes(fait), `README.fr.md : ${fait}`);
});

// « Proven » sans date est une promesse déguisée en reçu. Une négation
// (« not proven ») n'est pas une prétention : elle ne porte pas de date.
const DATE = /\b\d{2}\/\d{2}\/\d{4}\b/;
for (const [fichier, motif] of [
  ["README.md", /\b((?:[Nn]ot|[Nn]ever)\s+)?[Pp]roven\b/g],
  ["README.fr.md", /(?<!\p{L})((?:pas|non|jamais)\s+)?[Pp]rouvée?s?(?!\p{L})/gu]
]) {
  test(`${fichier} — chaque « Proven » est suivi de sa date (jj/mm/aaaa), chaque ligne prouvée le 18/10/2026 de sa version`, () => {
    const texte = read(fichier).replace(/\s+/g, " ");
    const pretentions = [...texte.matchAll(motif)].filter((m) => !m[1]);
    assert.ok(pretentions.length >= 6, `plancher : au moins 6 « Proven » à vérifier (${pretentions.length})`);
    for (const m of pretentions) {
      const suite = texte.slice(m.index, m.index + 60);
      assert.match(suite, DATE, `${fichier} : « ${suite} » — un Proven sans date`);
    }
    const titre = fichier === "README.md" ? "Harness support" : "Harnais pris en charge";
    for (const cellules of table(section(read(fichier), titre)).lignes) {
      const statut = cellules.at(-1);
      if (statut.includes("18/10/2026")) assert.match(statut, /\b\d+\.\d+\.\d+\b/, `${cellules[0]} : prouvé le 18/10/2026, avec quelle version ?`);
    }
  });
}

test("README — chaque renvoi de la table vers docs/MCP_CLIENTS.md vise un titre réel", () => {
  for (const fichier of ["README.md", "README.fr.md"]) {
    const ancres = [...read(fichier).matchAll(/\]\(docs\/MCP_CLIENTS\.md#([^)]+)\)/g)].map((m) => m[1]);
    assert.ok(ancres.length >= 6, `${fichier} : la table renvoie à chaque section de harnais (${ancres.length})`);
    for (const ancre of ancres) assert.ok(headings("docs/MCP_CLIENTS.md").includes(ancre), `${fichier} : #${ancre} n'est pas un titre de docs/MCP_CLIENTS.md`);
  }
});

test("README — Known limitations : la négociation, les outils différés, le piège de la source npm, l'échéance du moniteur, les chaises qui restent", () => {
  const limites = section(read("README.md"), "Known limitations").replace(/\s+/g, " ");
  const ordre = [
    "Harness parity is incomplete",
    "MCP_PROTOCOL_NEGOTIATION=legacy",
    "_meta['anthropic/alwaysLoad']",
    "npm pack --ignore-scripts",
    "Claude Code 2.1.271 and later give Monitor watches a deadline",
    "valxos-chaise moissonner",
    "The launchd plists written by `valxos-messenger install --launchd` carry no `VALXOS_MAISONS` and no `CLAUDE_CONFIG_DIR`",
    "The web door's page"
  ];
  let avant = -1;
  for (const fait of ordre) {
    const ici = limites.indexOf(fait);
    assert.ok(ici > avant, `Known limitations : « ${fait} » présent, après le précédent`);
    avant = ici;
  }
  for (const fait of [
    "Claude Code 2.1.292 and later", "since Claude Code 2.1.275", "`valxos-doctor --reap`", "`name#session`",
    // R7 (PREUVES/moniteur-35min.md, 18/10/2026) : le moniteur passe la deadline.
    "In an interactive Claude Code 2.1.302 session the plugin monitor stayed armed for the whole 40-minute session, past the 30-minute deadline Claude Code gives Monitor watches, and presented a letter posted at minute 33 within 20 ms (18/10/2026). Under `claude -p` the monitor is not armed; the hooks deliver instead.",
    // La porte web calcule son avis d'attente avec la même liste de maisons.
    "under launchd the Facteur scans `~/.claude` only, and the web door's `attente` advice on a send uses that same list. If your Claude Code configuration lives elsewhere, add the variable to both plists' environment before loading them"
  ]) {
    assert.ok(limites.includes(fait), `Known limitations : ${fait}`);
  }
  // Les plists launchd ne portent ni la déclaration des maisons ni la maison
  // désignée : l'oracle est le gabarit. Le jour où l'installeur les reporte,
  // cette garde rougit et la limite doit changer avec lui.
  for (const gabarit of ["scripts/launchd/com.valxos.messenger.facteur.plist", "scripts/launchd/com.valxos.messenger.web.plist"]) {
    const plist = read(gabarit);
    assert.match(plist, /<key>EnvironmentVariables<\/key>/, `sonde impossible : ${gabarit} n'a plus de bloc d'environnement`);
    for (const clef of ["VALXOS_MAISONS", "CC2CC_MAISONS", "CLAUDE_CONFIG_DIR"]) assert.ok(!plist.includes(clef), `${gabarit} porte ${clef} : la limite launchd du README est fausse`);
  }
  for (const [fichier, phrase] of [
    ["README.md", "The plists carry no `VALXOS_MAISONS` and no `CLAUDE_CONFIG_DIR`: under launchd the Facteur scans `~/.claude` only, and the web door's `attente` advice on a send uses that same list"],
    ["README.fr.md", "Les plists ne portent ni `VALXOS_MAISONS` ni `CLAUDE_CONFIG_DIR` : sous launchd, le Facteur ne parcourt que `~/.claude`, et l'avis `attente` de la porte web sur un envoi utilise la même liste"]
  ]) assert.ok(read(fichier).replace(/\s+/g, " ").includes(phrase), `${fichier} : l'installation launchd le dit aussi`);
  assert.doesNotMatch(read("README.md"), /not measured in this release/, "R7 est prouvé : plus de « not measured »");
  assert.doesNotMatch(read("README.fr.md"), /n'a pas été mesuré dans cette release/, "R7 est prouvé : plus de « pas mesuré »");
  // Le code d'attente cité est celui que le guichet rend vraiment.
  assert.ok(limites.includes('"lignee-ambigue"') && read("src/lib/registry.js").includes('motif: "lignee-ambigue"'), "le code de la lettre tenue vient du code");
  const fr = section(read("README.fr.md"), "Limites connues").replace(/\s+/g, " ");
  for (const fait of ["MCP_PROTOCOL_NEGOTIATION=legacy", "_meta['anthropic/alwaysLoad']", "npm pack --ignore-scripts", "2.1.292", "2.1.275", "2.1.271", "valxos-chaise moissonner", '"lignee-ambigue"', "ne portent ni `VALXOS_MAISONS` ni `CLAUDE_CONFIG_DIR`",
    "le moniteur du plugin est resté armé pendant toute la session de 40 minutes", "ajoutez la variable à l'environnement des deux plists avant de les charger",
    "et l'avis `attente` de la porte web sur un envoi utilise la même liste"]) {
    assert.ok(fr.includes(fait), `Limites connues : ${fait}`);
  }
});

// Une doc est française quand ses diacritiques le disent (plus de 5 pour
// 1000 caractères : FACTEUR.md en porte 21, MCP_CLIENTS.md 0,2).
const estFrancaise = (relative) => {
  const texte = read(relative);
  return ((texte.match(/[àâçéèêëîïôûùüÿœ]/g) || []).length * 1000) / texte.length > 5;
};

test("README — l'inconnu lit la page npm : la suite se lance d'un clone, le guide part au dépôt public, une doc française le dit", () => {
  const readme = read("README.md");
  for (const titre of ["At a glance", "Verify"]) {
    const texte = section(readme, titre).replace(/\s+/g, " ");
    const gate = texte.indexOf(GATE);
    const clone = texte.indexOf("From a clone of the repository (the test suite does not ship in the npm package):");
    assert.ok(clone >= 0 && clone < gate, `${titre} : « From a clone of the repository » précède la gate`);
  }
  const fr = section(read("README.fr.md"), "Vérifier").replace(/\s+/g, " ");
  assert.ok(fr.indexOf("Depuis un clone du dépôt (la suite de tests ne voyage pas dans le paquet npm) :") >= 0 && fr.indexOf("Depuis un clone") < fr.indexOf(GATE), "Vérifier : depuis un clone");

  for (const fichier of ["README.md", "README.fr.md"]) {
    const texte = read(fichier);
    for (const guide of ["CONTRIBUTING.md", "SECURITY.md"]) {
      assert.ok(exists(guide), `${guide} existe au dépôt`);
      assert.ok(texte.includes(`](${REPOSITORY_URL}/blob/main/${guide})`), `${fichier} : ${guide} lié en absolu (absent du paquet npm)`);
      assert.ok(!texte.includes(`](${guide})`), `${fichier} : plus de lien relatif vers ${guide} — mort sur la page npm`);
    }
  }

  // Chaque lien vers une doc du dépôt dit sa langue quand elle n'est pas celle de la vitrine.
  let vus = 0;
  for (const [fichier, etrangere, mots] of [["README.md", true, "in French"], ["README.fr.md", false, "en anglais"]]) {
    const texte = read(fichier);
    for (const m of texte.matchAll(/\[([^\]]*)\]\((docs\/[^)#]+\.md)(#[^)]*)?\)/g)) {
      if (estFrancaise(m[2]) !== etrangere) continue;
      vus += 1;
      const suite = texte.slice(m.index + m[0].length, m.index + m[0].length + 20);
      assert.ok(m[1].includes(mots) || suite.trimStart().startsWith(`(${mots})`), `${fichier} : le lien vers ${m[2]} dit « ${mots} »`);
    }
  }
  assert.ok(vus >= 4, `plancher : au moins 4 liens vers une doc d'une autre langue (${vus})`);
});

test("README — les maisons par défaut, l'opérateur d'exemple, le glossaire des sigles, le contrat du dépôt public", () => {
  const readme = read("README.md").replace(/\s+/g, " ");
  const config = read("src/lib/config.js");
  assert.match(config, /export const MAISONS_PAR_DEFAUT = \["\.claude"\];/, "sonde : le défaut du code est ~/.claude seul");
  assert.ok(readme.includes("By default it scans `~/.claude` and, when set, `$CLAUDE_CONFIG_DIR`"), "le défaut dit comme le code");
  assert.ok(readme.includes("A `VALXOS_MAISONS` declaration") && readme.includes("replaces that default list; it does not add to it"), "VALXOS_MAISONS remplace la liste par défaut, comme maisonsConnues");
  assert.ok(read("README.fr.md").replace(/\s+/g, " ").includes("remplace cette liste par défaut ; elle ne s'y ajoute pas"), "la même règle en français");
  // `maisonsConnues` ne développe pas `~`, et une déclaration écarte aussi
  // CLAUDE_CONFIG_DIR : les deux README et la doc de câblage le disent.
  // La sonde lit le corps ENTIER de maisonsConnues, de sa déclaration à la
  // prochaine déclaration de premier niveau. Introuvable = sonde impossible.
  const debutMaisons = config.search(/^export function maisonsConnues\b/m);
  assert.ok(debutMaisons >= 0, "sonde impossible : maisonsConnues introuvable dans src/lib/config.js");
  const apres = config.slice(debutMaisons + 1).search(/^(?:export |function |const |let |var |class )/m);
  const corpsMaisons = config.slice(debutMaisons, apres < 0 ? undefined : debutMaisons + 1 + apres);
  assert.ok(corpsMaisons.includes("CC2CC_MAISONS") && corpsMaisons.includes("CLAUDE_CONFIG_DIR"), "sonde impossible : le corps lu n'est pas celui de maisonsConnues");
  for (const [developpement, motifDeveloppement] of [["homedir(", /homedir\(/], ["un remplacement de ~", /["'`]~|\/\^?~/], ["$HOME", /\$HOME|env\.HOME\b/]]) {
    assert.doesNotMatch(corpsMaisons, motifDeveloppement, `maisonsConnues contient ${developpement} : la doc dit que rien n'est développé`);
  }
  for (const [fichier, fait] of [
    ["README.md", "the Messenger expands neither `~` nor `$HOME` in this value"],
    ["README.md", "put your `~/.claude` path in the declaration if you still want that home scanned"],
    ["README.md", "include your `CLAUDE_CONFIG_DIR` path if you still want it scanned"],
    ["README.fr.md", "le Messenger ne développe ni `~` ni `$HOME` dans cette valeur"],
    ["README.fr.md", "mettez le chemin de votre `~/.claude` dans la déclaration si vous voulez encore que cette maison soit parcourue"],
    ["README.fr.md", "incluez le chemin de votre `CLAUDE_CONFIG_DIR` si vous voulez encore qu'il soit parcouru"],
    ["docs/MCP_CLIENTS.md", "neither `~` nor `$HOME` is expanded"]
  ]) assert.ok(read(fichier).replace(/\s+/g, " ").includes(fait), `${fichier} : ${fait}`);
  for (const fichier of ["README.md", "README.fr.md", "docs/MCP_CLIENTS.md"]) {
    assert.ok(!read(fichier).includes("`$HOME/.claude`, "), `${fichier} : « $HOME/.claude » se lit comme une valeur à taper — elle n'est pas développée`);
  }
  for (const [fichier, fait] of [["README.md", "the MCP `refus` and `attente.motif` codes"], ["README.fr.md", "les codes MCP `refus` et `attente.motif`"]]) {
    assert.ok(read(fichier).replace(/\s+/g, " ").includes(fait), `${fichier} : les codes documentés sont ceux du MCP`);
  }
  for (const fichier of ["README.md", "README.fr.md"]) {
    const texte = read(fichier);
    assert.match(texte, /^VALXOS_WEB_OPERATEUR=alice$/m, `${fichier} : l'opérateur d'exemple est alice`);
    assert.doesNotMatch(texte, /VALXOS_WEB_OPERATEUR=operator/, `${fichier} : plus d'opérateur « operator »`);
  }
  const contributing = section(read("README.md"), "Contributing").replace(/\s+/g, " ");
  for (const sigle of ["A8 = at-least-once delivery", "A9 = a null ack means the letter comes back", "Camp B = nothing is erased", "E.1/E.2 = the two Facteur work streams"]) {
    assert.ok(contributing.includes(sigle), `Contributing : le glossaire dit ${sigle}`);
  }
  assert.ok(contributing.indexOf("Comments explain *why*") < contributing.indexOf("**Ledger codes in comments.**"), "le glossaire suit le paragraphe des commentaires");
  assert.ok(readme.includes("(the repository is public; this README is the whole contract)"), "la manière simple dit le contrat");
});

// LE CACHET DE LA PORTE WEB SE DIT EN DEUX COUCHES (18/10). L'API rend le
// champ `etat` avec les quatre codes du produit ; la page les affiche sous
// leurs libellés anglais. Les deux README disent les deux couches, et les
// libellés sont lus dans la table de la page : un libellé renommé à l'écran
// fait rougir la doc qui l'annonce.
test("README — la porte web : les quatre codes `etat` et les libellés exacts de la page", () => {
  const page = read("src/web/public/app.js");
  const table = page.match(/const CACHETS = \{([\s\S]*?)\n\};/);
  assert.ok(table, "sonde impossible : la table CACHETS est introuvable dans app.js");
  const libelles = [...table[1].matchAll(/\bmot: "([^"]+)"/g)].map((m) => m[1]);
  assert.equal(libelles.length, 4, `sonde impossible : ${libelles.length} libellés lus dans CACHETS`);
  const codes = Object.keys(Object.fromEntries([...page.matchAll(/^ {2}"([^"]+)": "(attente|guichet|recue|accusee)",$/gm)].map((m) => [m[1], m[2]])));
  assert.deepEqual(codes, ["en attente", "au guichet", "reçue", "accusée"], "sonde : les quatre codes que la page traduit");
  assert.ok(page.includes('const morceaux = ["Overdue"];'), "sonde : la ligne d'une lettre en souffrance commence par Overdue");
  for (const [fichier, titre] of [["README.md", "The web door"], ["README.fr.md", "La porte web"]]) {
    const texte = section(read(fichier), titre).replace(/\s+/g, " ");
    for (const code of codes) assert.ok(texte.includes(`\`${code}\``), `${fichier} : le code \`${code}\` reste un code`);
    for (const libelle of [...libelles, "Overdue"]) assert.ok(texte.includes(`**${libelle}**`), `${fichier} : la page affiche **${libelle}**`);
    assert.ok(texte.includes("`etat`"), `${fichier} : les codes sont ceux du champ \`etat\``);
  }
});

// ── LA VAGUE FINALE (18/10) : LE README DIT CE QUE LE CODE FAIT ─────────────
//
// Trois revues de fond (l'inconnu, la sécurité, la qualité) ont lu la vitrine
// comme un étranger et trouvé des phrases qui manquaient ou qui n'étaient pas
// vraies : le nom d'hôte sous lequel parle une maison sans VALXOS_SELF, l'accusé
// que la porte web signe à l'ouverture, le texte de lettre qui entre dans le
// contexte d'un modèle, la CLI qui ne pouvait pas accuser, un lien que personne
// n'avait vu à l'écran. Chaque phrase a son oracle quand le code en a un ; sinon
// la phrase exacte est épinglée dans les deux langues.
const plat = (texte) => texte.replace(/\s+/g, " ");

test("README — « Name each house » : VALXOS_SELF, puis VALXOS_SESSION_NAME, puis le nom d'hôte — l'ordre du code (en et fr)", async () => {
  const { clefValxos, deriveSelf, hostnameFallback } = await import("../src/lib/config.js");
  // Les deux variables que le README nomme sont les clefs que le code lit sous leur nom historique.
  assert.equal(clefValxos("CC2CC_SELF"), "VALXOS_SELF");
  assert.equal(clefValxos("CC2CC_SESSION_NAME"), "VALXOS_SESSION_NAME");
  const CLEFS = ["VALXOS_SELF", "CC2CC_SELF", "VALXOS_SESSION_NAME", "CC2CC_SESSION_NAME"];
  const avant = Object.fromEntries(CLEFS.map((clef) => [clef, process.env[clef]]));
  try {
    for (const clef of CLEFS) delete process.env[clef];
    assert.equal(deriveSelf(), hostnameFallback(), "sans rien, toute session parle sous le nom d'hôte — et partage une boîte");
    process.env.VALXOS_SESSION_NAME = "nom-de-session";
    assert.equal(deriveSelf(), "nom-de-session", "VALXOS_SESSION_NAME vient avant le nom d'hôte");
    process.env.VALXOS_SELF = "nom-choisi";
    assert.equal(deriveSelf(), "nom-choisi", "VALXOS_SELF gagne");
  } finally {
    for (const clef of CLEFS) {
      if (avant[clef] === undefined) delete process.env[clef];
      else process.env[clef] = avant[clef];
    }
  }
  assert.ok(
    plat(section(read("README.md"), "Install")).includes(
      "**Name each house.** Set `VALXOS_SELF=<name>` in the launcher of every harness that starts the server or the hooks (and `VALXOS_SESSION_NAME` if you want per-session names). Without it every session on the machine speaks under the hostname and shares one name; `whoami` shows the name in use. Give each harness its own name: a CLI or MCP client that uses a Claude Code lineage's name does not read that lineage's mail while one of its chairs is alive (see `docs/MCP_CLIENTS.md`)."
    ),
    "README.md : Install nomme VALXOS_SELF"
  );
  assert.ok(
    plat(section(read("README.fr.md"), "Installer et démarrer")).includes(
      "**Nommez chaque maison.** Posez `VALXOS_SELF=<nom>` dans le lanceur de chaque harnais qui démarre le serveur ou les hooks (et `VALXOS_SESSION_NAME` si vous voulez des noms par session). Sans lui, toutes les sessions de la machine parlent sous le nom d'hôte, donc sous un seul nom ; `whoami` affiche le nom en usage. Donnez à chaque harnais son propre nom : un client CLI ou MCP qui prend le nom d'une lignée Claude Code ne relève pas le courrier de cette lignée tant qu'une de ses chaises est vivante (voir `docs/MCP_CLIENTS.md`, en anglais)."
    ),
    "README.fr.md : Installer et démarrer nomme VALXOS_SELF"
  );
});

test("README — la porte web : ouvrir la page accuse les lettres ordinaires, et seulement elles (en et fr)", async () => {
  const { accuseImplicite } = await import("../src/web/serveur.js");
  for (const priority of ["low", "normal"]) {
    assert.equal(accuseImplicite({ msg_type: "message", priority }), true, `une lettre « message » de priorité ${priority} est accusée à l'ouverture`);
  }
  for (const priority of ["high", "critical"]) {
    assert.equal(accuseImplicite({ msg_type: "message", priority }), false, `une lettre ${priority} attend le bouton`);
  }
  for (const msg_type of ["task", "response", "status"]) {
    assert.equal(accuseImplicite({ msg_type, priority: "normal" }), false, `un type « ${msg_type} » attend le bouton`);
  }
  // `GET /api/fil` relève (donc accuse), et le bouton que la phrase nomme est sur la page.
  assert.match(read("src/web/serveur.js"), /function servirLeFil\([^)]*\) \{\s*const releve = releverLeCourrier\(/, "la route du fil relève le courrier");
  assert.match(read("src/web/public/app.js"), />Acknowledge<\/button>/, "la page porte un bouton Acknowledge");
  assert.ok(
    plat(section(read("README.md"), "The web door")).includes(
      "Opening the page (or `GET /api/fil`) acknowledges ordinary letters to the operator (`message` type, priority `low` or `normal`); `high`, `critical` and every other type wait for the Acknowledge button."
    ),
    "README.md : The web door dit l'accusé implicite"
  );
  assert.ok(
    plat(section(read("README.fr.md"), "La porte web")).includes(
      "Ouvrir la page (ou `GET /api/fil`) accuse les lettres ordinaires adressées à l'opérateur (type `message`, priorité `low` ou `normal`) ; `high`, `critical` et tout autre type attendent le bouton Acknowledge."
    ),
    "README.fr.md : La porte web dit l'accusé implicite"
  );
});

test("les lettres sont du texte non fiable, et l'identité est l'environnement : README (en et fr) et SECURITY.md le disent", () => {
  const en = plat(section(read("README.md"), "Known limitations"));
  assert.ok(
    en.includes("Letters are untrusted text. A letter's body reaches the recipient's model unfiltered, by the hooks, the plugin monitor and the Facteur, and the sender shown is the name the peer gave itself."),
    "README.md : Known limitations — lettres non fiables"
  );
  assert.ok(en.includes("Anything that can write to the office can put text in front of a model"), "README.md : tout ce qui écrit au bureau écrit devant un modèle");
  const fr = plat(section(read("README.fr.md"), "Limites connues"));
  assert.ok(
    fr.includes("Les lettres sont du texte non fiable. Le corps d'une lettre arrive tel quel dans le contexte du modèle destinataire, par les hooks, le moniteur du plugin et le Facteur, et l'expéditeur affiché est le nom que le pair s'est donné."),
    "README.fr.md : Limites connues — lettres non fiables"
  );
  const securite = plat(read("SECURITY.md"));
  const modele = securite.slice(securite.indexOf("## Threat model"), securite.indexOf("## Known and accepted issues"));
  assert.ok(modele.length > 100, "sonde impossible : la section Threat model est introuvable");
  for (const phrase of [
    "Peer identity is the process environment (`VALXOS_SELF`). Any process under the operator's account can speak, read and acknowledge as any peer, and can retire (`unregister`) or rewrite (`register`) any peer card without a chair. The verification of a declared `self` is a consistency check between two values the caller controls, not authentication.",
    "**Letters are untrusted text.** The body of a letter reaches the recipient's model unfiltered, by three channels",
    "that is a reminder, not a barrier"
  ]) assert.ok(modele.includes(phrase), `SECURITY.md, Threat model : ${phrase.slice(0, 60)}…`);
});

test("README — `valxos-inbox` montre au plus vingt lettres non accusées ; on accuse avec `valxos-inbox --ack <msg_id>` pour que les suivantes remontent (en et fr)", () => {
  const harnais = (fichier, titre) => plat(section(read(fichier), titre));
  assert.ok(
    harnais("README.md", "Harness support").includes("`valxos-inbox` shows up to 20 unacknowledged letters (`--limit N`); acknowledge with `valxos-inbox --ack <msg_id>` so the next ones surface."),
    "README.md : sous la table des harnais"
  );
  assert.ok(
    harnais("README.fr.md", "Harnais pris en charge").includes("`valxos-inbox` montre jusqu'à 20 lettres non accusées (`--limit N`) ; accusez avec `valxos-inbox --ack <msg_id>` pour que les suivantes remontent."),
    "README.fr.md : sous la table des harnais"
  );
  // La phrase de réveil (« collects its mail by calling `inbox` or `valxos-inbox` ») reste celle de la table.
  assert.ok(
    harnais("README.md", "Harness support").includes("calling `inbox` (MCP) or `valxos-inbox` (CLI) itself; nothing rings"),
    "README.md : la phrase de réveil est intacte"
  );
});

test("README — le lien `skills-dir` et `claude plugin enable` ne sont pas dits éprouvés de bout en bout (en et fr)", () => {
  assert.ok(
    plat(section(read("README.md"), "Install")).includes(
      "The `skills-dir` link written by `valxos-messenger install` and `claude plugin enable valxos-messenger@skills-dir` were not exercised end to end in a Claude Code session in this release; the plugin was verified from the same tree with `--plugin-dir`."
    ),
    "README.md : Install dit ce qui n'a pas été vu"
  );
  assert.ok(
    plat(section(read("README.fr.md"), "Installer et démarrer")).includes(
      "Le lien `skills-dir` que `valxos-messenger install` écrit et la commande `claude plugin enable valxos-messenger@skills-dir` n'ont pas été exercés de bout en bout dans une session Claude Code pour cette release ; le plugin a été vérifié depuis le même arbre avec `--plugin-dir`."
    ),
    "README.fr.md : Installer et démarrer dit ce qui n'a pas été vu"
  );
});

// C4 (FIX-C, 18/10) — L'INSTALLEUR FAIT NAÎTRE LE BUREAU, ET LE README LE DIT (en et fr).
// `valxos-doctor` ne crée plus le bureau qu'il constate : c'est l'installeur qui l'ouvre une
// fois, pour que le médecin que le README donne ensuite ait une base à lire. La liste de
// ce que l'installeur pose n'en parlait pas. La création elle-même est prouvée par une install
// réelle dans test/install-cli.test.js ; ici, la phrase est tenue, et les deux chemins qu'elle
// nomme sont ceux de l'installeur qui tourne (un dry-run, dans un HOME jetable : rien n'est écrit).
test("README — l'installeur crée le bureau (`~/.valxos-messenger`, ou celui que nomme VALXOS_MESSENGER_HOME) pour que le médecin en ait un à lire (en et fr)", (t) => {
  const home = fauxHome(t);
  const parDefaut = rapport(lancer(home, ["--dry-run"], { VALXOS_MESSENGER_HOME: undefined }));
  assert.equal(parDefaut.office.path, path.join(home, ".valxos-messenger", "broker.db"), "sans VALXOS_MESSENGER_HOME, le bureau est ~/.valxos-messenger");
  const nomme = path.join(home, "mon-bureau");
  const parLaVariable = rapport(lancer(home, ["--dry-run"], { VALXOS_MESSENGER_HOME: nomme }));
  assert.equal(parLaVariable.office.path, path.join(nomme, "broker.db"), "VALXOS_MESSENGER_HOME nomme le bureau que l'installeur ouvre");
  assert.equal(fs.existsSync(nomme), false, "sonde : un dry-run n'a rien créé");

  assert.ok(
    plat(section(read("README.md"), "Install")).includes(
      "The installer creates CLI symlinks in `~/.local/bin/`, the Claude Code plugin symlink, and the office (`~/.valxos-messenger`, or the one `VALXOS_MESSENGER_HOME` names), so the doctor that follows has one to read. With `--launchd` it also writes the two launchd plists."
    ),
    "README.md : Install liste le bureau parmi ce que pose l'installeur"
  );
  assert.ok(
    plat(section(read("README.fr.md"), "Installer et démarrer")).includes(
      "L'installeur pose les liens des commandes sous `~/.local/bin`, le lien du plugin Claude Code et le bureau (`~/.valxos-messenger`, ou celui que nomme `VALXOS_MESSENGER_HOME`), pour que `valxos-doctor`, lancé ensuite, en trouve un à lire."
    ),
    "README.fr.md : Installer et démarrer liste le bureau parmi ce que pose l'installeur"
  );
});

// D3 (FIX-D, 18/10) — LES LISTES D'ÉTAPES DE L'INSTALLEUR DISENT LE BUREAU, PARTOUT. Le README le dit depuis
// C4 ; docs/INSTALL_ONE_CLICK.md (« What one click means », le périmètre du cœur, ce que l'installeur
// ne fait pas) et docs/MCP_CLIENTS.md (« runs, in this order ») listaient encore les étapes sans lui. Et
// « It does not modify ~/.valxos-messenger runtime data » contredisait l'étape qui le crée. L'oracle de
// l'ORDRE est le résumé de l'installeur qui tourne (un dry-run, dans un HOME jetable) : le bureau vient
// après les liens et avant les étapes facultatives de Claude Code, dans la doc comme dans le code.
test("les listes d'étapes de l'installeur (INSTALL_ONE_CLICK, MCP_CLIENTS) disent qu'il crée le bureau, dans l'ordre du code", (t) => {
  const home = fauxHome(t);
  const sortie = lancer(home, ["--dry-run"]);
  assert.equal(sortie.status, 0, `${sortie.stdout}\n${sortie.stderr}`);
  const dansLeCode = ["plugin symlink:", "CLI links:", "office database:", "Claude Code validate:", "Claude Code enable:"].map((mot) => sortie.stdout.indexOf(mot));
  assert.ok(dansLeCode.every((rang) => rang >= 0), `sonde impossible : le résumé de l'installeur a perdu une ligne\n${sortie.stdout}`);
  assert.deepEqual([...dansLeCode].sort((a, b) => a - b), dansLeCode, "le code pose le lien du plugin, les liens, le bureau, puis les étapes de Claude Code");

  const une = plat(read("docs/INSTALL_ONE_CLICK.md"));
  for (const phrase of [
    "3. Creates the Claude Code plugin symlink. 4. Creates the office: the runtime directories and the database (`~/.valxos-messenger`, or the one `VALXOS_MESSENGER_HOME` names), so the doctor that follows has one to read. 5. Validates and enables the Claude Code plugin (optional).",
    "6. Writes the launchd plists for the Facteur and the web door",
    "7. Prints a human-readable summary of what was done.",
    "The `scripts/install.js` installer handles steps 1–5 and the summary. It separates **core** (links, npm, plugin symlink, office) from **optional**",
    "It does not delete or rewrite the data of an existing office: it opens the database once, with the schema and migrations every command applies, and `--uninstall` leaves the office alone."
  ]) assert.ok(une.includes(phrase), `docs/INSTALL_ONE_CLICK.md : ${phrase.slice(0, 70)}…`);
  assert.equal(une.includes("It does not modify `~/.valxos-messenger` runtime data."), false, "plus de phrase qui contredit l'étape du bureau");

  const clients = plat(read("docs/MCP_CLIENTS.md"));
  const debut = clients.indexOf("`scripts/install.js` runs, in this order:");
  assert.ok(debut >= 0, "sonde impossible : la phrase « runs, in this order » est introuvable");
  const phrase = clients.slice(debut, clients.indexOf("Without a `claude` binary", debut));
  const dansLaDoc = ["the plugin symlink", "the CLI links", "the office: the runtime directories and the database, created when absent;", "`claude plugin validate`", "`claude plugin enable"].map((mot) => phrase.indexOf(mot));
  assert.ok(dansLaDoc.every((rang) => rang >= 0), `docs/MCP_CLIENTS.md : une étape manque dans « ${phrase.slice(0, 200)}… »`);
  assert.deepEqual([...dansLaDoc].sort((a, b) => a - b), dansLaDoc, "la doc donne les étapes dans l'ordre du code");

  // Et ce que la doc promet du bureau est tenu par l'installeur qui tourne, dans le même HOME jetable :
  // une install RÉELLE le crée, et `--uninstall` le laisse (le faux launchctl garde la sonde hors de la machine).
  const maison = path.join(home, "maison-claude");
  const reelle = lancer(home, ["--no-enable"], { CLAUDE_CONFIG_DIR: maison });
  assert.equal(reelle.status, 0, `${reelle.stdout}\n${reelle.stderr}`);
  const base = path.join(home, ".valxos-messenger", "broker.db");
  assert.ok(fs.existsSync(base), "une install réelle crée le bureau : ses dossiers et sa base");
  assert.ok(fs.existsSync(path.join(home, ".valxos-messenger", "run")), "ses dossiers aussi");
  const faux = launchctlOuRienNestCharge(home);
  const retrait = lancer(home, ["--uninstall"], { CLAUDE_CONFIG_DIR: maison, VALXOS_MESSENGER_LAUNCHCTL: faux.script });
  assert.equal(retrait.status, 0, `${retrait.stdout}\n${retrait.stderr}`);
  assert.ok(fs.existsSync(base), "--uninstall laisse le bureau");
});

test("README — le glossaire des codes T et la phrase Verify disent vrai (en et fr)", () => {
  // Les codes T4b-… sont cités dans des commentaires de test ; T1 à T6 nus sont les étapes d'une tournée du Facteur.
  assert.match(read("test/surfaces.test.js"), /\(T4b-b\)/, "sonde : un code T4b-b est cité dans un test");
  assert.match(read("src/facteur/round.js"), /^\/\/ ── T1 — RÉSERVER/m, "sonde : T1 est une étape de la tournée du Facteur");
  assert.match(read("src/facteur/round.js"), /^\/\/ ── T6 — /m, "sonde : T6 aussi");
  assert.ok(
    plat(section(read("README.md"), "Contributing")).includes(
      "T-codes (T4b-b, T4b-c…) number the tasks of the 1.0.0 publication run, cited in a few test comments; the bare T1 to T6 in `src/facteur/round.js` are the steps of one Facteur round."
    ),
    "README.md : Contributing — les codes T"
  );
  assert.ok(
    plat(section(read("README.fr.md"), "Contribuer")).includes(
      "Les codes T (T4b-b, T4b-c…) numérotent les tâches du run de publication de 1.0.0, cités dans quelques commentaires de tests ; les T1 à T6 nus de `src/facteur/round.js` sont les étapes d'une tournée du Facteur."
    ),
    "README.fr.md : Contribuer — les codes T"
  );
  assert.ok(
    plat(section(read("README.md"), "Verify")).includes(
      "In a clone of the public repository the suite is the same minus the private-name guard, which only runs in the authors' repository."
    ),
    "README.md : Verify dit la garde privée"
  );
  assert.ok(
    plat(section(read("README.fr.md"), "Vérifier")).includes(
      "Dans un clone du dépôt public, la suite est la même, moins la garde des noms privés, qui ne tourne que dans le dépôt des auteurs."
    ),
    "README.fr.md : Vérifier dit la garde privée"
  );
});

test("la CI ne nomme aucun haché de commit et n'écrit aucun compte de tests", () => {
  const workflow = read(".github/workflows/tests.yml");
  // Sept à douze chiffres hexadécimaux, au moins une lettre et un chiffre : la forme d'un haché.
  assert.doesNotMatch(workflow, /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,12}\b/, "tests.yml cite un haché que le dépôt public ne résout pas");
  assert.doesNotMatch(workflow, /\b\d{3,4}\s+tests?\b/, "tests.yml écrit un compte de tests");
});

// Le verrou suit ce que npm sert aujourd'hui (SDK 1.32.1, le 18/10) : la vitrine
// et la page de câblage nomment la génération du protocole et la version mineure
// du SDK, et l'oracle est le SDK installé — jamais un nombre recopié.
test("la génération du protocole MCP et le SDK que disent la vitrine et la page de câblage sont ceux du SDK installé et du verrou", async () => {
  const verrou = JSON.parse(read("package-lock.json"));
  const installe = JSON.parse(read("node_modules/@modelcontextprotocol/sdk/package.json")).version;
  assert.equal(verrou.packages["node_modules/@modelcontextprotocol/sdk"].version, installe, "le verrou et node_modules disent la même version du SDK");
  const [majeur, mineur] = installe.split(".");
  const { LATEST_PROTOCOL_VERSION } = await import("@modelcontextprotocol/sdk/types.js");
  for (const [fichier, phrase] of [
    ["README.md", `This server speaks the ${LATEST_PROTOCOL_VERSION} generation (SDK ${majeur}.${mineur}).`],
    ["README.fr.md", `Ce serveur parle la génération ${LATEST_PROTOCOL_VERSION} (SDK ${majeur}.${mineur}).`],
    ["docs/MCP_CLIENTS.md", `speaks the ${LATEST_PROTOCOL_VERSION} generation (SDK ${majeur}.${mineur});`]
  ]) assert.ok(plat(read(fichier)).includes(phrase), `${fichier} : « ${phrase} »`);
  // La ligne du CHANGELOG nomme la version exacte que le verrou résout.
  const ligne = plat(read("CHANGELOG.md")).match(/follows the dependency versions npm resolves today \(MCP SDK (\d+\.\d+\.\d+)\)/);
  assert.ok(ligne, "le [1.0.0] dit que le verrou suit ce que npm résout");
  assert.equal(ligne[1], installe, "et la version du SDK qu'il nomme est celle du verrou");
});

// La phrase du README sur la CLI dit « jusqu'à 20 lettres non accusées
// (`--limit N`) » : l'oracle est la CLI qui tourne, pas le source.
test("README — `valxos-inbox` montre au plus 20 lettres non accusées, et --limit N change la borne", async () => {
  // Le bureau du PROCESSUS de test aussi : un `file` explicite ne protège pas le bureau vivant.
  const root = poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "valxos-inbox-vingt-")));
  const { openDatabase, insertMessage } = await import("../src/lib/database.js");
  const db = openDatabase({ file: path.join(root, "broker.db") });
  for (let i = 0; i < 22; i += 1) insertMessage(db, { sender: "bob", recipient: "alice", body: `lettre ${i}` });
  db.close();
  const relever = (...args) => JSON.parse(execFileSync("node", [path.join(repo, "src/bin/valxos-inbox.js"), "--mark-delivered", "false", ...args], {
    encoding: "utf8",
    env: { ...envPropre(), CC2CC_V2_HOME: root, VALXOS_SELF: "alice" }
  }));
  assert.equal(relever().count, 20, "par défaut, vingt lettres sur vingt-deux");
  assert.equal(relever("--limit", "3").count, 3, "--limit N change la borne");
});
