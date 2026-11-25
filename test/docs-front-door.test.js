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

test("SECURITY.md's known issues describe the door as it is: the refusal labels exist, the cookie is what it says", async () => {
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
  // 1.1.0: the Codex doorbell's envelope never carries a body (it reaches the
  // model as the user's own words) and travels on a command line; closed
  // tables give no copy; tables and enclosures are not boundaries.
  const securite = security.replace(/\s+/g, " ");
  for (const phrase of [
    "**The Codex doorbell carries an envelope, never a body.**",
    "`enveloppeDeSonnette` in `src/lib/sonnette.js`",
    "**Tables and enclosures are conveniences, not boundaries.**",
    "`hors_enclos: true`",
    "**`envoi_status` is served to the sender only**",
    "**The shared position of a table is untrusted text**",
    "**The Codex envelope travels on a command line.**"
  ]) assert.ok(securite.includes(phrase), `SECURITY.md: ${phrase}`);
  const modele = securite.slice(securite.indexOf("## Threat model"), securite.indexOf("## Known and accepted issues"));
  assert.ok(modele.includes("**The Codex doorbell carries an envelope, never a body.**"), "the envelope is part of the threat model, not a known issue");
  const { enveloppeDeSonnette, LONGUEUR_SUJET_SONNETTE } = await import("../src/lib/sonnette.js");
  const enveloppe = enveloppeDeSonnette([{ sender: "alice", subject: "s".repeat(80), body: "BODY-NEVER-HERE", priority: "high" }], { destinataire: "bob" });
  assert.ok(!enveloppe.includes("BODY-NEVER-HERE"), "the envelope really carries no body");
  assert.equal(LONGUEUR_SUJET_SONNETTE, 60, "and cuts the subject at the 60 characters SECURITY.md says");
  assert.ok(securite.includes("a subject cut at 60 characters"), "SECURITY.md says 60");
  const { argumentsDeSonnette } = await import("../src/facteur/porte-codex-regles.js");
  assert.deepEqual(argumentsDeSonnette({ thread_id: "t" }, enveloppe).slice(-2), ["--message", enveloppe], "the envelope is an argument of codex queue: a command line");
  assert.match(read("src/lib/database.js"), /sans_copie = 0/, "and the copies leave out the letters of a closed table");
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
  const MOTS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen"];
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

// Ce que la colonne « réveillé » promet, harnais par harnais (1.1.0) : Claude
// Code par son socket (reçu du 18/10/2026, session interactive) ; Codex par
// `codex queue`, livré mais PAS ENCORE VU EN DIRECT (revue de la Tâche 12,
// finding 4 : le reçu du 21/10/2026 a vu `codex queue` réveiller un fil inactif
// avec un hook de substitution, jamais la porte du Facteur ni le hook livré).
// La cellule le dit, et la ligne renvoie à la section qui dit ce qui a été vu.
// Tout autre harnais relève lui-même. L'oracle du « oui » de Codex est la porte Codex du Facteur : ses
// arguments sont ceux de `codex queue`, et la porte s'en sert. La colonne
// « Hooks » suit : Claude Code et Codex en ont, les autres non.
for (const [fichier, titre, colonne, reveilles, non, autre] of [
  ["README.md", "Harness support", "Woken by the Facteur",
    new Map([["Claude Code", /^yes, interactive sessions \(see details\)$/], ["Codex CLI", /^yes \(seen live on a scratch home, 22\/10\/2026\)$/]]),
    /^no\b/, "Any other MCP client"],
  ["README.fr.md", "Harnais pris en charge", "Réveillé par le Facteur",
    new Map([["Claude Code", /^oui, en session interactive \(voir détails\)$/], ["Codex CLI", /^oui \(vu en direct sur une maison jetable, 22\/10\/2026\)$/]]),
    /^non\b/, "Tout autre client MCP"]
]) {
  test(`${fichier} — une ligne par harnais (Gemini CLI ≠ Antigravity CLI) ; Claude Code et Codex sont réveillés par le Facteur, les autres non`, async () => {
    const { entete, lignes } = table(section(read(fichier), titre));
    const reveil = entete.indexOf(colonne);
    const hooks = entete.indexOf("Hooks");
    assert.ok(reveil > 0, `la table a une colonne « ${colonne} »`);
    assert.ok(hooks > 0, "la table a une colonne « Hooks »");
    const noms = lignes.map((cellules) => cellules[0].replace(/\*\*/g, ""));
    assert.deepEqual(noms, [...HARNAIS_PROUVES, autre], "les harnais, dans l'ordre, chacun sa ligne");
    for (const cellules of lignes) {
      const nom = cellules[0].replace(/\*\*/g, "");
      assert.match(cellules[reveil], reveilles.get(nom) ?? non, `${nom} : colonne « ${colonne} »`);
      assert.match(cellules[hooks], reveilles.has(nom) ? /^✓/ : /^—$/, `${nom} : colonne « Hooks »`);
    }
    // La ligne Codex renvoie à la section qui dit ce qui a été vu le 21/10.
    const codex = lignes.find((cellules) => cellules[0].replace(/\*\*/g, "") === "Codex CLI");
    assert.ok(codex.at(-1).includes("(docs/MCP_CLIENTS.md#codex-hooks-and-the-doorbell)"), "Codex : le renvoi vers « Codex: hooks and the doorbell »");
    const { argumentsDeSonnette } = await import("../src/facteur/porte-codex-regles.js");
    assert.deepEqual(argumentsDeSonnette({ thread_id: "fil" }, "enveloppe"), ["queue", "--thread", "fil", "--message", "enveloppe"], "sonde : la sonnette est `codex queue`");
    assert.match(read("src/facteur/porte-codex.js"), /argumentsDeSonnette\(/, "sonde : la porte Codex du Facteur s'en sert");
  });
}

test("README — le paragraphe « What wakes a session » : Claude Code et Codex sont réveillés, les autres relèvent (en et fr)", () => {
  const en = read("README.md").replace(/\s+/g, " ");
  assert.ok(en.includes("**What wakes a session.** Claude Code sessions and Codex sessions are woken; every other harness collects."), "la phrase anglaise");
  assert.ok(en.includes("calling `inbox` (MCP) or `valxos-inbox` (CLI) itself; nothing rings"), "les autres harnais relèvent eux-mêmes");
  // Deux mécanismes, deux preuves : la poussée du Facteur contre un socket de
  // substitution (la suite), le réveil par le moniteur en direct (18/10).
  for (const fait of [
    "the Facteur delivers to the session's own messaging socket, and, on a wake, the plugin monitor prints it",
    // PREUVES/facteur-push-live.md (18/10/2026) : la poussée observée en production.
    "The Facteur's push into a live Claude Code 2.1.302 session was observed in the authors' house on 18/10/2026 (eight letters delivered to the session socket by the previous release's courier, whose connection logic the 1.0.0 courier keeps unchanged); the test suite verifies the 1.0.0 courier against a stand-in socket; the in-session wake through the plugin monitor was verified live the same day.",
    // 1.1.0 : la sonnette Codex — une enveloppe, jamais un corps.
    // S15 (troisième passe adverse) : la réserve d'avant la marche du 22/10 est datée, pas répétée.
    "For Codex (with its 1.1.0 hooks installed; seen live once on 22/10/2026, on a scratch home), the Facteur rings the chair with `codex queue` — an envelope, never a letter body — and the Codex hooks inject the mail at the next turn",
    // 1.1.0 : la lettre calme ne réveille personne, nulle part.
    "A quiet table letter (`low` priority, a `prochain-tour` rule, a reaction in a `direct` table) wakes nobody: it waits for the next turn."
  ]) assert.ok(en.includes(fait), `README.md : ${fait}`);
  assert.doesNotMatch(en, /There is no real-time push, no presence/, "« no real-time push » sans borne contredit la table");
  assert.doesNotMatch(en, /Only Claude Code sessions are woken/, "la phrase de la 1.0.0 est fausse en 1.1.0");
  assert.ok(en.includes("There is no real-time push outside a Claude Code or Codex session, no presence, no typing indicator. Elsewhere a letter waits until the recipient collects it."), "la phrase bornée, Codex compris");
  // Un statut daté du 21/10/2026 dit ce qu'il veut dire, comme ceux du 18/10.
  assert.ok(en.includes("A status dated 21/10/2026 means: on that date, on macOS, against a scratch Codex home with a local model, `codex queue` woke an idle session"), "le sens d'un statut du 21/10");
  assert.ok(en.includes("behaved as the schemas embedded in Codex describe them"), "les schémas embarqués, pas une doc de Codex (finding 7)");
  assert.doesNotMatch(en, /as Codex documents them/, "le reçu ne cite aucune doc de Codex");
  const fr = read("README.fr.md").replace(/\s+/g, " ");
  assert.ok(fr.includes("**Ce qui réveille une session.** Les sessions Claude Code et les sessions Codex sont réveillées ; tout autre harnais relève."), "la phrase française");
  assert.doesNotMatch(fr, /Seules les sessions Claude Code sont réveillées/, "la phrase française de la 1.0.0 est fausse en 1.1.0");
  for (const fait of [
    "le Facteur remet la lettre au socket de messagerie propre à la session, et, sur un réveil, le moniteur du plugin l'affiche",
    "La poussée du Facteur dans une session Claude Code 2.1.302 vivante a été observée dans la maison des auteurs le 18/10/2026 (huit lettres remises au socket de la session par le Facteur de la release précédente, dont le Facteur 1.0.0 garde la logique de connexion inchangée) ; la suite de tests vérifie le Facteur 1.0.0 contre un socket de substitution ; le réveil en session par le moniteur du plugin a été vérifié en direct le même jour.",
    "Pour Codex (avec ses hooks 1.1.0 installés ; vu en direct une fois le 22/10/2026, sur une maison jetable), le Facteur sonne la chaise par `codex queue` — une enveloppe, jamais un corps de lettre",
    "Un statut daté du 21/10/2026 veut dire : ce jour-là, sur macOS, contre une maison Codex jetable avec un modèle local, `codex queue` a réveillé une session inactive"
  ]) assert.ok(fr.includes(fait), `README.fr.md : ${fait}`);
  assert.doesNotMatch(en, /not yet seen in a live session/, "S15 : plus de réserve contraire à la marche du 22/10");
  assert.doesNotMatch(fr, /pas encore vu en session vivante/, "S15, en français");
  // S20/S21 (cinquième passe) : deux bords, pas trois — le message d'enclos est corrigé (R3) et
  // `valxos-table enclos --list` n'existe pas ; « ask for more rows » ne vaut ni au MCP (200) ni au web (500).
  const journal = read("CHANGELOG.md").replace(/\s+/g, " ");
  assert.ok(en.includes("Two edges of 1.1.0 are listed in the CHANGELOG"), "README : deux bords");
  assert.ok(fr.includes("Deux bords de la 1.1.0 sont listés dans le CHANGELOG"), "README.fr : deux bords");
  assert.ok(journal.includes("The MCP tool's limit stops at 200 rows and the web page's window at 500"), "CHANGELOG : les deux plafonds");
  assert.ok(journal.includes("A wider `valxos-history --limit`, which is not capped, finds it; narrowing to its thread (`thread_id`, `valxos-history --thread`) finds it unless the hidden letters share that thread."), "CHANGELOG : ce qui retrouve la lettre");
  for (const [texte, fichier] of [[en, "README.md"], [fr, "README.fr.md"], [journal, "CHANGELOG.md"]]) {
    assert.doesNotMatch(texte, /enclos --list|ask for more rows|demander plus de lignes|may name an enclosure|peut nommer un enclos|Three edges|Trois bords/i, `${fichier} : les bords d'avant`);
  }
  // N4 (re-revue du round 2) : la preuve mesure 5,7 s depuis la LETTRE (sonnerie à +0,35 s, tour à +5,7 s).
  const clients = read("docs/MCP_CLIENTS.md").replace(/\s+/g, " ");
  for (const [texte, fichier, phrase] of [
    [en, "README.md", "an autonomous turn 5.7 s after the letter"],
    [fr, "README.fr.md", "tour autonome 5,7 s après la lettre"],
    [clients, "docs/MCP_CLIENTS.md", "an autonomous turn started 5.7 s after the letter"]
  ]) {
    assert.ok(texte.includes(phrase), `${fichier} : ${phrase}`);
    assert.doesNotMatch(texte, /5[.,]7 s (?:later|plus tard)/, `${fichier} : « 5.7 s later » se lisait depuis la sonnerie`);
  }
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

test("README — Known limitations : la négociation, les outils différés (neuf en 1.1.0), le piège de la source npm, l'échéance du moniteur, les chaises qui restent, la sonnette Codex, l'enclos", () => {
  const limites = section(read("README.md"), "Known limitations").replace(/\s+/g, " ");
  const ordre = [
    "Harness parity is incomplete",
    "MCP_PROTOCOL_NEGOTIATION=legacy",
    "_meta['anthropic/alwaysLoad']",
    "the other nine tools",
    "npm pack --ignore-scripts",
    "Claude Code 2.1.271 and later give Monitor watches a deadline",
    "valxos-chaise moissonner",
    "The launchd plists written by `valxos-messenger install --launchd` carry no `CLAUDE_CONFIG_DIR`, and their `VALXOS_MAISONS` is your `~/.claude` path unless the installer ran with a declaration",
    "The web door's page",
    "The Codex doorbell rings once per letter",
    "The enclosure is not a security boundary"
  ];
  let avant = -1;
  for (const fait of ordre) {
    const ici = limites.indexOf(fait);
    assert.ok(ici > avant, `Known limitations : « ${fait} » présent, après le précédent`);
    avant = ici;
  }
  // « neuf » vient du serveur : les outils enregistrés moins ceux marqués alwaysLoad.
  const serveur = read("src/mcp-server/server.js");
  const enregistres = [...serveur.matchAll(/server\.registerTool\(\s*"([a-z_]+)"/g)].length;
  const toujours = (serveur.match(/"anthropic\/alwaysLoad": true/g) || []).length;
  assert.ok(enregistres >= 9 && toujours >= 3, `sonde impossible : ${enregistres} outil(s), ${toujours} marqué(s)`);
  const MOTS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
  const MOTS_FR = ["zéro", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf", "dix", "onze", "douze"];
  assert.ok(limites.includes(`the other ${MOTS[enregistres - toujours]} tools`), `le README compte ${enregistres - toujours} outils différables, comme server.js`);
  assert.ok(limites.includes("`inbox`, `send`, `ack` and `reply` are marked always-load"), "reply est dit toujours chargé");
  for (const fait of [
    "Claude Code 2.1.292 and later", "since Claude Code 2.1.275", "`valxos-doctor --reap`", "`name#session`",
    // R7 (PREUVES/moniteur-35min.md, 18/10/2026) : le moniteur passe la deadline.
    "In an interactive Claude Code 2.1.302 session the plugin monitor stayed armed for the whole 40-minute session, past the 30-minute deadline Claude Code gives Monitor watches, and presented a letter posted at minute 33 within 20 ms (18/10/2026). Under `claude -p` the monitor is not armed; the hooks deliver instead.",
    // La porte web calcule son avis d'attente avec la même liste de maisons.
    "under launchd the Facteur scans that list only, and the web door's `attente` advice on a send uses that same list. If your Claude Code configuration lives elsewhere, run the installer again with the complete list in `VALXOS_MAISONS`",
    // 1.1.0 : les marques de 1.1.0 sont lues par la suite, pas revues en session.
    "The 1.1.0 marks (`reply` always loaded; `tables`, `table_manage` and `envoi_status` deferred) are read by the test suite on the running server and were not re-observed in a live session.",
    // 1.1.0 : la sonnette ne voit pas Échap ; sa raison est une raison de TOURNÉE ; l'enclos n'est pas une frontière.
    "after Escape in the Codex TUI, a queued envelope waits until the next prompt typed by a human",
    "`envoi_status` shows `tournee.reason: \"sonnette-codex-impossible\"`",
    "One chair card per lineage: two Codex sessions served under one name ring the session that wrote the card last",
    "the `/hooks` approval of the hooks the installer writes and the door opening a closed app were not seen on screen",
    "`hors_enclos: true`", "There is no door to the iPhone app.",
    "A Codex chair whose door is `app` gets the desktop app opened on its thread when a letter rings while the app is closed, even if the session is a terminal one"
  ]) {
    assert.ok(limites.includes(fait), `Known limitations : ${fait}`);
  }
  // Les plists launchd épinglent la déclaration des maisons (1.1.0, Tâche 2),
  // jamais la maison désignée : l'oracle est le gabarit, et le rendu par
  // défaut de l'installeur. Le jour où l'un ou l'autre change, cette garde
  // rougit et la limite doit changer avec lui.
  for (const gabarit of ["scripts/launchd/com.valxos.messenger.facteur.plist", "scripts/launchd/com.valxos.messenger.web.plist"]) {
    const plist = read(gabarit);
    assert.match(plist, /<key>EnvironmentVariables<\/key>/, `sonde impossible : ${gabarit} n'a plus de bloc d'environnement`);
    assert.match(plist, /<key>VALXOS_MAISONS<\/key>\s*<string>__VALXOS_MAISONS__<\/string>/, `${gabarit} n'épingle plus les maisons : la limite launchd du README est fausse`);
    for (const clef of ["CC2CC_MAISONS", "CLAUDE_CONFIG_DIR"]) assert.ok(!plist.includes(clef), `${gabarit} porte ${clef} : la limite launchd du README est fausse`);
  }
  assert.match(read("scripts/launchd/plists.js"), /return maisons \|\| path\.join\(home, "\.claude"\);/, "sonde : sans déclaration, le plist vaut <home>/.claude, comme le disent les README");
  for (const [fichier, phrase] of [
    ["README.md", "Both plists pin `VALXOS_MAISONS`: the declaration the installer runs with, as written, else your `~/.claude` path. They carry no `CLAUDE_CONFIG_DIR`: under launchd the Facteur scans that list only, and the web door's `attente` advice on a send uses that same list"],
    ["README.fr.md", "Les deux plists épinglent `VALXOS_MAISONS` : la déclaration avec laquelle l'installeur tourne, telle qu'écrite, sinon le chemin de votre `~/.claude`. Ils ne portent pas `CLAUDE_CONFIG_DIR` : sous launchd, le Facteur ne parcourt que cette liste, et l'avis `attente` de la porte web sur un envoi utilise la même liste"]
  ]) assert.ok(read(fichier).replace(/\s+/g, " ").includes(phrase), `${fichier} : l'installation launchd le dit aussi`);
  assert.doesNotMatch(read("README.md"), /not measured in this release/, "R7 est prouvé : plus de « not measured »");
  assert.doesNotMatch(read("README.fr.md"), /n'a pas été mesuré dans cette release/, "R7 est prouvé : plus de « pas mesuré »");
  // Les codes cités sont ceux que le guichet et la tournée rendent vraiment :
  // `lignee-ambigue` est un `attente.motif` du guichet ; `sonnette-codex-impossible`
  // est une raison de TOURNÉE, que `envoi_status` lit dans la dernière tentative.
  assert.ok(limites.includes('"lignee-ambigue"') && read("src/lib/registry.js").includes('motif: "lignee-ambigue"'), "le code de la lettre tenue vient du code");
  assert.match(read("src/facteur/porte-codex-regles.js"), /export const MOTIF_SONNETTE_IMPOSSIBLE = "sonnette-codex-impossible";/, "la raison de tournée vient du code");
  assert.match(serveur, /tournee: tourneeDe\(row\.msg_id\)/, "et envoi_status la rend dans `tournee`");
  assert.doesNotMatch(limites, /attente\.motif: "sonnette-codex-impossible"/, "sonnette-codex-impossible n'est jamais un attente.motif");
  // « What it is not » : la poussée hors session et les hooks, bornés aux deux harnais.
  const pas = section(read("README.md"), "What it is not").replace(/\s+/g, " ");
  assert.ok(pas.includes("the monitor is Claude Code-specific, the hooks exist for Claude Code and Codex only"), "What it is not : les hooks, Claude Code et Codex");
  const fr = section(read("README.fr.md"), "Limites connues").replace(/\s+/g, " ");
  for (const fait of ["MCP_PROTOCOL_NEGOTIATION=legacy", "_meta['anthropic/alwaysLoad']", `les ${MOTS_FR[enregistres - toujours]} autres`, "`reply`", "npm pack --ignore-scripts", "2.1.292", "2.1.275", "2.1.271", "valxos-chaise moissonner", '"lignee-ambigue"', "ne portent pas `CLAUDE_CONFIG_DIR`, et leur `VALXOS_MAISONS` est le chemin de votre `~/.claude`",
    "le moniteur du plugin est resté armé pendant toute la session de 40 minutes", "relancez l'installeur avec la liste complète dans `VALXOS_MAISONS`",
    "et l'avis `attente` de la porte web sur un envoi utilise la même liste",
    "La sonnette Codex sonne une fois par lettre", "L'enclos n'est pas une frontière de sécurité", '`envoi_status` montre `tournee.reason: "sonnette-codex-impossible"`',
    "Il n'y a pas de porte vers l'app iPhone.",
    "Une chaise Codex dont la porte est `app` voit l'app de bureau s'ouvrir sur son fil quand une lettre sonne alors que l'app est fermée, même si la session est un terminal"]) {
    assert.ok(fr.includes(fait), `Limites connues : ${fait}`);
  }
  assert.doesNotMatch(fr, /attente\.motif: "sonnette-codex-impossible"/, "en français non plus");
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
  // LES RUES (1.1.0, Tâche 2) : le code développe une entrée `…/*`, et elle
  // seule ; les deux README et la doc des clients le disent.
  assert.ok(corpsMaisons.includes('endsWith("/*")'), "sonde impossible : maisonsConnues ne développe plus les rues");
  for (const [fichier, fait] of [
    ["README.md", "An entry that ends in `/*` is a street of houses: every directory directly under that path is a house"],
    ["README.md", "The street is read again at each round, so a house created after the Facteur started is scanned without a restart"],
    ["README.fr.md", "Une entrée qui finit par `/*` est une rue de maisons : chaque dossier directement sous ce chemin est une maison"],
    ["README.fr.md", "La rue est relue à chaque tournée"],
    ["docs/MCP_CLIENTS.md", "an entry ending in `/*` stands for every directory directly under that path, read again at each round"]
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

// 1.1.0 (22/10/2026) — LES TABLES ET LA SONNETTE CODEX : la vitrine dit ce que
// le code fait, et chaque phrase a son oracle dans l'arbre — le serveur MCP
// (reply, les codes), les deux binaires neufs, le format des en-têtes, la
// règle du réveil, la porte Codex du Facteur, le hook et son gabarit,
// l'installeur. Les phrases sont épinglées en anglais et en français ; le code
// ne l'est qu'une fois. `sonnette-codex-impossible` est une raison de TOURNÉE
// (la dernière tentative, que `envoi_status` rend dans `tournee`), jamais un
// `attente.motif` : la vitrine ne la range jamais parmi les codes d'attente.
test("README — « Tables » et « Doorbell for Codex » (en et fr) : les phrases, et leurs oracles dans le code", async () => {
  const serveur = read("src/mcp-server/server.js");
  assert.match(serveur, /server\.registerTool\(\s*"reply"/, "sonde : reply est un outil du serveur");
  for (const code of ['refus: "hors-enclos"', 'refus: "table-fermee"', 'refus: "pas-expediteur"']) assert.ok(serveur.includes(code), `sonde : le serveur rend ${code}`);
  assert.match(read("src/bin/valxos-table.js"), /valxos-table enclos <sender> <name>/, "sonde : l'enclos est un geste de valxos-table");
  assert.match(read("src/bin/valxos-history.js"), /--envoi <id>/, "sonde : valxos-history exporte un envoi");
  const { ligneDeTable } = await import("../src/lib/format.js");
  assert.equal(ligneDeTable({ nom: "film", mode: "direct", position: "seen up to 1:25:00" }), 'Table: film (direct) · position: "seen up to 1:25:00"', "sonde : la ligne de table cite la position en JSON");
  assert.match(read("src/lib/format.js"), /Reminder: \$\{/, "sonde : l'en-tête porte Reminder: <n>");
  const { deciderLeReveil } = await import("../src/lib/guichet.js");
  assert.equal(deciderLeReveil({ priority: "high", tableReveil: "prochain-tour" }).sansReveil, false, "sonde : high réveille toujours");
  assert.equal(deciderLeReveil({ priority: "low", tableReveil: "reveil", mentionne: true }).sansReveil, true, "sonde : low ne réveille jamais, mention comprise");
  assert.equal(deciderLeReveil({ priority: "normal", tableReveil: "prochain-tour", mentionne: true }).sansReveil, false, "sonde : la mention réveille");
  assert.equal(deciderLeReveil({ priority: "normal", tableReveil: "reveil", reaction: true, modeTable: "direct" }).sansReveil, true, "sonde : la réaction en mode direct est calme");
  assert.equal(deciderLeReveil({ priority: "normal", tableReveil: "reveil", membreReveil: "prochain-tour" }).sansReveil, true, "sonde : la règle du membre avant celle de la table");
  const { fenetreDeReService } = await import("../src/lib/database.js");
  assert.deepEqual([0, 1, 2, 3, 4].map((n) => fenetreDeReService(n) / 60000), [10, 20, 40, 60, 60], "sonde : les rappels s'espacent 10, 20, 40, puis 60 minutes");
  const { argumentsDeSonnette, lienDuFil, MOTIF_SONNETTE_IMPOSSIBLE, BUNDLE_APP_CODEX } = await import("../src/facteur/porte-codex-regles.js");
  assert.equal(argumentsDeSonnette({ thread_id: "t" }, "e")[0], "queue", "sonde : la sonnette est codex queue");
  assert.equal(lienDuFil("u"), "codex://threads/u", "sonde : la porte ouvre l'app sur le fil");
  assert.equal(MOTIF_SONNETTE_IMPOSSIBLE, "sonnette-codex-impossible", "sonde : la raison de tournée");
  assert.equal(BUNDLE_APP_CODEX, "com.openai.codex", "sonde : l'app se cherche par son identifiant de paquet");
  const { porteDeLEnvironnement } = await import("../src/lib/chaise-codex.js");
  assert.equal(porteDeLEnvironnement({}), "app", "sonde : sans VALXOS_CODEX_PORTE, la porte est app");
  assert.equal(porteDeLEnvironnement({ VALXOS_CODEX_PORTE: "cli" }), "cli", "sonde : un lanceur de terminal pose cli");
  const { BUDGET_CARACTERES } = await import("../src/hooks/codex/harness-common.js");
  assert.equal(BUDGET_CARACTERES, 8000, "sonde : le hook Codex injecte 8 000 caractères au plus");
  const { LONGUEUR_SUJET_SONNETTE } = await import("../src/lib/sonnette.js");
  assert.equal(LONGUEUR_SUJET_SONNETTE, 60, "sonde : l'objet de l'enveloppe est coupé à 60");
  assert.ok(exists("src/hooks/codex/codex-hook.js") && exists("scripts/codex/hooks.template.json"), "sonde : le hook Codex et son gabarit existent");
  assert.match(read("scripts/install.js"), /--codex/, "sonde : l'installeur connaît --codex");
  assert.match(read("src/facteur/porte-codex.js"), /exec resume/, "sonde : la porte dit qu'elle ne lance jamais codex exec resume");
  assert.doesNotMatch(read("src/facteur/porte-codex.js").replace(/^\s*\/\/.*$/gm, ""), /"resume"/, "sonde : et aucun argument resume n'est lancé");

  const tables = plat(section(read("README.md"), "Tables"));
  for (const phrase of [
    "A **table** is an address book, not a mailbox",
    "posts **one letter per member**, the sender excluded under every name it goes by",
    "`high` and `critical` always wake; `low` never does.",
    "`reveiller: [\"<member>\", ...]` on `send` or `reply` wakes the members it names (except at `low` priority).",
    "A reply in a `direct` table is a quiet reaction: nobody is woken; the next beat wakes.",
    "`prochain-tour` (next turn)",
    "A quiet letter is not carried by the Facteur and never holds a stop",
    "its letters never give a cc copy to another chair of a member's lineage (`sans_copie`)",
    "`refus: \"hors-enclos\"`",
    "`hors_enclos: true` (`--hors-enclos` on `valxos-send`)",
    "(`table-sous-enclos`)",
    "The enclosure is a seatbelt for a sender who asked for it, not a boundary",
    "never \"read\": only the acknowledgement means seen and handled",
    "(`tournee: { state, reason, at }`)",
    "In letter lines (`inbox`, `history`, `valxos-inbox`), `table` is the table's name; in a send's answer it is the table itself.",
    "`Table: <name> (<mode>) · position: \"<text>\"`",
    "The position is 120 characters at most (code points)",
    "`valxos-history --thread <id> | --table <name> | --envoi <id>`",
    "markdown folds the letters of one table send into one entry, and its count line counts entries",
    "`Reminder: <n>`",
    "where 1.0.0 brought an unacknowledged letter back every 10 minutes, 1.1.0 brings it back after 10, 20, 40, then every 60 minutes",
    "in the hooks' and the monitor's header",
    "`From: alice (atelier)`",
    "`alice#<prefix>`",
    "(`attente.motif: \"chaise-ambigue\"`)",
    "`envoi_status`", "`reply`", "`table_manage`", "`tables`"
  ]) assert.ok(tables.includes(phrase), `README.md, Tables : ${phrase}`);
  // La 1.0.0 re-servait une lettre non accusée toutes les dix minutes (la base
  // de ce run : DEFAULT_REDELIVER_AFTER_MS, `delivered_at` ré-estampillé), jamais « après
  // chaque appel d'outil » (revue de la Tâche 12, finding 2).
  for (const fichier of ["README.md", "README.fr.md", "CHANGELOG.md"]) {
    assert.doesNotMatch(plat(read(fichier)), /after every tool call|après chaque appel d'outil\)? ?au lieu|au lieu de revenir après chaque appel d'outil/, `${fichier} : la 1.0.0 ne revenait pas après chaque appel d'outil`);
  }
  const sonnette = plat(section(read("README.md"), "Doorbell for Codex"));
  for (const phrase of [
    "`src/hooks/codex/codex-hook.js`",
    "`--serves <name>`; a hook whose identity is not served answers `{}` and opens no office",
    "(8,000 characters at most, its preamble included), marks them delivered and never acknowledges them",
    "`<office>/codex/<lineage>.json`",
    "`src/facteur/porte-codex.js`",
    "`codex queue --thread <thread id> --message <envelope>`",
    "subject cut at 60 characters",
    "**never a letter body**: a queued message reaches the model as the user's own words",
    "`lsappinfo find bundleid=com.openai.codex`",
    "`open codex://threads/<uuid>`",
    "once per letter, and only for a chair whose door is `app`",
    "unset means `app` (the desktop app has no launcher), and a terminal launcher should export `VALXOS_CODEX_PORTE=cli`",
    "`VALXOS_CODEX_OUVRIR_APP=0`",
    "It never runs `codex exec resume`",
    "`valxos-messenger install --codex --self <name>`",
    "`[mcp_servers.valxos_messenger]`",
    "a conflict writes nothing",
    "`/hooks`",
    "after **Escape** in the Codex TUI the queue freezes until the next prompt typed by a human",
    "Before a session's first turn `codex queue` cannot reach it (`no rollout found`)",
    "five seconds per attempt, with one retry",
    "`envoi_status` shows the round's reason, `sonnette-codex-impossible`",
    "There is no door to the iPhone app."
  ]) assert.ok(sonnette.includes(phrase), `README.md, Doorbell for Codex : ${phrase}`);
  assert.doesNotMatch(sonnette, /attente\.motif: "sonnette-codex-impossible"/, "Doorbell for Codex : jamais un attente.motif");
  const porteWeb = plat(section(read("README.md"), "The web door"));
  for (const phrase of ["`a: \"table:<name>\"`", "`403 hors-enclos`", "`404 table-inconnue`", "`403 pas-membre`", "`400 nom-de-table-invalide`", "`hors_enclos: true` (a JSON boolean)", "`interrompu: true`", "`table_mode`", "`chaise_nom`", "`rappel`", "the page's composer does not offer a table in this release"]) {
    assert.ok(porteWeb.includes(phrase), `README.md, The web door : ${phrase}`);
  }
  const web = read("src/web/serveur.js");
  for (const code of ["hors-enclos", "table-inconnue", "pas-membre", "nom-de-table-invalide", "envoi-interrompu"]) assert.ok(web.includes(`"${code}"`), `sonde : la porte web rend ${code}`);
  assert.ok(plat(section(read("README.md"), "Harness support")).includes("The monitor is Claude Code-specific; hooks exist for Claude Code and, since 1.1.0, for Codex."), "Harness support : la phrase de parité");

  const frTables = plat(section(read("README.fr.md"), "Les tables"));
  for (const phrase of [
    "Une **table** est un carnet d'adresses, pas une boîte aux lettres", "dépose **une lettre par membre**",
    "`high` et `critical` réveillent toujours ; `low` jamais.", "(sauf en priorité `low`)", "`prochain-tour`", "`refus: \"hors-enclos\"`",
    "(`table-sous-enclos`)", "`sans_copie`", "jamais « lu » : seul l'accusé veut dire vu et traité",
    "`Table: <nom> (<mode>) · position: \"<texte>\"`", "120 caractères au plus (points de code)",
    "`valxos-table`", "`valxos-history --thread <id> | --table <nom> | --envoi <id>`", "`reply`", "`envoi_status`", "`Reminder: <n>`", "là où la 1.0.0 ramenait une lettre non accusée toutes les 10 minutes, la 1.1.0 la ramène après 10, 20, 40, puis toutes les 60 minutes", "dans l'en-tête des hooks et du moniteur",
    "`From: alice (atelier)`", "`alice#<préfixe>`", "(`attente.motif: \"chaise-ambigue\"`)"
  ]) assert.ok(frTables.includes(phrase), `README.fr.md, Les tables : ${phrase}`);
  const frSonnette = plat(section(read("README.fr.md"), "La sonnette Codex"));
  for (const phrase of [
    "`codex queue`", "jamais un corps de lettre", "un message mis en file arrive au modèle comme une parole de l'utilisateur",
    "`open codex://threads/<uuid>`", "une fois par lettre, et seulement pour une chaise dont la porte est `app`", "`VALXOS_CODEX_PORTE=cli`",
    "`VALXOS_CODEX_OUVRIR_APP=0`", "Le Facteur ne lance jamais `codex exec resume`.",
    "`valxos-messenger install --codex --self <nom>`", "`/hooks`", "après **Échap**", "Avant le premier tour d'une session, `codex queue` ne l'atteint pas (`no rollout found`)",
    "`envoi_status` montre la raison de la tournée, `sonnette-codex-impossible`", "Il n'y a pas de porte vers l'app iPhone."
  ]) assert.ok(frSonnette.includes(phrase), `README.fr.md, La sonnette Codex : ${phrase}`);
  assert.doesNotMatch(frSonnette, /attente\.motif: "sonnette-codex-impossible"/, "La sonnette Codex : jamais un attente.motif");
  const frPorte = plat(section(read("README.fr.md"), "La porte web"));
  for (const phrase of ["`a: \"table:<nom>\"`", "`403 hors-enclos`", "`404 table-inconnue`", "`hors_enclos: true`", "`interrompu: true`", "`chaise_nom`", "le composeur de la page ne propose pas de table dans cette version"]) {
    assert.ok(frPorte.includes(phrase), `README.fr.md, La porte web : ${phrase}`);
  }
});

// 1.1.0 — docs/FACTEUR.md (en français) décrit la lettre calme et la porte
// Codex de la tournée : chaque raison qu'il cite est une constante de la porte,
// la clef `calme` est celle que le journal écrit, et le réglage d'ouverture de
// l'app est lu par la config sous le nom que la table des réglages donne.
test("docs/FACTEUR.md — la lettre calme et la porte Codex : les raisons, la clef du journal, le réglage, tels que le code les écrit", async () => {
  const facteur = plat(read("docs/FACTEUR.md"));
  const regles = await import("../src/facteur/porte-codex-regles.js");
  for (const raison of [regles.MOTIF_SONNETTE_IMPOSSIBLE, regles.MOTIF_SONNETTE_DEJA_SONNEE, regles.MOTIF_SONNETTE_DIFFEREE, regles.PORTE_CODEX_ABSENTE]) {
    assert.ok(facteur.includes(`\`${raison}\``), `FACTEUR.md nomme la raison \`${raison}\``);
  }
  const porte = read("src/facteur/porte-codex.js");
  for (const detail of ["codex-introuvable", "codex-injoignable", "codex-delai", "codex-refus", "codex-fil-sans-session"]) {
    assert.ok(porte.includes(`"${detail}"`), `sonde : la porte rend ${detail}`);
    assert.ok(facteur.includes(`\`${detail}\``), `FACTEUR.md nomme le détail \`${detail}\``);
  }
  const tournee = read("src/facteur/round.js");
  for (const etat of ["sonnee-codex", "sonnee-codex-app-ouverte"]) {
    assert.ok(tournee.includes(`"${etat}"`), `sonde : la tournée compte ${etat}`);
    assert.ok(facteur.includes(`\`${etat}\``), `FACTEUR.md nomme ${etat}`);
  }
  assert.ok(tournee.includes("{ calme: true }") && facteur.includes("`calme: true`"), "la lettre calme non prise se dit `calme: true`, au journal comme à la doc");
  assert.ok(facteur.includes("ACCUSÉE, RÉSERVÉE, DIFFÉRÉE, ou PRÊTE"), "le mode une-lettre nomme PRÊTE");
  assert.match(read("src/lib/config.js"), /valeurDeLEnvironnement\(env, "CC2CC_CODEX_OUVRIR_APP"\)/, "sonde : la config lit le réglage d'ouverture");
  assert.ok(facteur.includes("| `VALXOS_CODEX_OUVRIR_APP` (`CC2CC_CODEX_OUVRIR_APP`) |"), "la table des réglages porte VALXOS_CODEX_OUVRIR_APP");
  assert.ok(facteur.includes("jamais un corps"), "FACTEUR.md dit que l'enveloppe ne porte jamais un corps");
  assert.match(porte, /process\.kill\(-/, "sonde : le couperet tue le GROUPE de l'enfant");
  assert.ok(facteur.includes("le groupe de processus de l'enfant est tué ; un petit-fils qui a quitté ce groupe (`setsid`) lui survit"), "FACTEUR.md dit la limite du couperet");
  assert.ok(!facteur.includes("ses petits-enfants sont tués"), "plus de promesse sur tous les petits-enfants");
  for (const detail of ["fiche-incomplete", "open-impossible", "open-delai", "run-inaccessible"]) {
    assert.ok(porte.includes(`"${detail}"`) && facteur.includes(`\`${detail}\``), `FACTEUR.md nomme aussi ${detail}`);
  }
  // m3 (re-revue du round FINAL) : la règle d'A4, comme README et MCP_CLIENTS ; et S11.
  assert.ok(facteur.includes("Le droit d'ouvrir se juge par lettre neuve"), "FACTEUR.md dit la règle d'A4");
  assert.ok(facteur.includes("peut être couverte de nouveau par l'ouverture d'une neuve"), "FACTEUR.md dit qu'une ancienne lettre peut être couverte de nouveau");
  assert.ok(facteur.includes("sur les lettres qui y avaient droit, une fois chacune"), "FACTEUR.md dit une tentative par lettre (S11)");
  assert.ok(!facteur.includes("L'ouverture tentée se note sur la lettre\n"), "l'ancienne phrase");
});

// ── LA FIN DE LA 1.1.0 : CE QUE LES DOCS DISENT, EXACTEMENT ───────────────────
// B4 (passe adverse) : « refusé avant toute écriture » était absolu ; la garantie prouvée est
// « aucune lettre écrite » — la carte de pair de l'appelant peut être inscrite avant le refus.
// B16 (marche Codex) : « low never wakes » se lit comme une règle générale ; elle ne vaut que pour
// une lettre de TABLE. Une lettre directe `low` est portée et sonnée comme en 1.0.0 — chez Codex,
// une sonnerie démarre un tour — et seul le filet du Stop l'ignore.
// B15 (relecture) : la fiche d'une lignée Codex est celle de la DERNIÈRE session qui l'écrit
// (`tenirLaFiche` : SessionStart, et un prompt ou un Stop dont le fil n'est pas celui de la fiche).
// B11 (parqué T12) : la page promettait « exactly one of two statuses » et en portait un
// troisième (« Not yet seen live ») pour la sonnette Codex. Depuis la marche du 22/10/2026 sur un
// Codex jetable (le hook livré, la porte et l'installeur ont tourné en direct), la sous-section
// porte le premier statut, daté, et le troisième n'existe plus : deux statuts, comme la page le dit.
test("1.1.0 — les docs disent la portée exacte : aucune LETTRE écrite au refus de l'enclos (la carte du pair peut l'être), la règle low d'une lettre de table, la fiche de la dernière session, deux statuts et la sonnette vue en direct", () => {
  const readme = plat(read("README.md"));
  const readmeFr = plat(read("README.fr.md"));
  const changelog = plat(read("CHANGELOG.md"));
  const clients = plat(read("docs/MCP_CLIENTS.md"));
  const presents = [
    [readme, "README.md", "is refused before any letter is written (the sender's peer card may already be recorded by then"],
    [changelog, "CHANGELOG.md", "is refused before any letter is written (the sender's peer card may already be recorded by then"],
    [clients, "docs/MCP_CLIENTS.md", "is refused before any letter is written (the caller's peer card may already be recorded by then)"],
    [readmeFr, "README.fr.md", "est refusée avant qu'aucune lettre ne soit écrite (la carte de pair de l'expéditeur a pu être inscrite avant"],
    [readme, "README.md", "These are the rules of a table letter. A direct letter is carried and rung as in 1.0.0 whatever its priority, `low` included (on a Codex chair a ring starts a turn); only the Stop safety net never holds a stop for a `low` letter."],
    [changelog, "CHANGELOG.md", "A direct letter is carried and rung as in 1.0.0 whatever its priority, `low` included; only the Stop safety net ignores a `low` letter."],
    [clients, "docs/MCP_CLIENTS.md", "A direct letter is rung whatever its priority, `low` included, as in 1.0.0: the quiet rules (`sans_reveil`) are a table letter's"],
    [readmeFr, "README.fr.md", "Ce sont les règles d'une lettre de table. Une lettre directe est portée et sonnée comme en 1.0.0 quelle que soit sa priorité, `low` comprise"],
    [readme, "README.md", "ring the session that wrote the card last"],
    [changelog, "CHANGELOG.md", "ring the session that wrote the card last"],
    [clients, "docs/MCP_CLIENTS.md", "ring the session that wrote the card last"],
    // m2 (re-revue du round FINAL) : la phrase française suit la même règle.
    [readmeFr, "README.fr.md", "sonnent la dernière session qui a écrit la fiche (son `SessionStart`, ou un prompt ou un `Stop` d'une session dont la fiche ne nomme pas le fil)"],
    [clients, "docs/MCP_CLIENTS.md", "Every client section carries exactly one of two statuses, and nothing in between"],
    [clients, "docs/MCP_CLIENTS.md", "**Verified on macOS on 2026-10-22 with codex-cli 0.163.0**"],
    [readme, "README.md", "**Seen live on 22/10/2026 with codex-cli 0.163.0**"],
    [changelog, "CHANGELOG.md", "were seen live once, on 2026-10-22"]
  ];
  for (const [texte, fichier, phrase] of presents) assert.ok(texte.includes(phrase), `${fichier} : ${phrase}`);
  for (const [texte, fichier] of [[readme, "README.md"], [changelog, "CHANGELOG.md"], [clients, "docs/MCP_CLIENTS.md"]]) {
    assert.ok(!texte.includes("ring the one whose `SessionStart` ran last"), `${fichier} : l'ancienne règle de la fiche`);
    assert.ok(!readmeFr.includes("celle dont le `SessionStart` a tourné en dernier"), "README.fr.md : l'ancienne règle de la fiche");
    assert.ok(!/outside (?:the table|its closed table) is refused before anything is written/.test(texte), `${fichier} : l'ancienne promesse absolue`);
  }
  for (const [texte, fichier] of [[readme, "README.md"], [readmeFr, "README.fr.md"], [changelog, "CHANGELOG.md"], [clients, "docs/MCP_CLIENTS.md"]]) {
    assert.ok(!/not yet seen live|pas encore vu en direct|third status/i.test(texte), `${fichier} : le troisième statut n'existe plus`);
  }
  assert.match(read("src/bin/valxos-table.js"), /In a table, priority high and critical\s+always wake; low never does/, "l'aide de valxos-table dit que la règle est celle d'une table");
});

// B12 (revue finale M-2, M-3) — DEUX LIMITES QUI SE DISENT. Une table fermée se cache, pas son
// existence : les codes de refus la trahissent à un non-membre (SECURITY.md). Et un expéditeur NU
// (la CLI, un client sans chaise) inscrit dans une table sous sa lignée ET sous une de ses chaises
// reçoit sa propre lettre à cette chaise : le guichet ne devine pas la chaise d'un nom nu.
test("B12 — SECURITY.md dit que l'existence d'une table fermée se devine ; le CHANGELOG, qu'un expéditeur nu reçoit sa lettre à sa chaise inscrite", () => {
  assert.ok(
    plat(read("SECURITY.md")).includes("A closed table hides its letters, its position and itself from non-members, but not its existence: the refusal codes (`pas-membre` or `table-fermee` against `table-inconnue`) tell a non-member that a closed table of that name exists."),
    "SECURITY.md : l'existence d'une table fermée"
  );
  assert.ok(
    plat(section(read("CHANGELOG.md"), "[1.1.0] — 2026-11-25")).includes("A bare sender (the CLI, or an MCP client without a chair) listed in a table under its lineage and under one of its chairs receives its own letter at that chair: the counter does not guess which chair a bare name is."),
    "CHANGELOG : l'expéditeur nu et sa chaise inscrite"
  );
});
