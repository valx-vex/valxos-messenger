// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LA DOC DE CÂBLAGE MCP RESTE HONNÊTE — OU ELLE ROUGIT ICI.
//
// docs/MCP_CLIENTS.md dit à un autre harnais (Codex, Gemini CLI, Hermes…)
// comment brancher le serveur MCP. Une doc de câblage ment vite : un chemin
// renommé, un binaire retiré du manifeste, une variable d'env qui n'existe
// plus dans src/, un outil ajouté au serveur et jamais listé. Ce fichier ne
// juge pas la prose ; il vérifie que chaque FAIT cité existe encore dans le
// dépôt — l'oracle est le code, jamais la doc elle-même.
//
// Ce qu'il tient aussi : aucune identité de CETTE machine, aucun chemin
// /Users/…, aucun ancien nom hors d'une ligne qui le dit historique. Les
// identités ne s'écrivent pas en clair (aide-identites.js) : elles se
// découvrent sur la machine qui lance le test.
//
// Chaque sonde porte un PLANCHER (« au moins N cités ») : une doc vide ne
// passe jamais par absence de matière — sonde impossible ≠ conforme.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { FORMES_PRIVEES, identitesDeCetteMachine } from "./aide-identites.js";
import { clefValxos, pluginTargetPath } from "../src/lib/config.js";

const repo = path.resolve(new URL("..", import.meta.url).pathname);
const DOC = "docs/MCP_CLIENTS.md";

function lireLaDoc() {
  const fichier = path.join(repo, DOC);
  assert.ok(fs.existsSync(fichier), `${DOC} doit exister`);
  return fs.readFileSync(fichier, "utf8");
}

// Les six clients que la doc promet, chacun sous son titre de niveau 2.
// Antigravity CLI (agy) n'est PAS Gemini CLI : deux binaires, deux
// mécanismes de configuration, deux preuves (18/10/2026).
const CLIENTS = [
  ["Claude Code", /^## [^\n]*Claude Code/m],
  ["Codex CLI", /^## [^\n]*Codex/m],
  ["Gemini CLI", /^## [^\n]*Gemini/m],
  ["Antigravity CLI (agy)", /^## [^\n]*Antigravity/m],
  ["OpenCode", /^## [^\n]*OpenCode/m],
  ["Hermes", /^## [^\n]*Hermes/m]
];

// Les deux seuls statuts admis — jamais une prétention entre les deux. Un
// statut vérifié porte sa date ET la version du client : « vérifié » sans
// version ne dit pas QUEL client a vu passer la lettre (la section Codex du
// 29/08 était fausse en codex-cli 0.162.1, prouvé le 18/10/2026).
const STATUTS = [
  /Verified on macOS on \d{4}-\d{2}-\d{2} with [^\n]*?\b\d+\.\d+\.\d+\b/,
  /Written from upstream documentation, not verified on a live client/
];

// La section d'un titre de niveau 2 : de ce titre au prochain titre de niveau 2.
function sectionDe(doc, motif) {
  const debut = doc.search(motif);
  assert.ok(debut >= 0, `section introuvable : ${motif}`);
  const corps = doc.slice(debut + 3);
  const fin = corps.search(/^## /m);
  return fin < 0 ? doc.slice(debut) : doc.slice(debut, debut + 3 + fin);
}

function lireTout(dossier, extensions) {
  const morceaux = [];
  for (const entree of fs.readdirSync(dossier, { withFileTypes: true })) {
    const chemin = path.join(dossier, entree.name);
    if (entree.isDirectory()) morceaux.push(lireTout(chemin, extensions));
    else if (extensions.some((ext) => entree.name.endsWith(ext))) morceaux.push(fs.readFileSync(chemin, "utf8"));
  }
  return morceaux.join("\n");
}

// ── (a) une section par client, un statut honnête, un smoke test ───────────

test("la doc porte une section par client — chacune avec UN statut admis et un smoke test", () => {
  const doc = lireLaDoc();
  for (const [nom, motif] of CLIENTS) {
    const section = sectionDe(doc, motif);
    const statuts = STATUTS.filter((statut) => statut.test(section));
    assert.equal(statuts.length, 1, `${nom} : exactement un des deux statuts admis (${statuts.length} trouvé)`);
    assert.match(section, /smoke test/i, `${nom} : la section finit par un smoke test`);
  }
});

test("les variables qui comptent sont nommées sous leur nom VALXOS, et le bureau par défaut aussi", () => {
  const doc = lireLaDoc();
  for (const nom of ["VALXOS_SELF", "VALXOS_SESSION_NAME", "VALXOS_MESSENGER_HOME"]) {
    assert.ok(doc.includes(nom), `${nom} est nommée`);
  }
  assert.match(doc, /~\/\.valxos-messenger/, "le bureau par défaut est nommé");
});

// F2 (passe adverse, 28/09) : un bloc env de client ne passe par aucun shell.
test("F2 — la doc dit d'écrire un chemin ABSOLU dans le bloc env d'un client, et ce qu'il advient d'un chemin relatif", () => {
  const doc = lireLaDoc();
  assert.match(doc, /absolute path[^.]*env/i, "la consigne du chemin absolu est écrite");
  assert.match(doc, /relative (?:path|value)[^.]*refused/i, "le refus d'un chemin relatif est dit");
});

// ── (b) chaque chemin du dépôt cité existe ──────────────────────────────────
//
// `<path-to-valxos_messenger>/` et `${CLAUDE_PLUGIN_ROOT}/` désignent la
// racine du dépôt : on les retire avant de chercher, pour que le chemin qui
// les suit soit vérifié lui aussi. Les URL sont retirées : un chemin dans une
// adresse web n'est pas un chemin de ce dépôt.
const RACINES = "src|scripts|docs|skills|hooks|monitors|test|\\.claude-plugin";

function cheminsCites(doc) {
  const texte = doc
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/<path-to-valxos_messenger>\//g, "")
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}\//g, "");
  const motif = new RegExp(`(?<![\\w/.-])((?:${RACINES})/[\\w.-]+(?:/[\\w.-]+)*|mcp\\.json|package\\.json)`, "g");
  return [...new Set([...texte.matchAll(motif)].map((m) => m[1].replace(/\.+$/, "")))];
}

test("chaque chemin du dépôt cité par la doc existe", () => {
  const chemins = cheminsCites(lireLaDoc());
  assert.ok(chemins.length >= 5, `plancher : au moins 5 chemins cités (${chemins.length})`);
  for (const chemin of chemins) {
    assert.ok(fs.existsSync(path.join(repo, chemin)), `${chemin} est cité mais n'existe pas`);
  }
});

// ── (c) chaque binaire cité est publié par le manifeste ─────────────────────

test("chaque binaire cité existe dans le `bin` de package.json", () => {
  const doc = lireLaDoc();
  const bin = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).bin || {};
  const cites = new Set(doc.match(/\b(?:valxos|cc2cc)-[a-z0-9]+(?:-[a-z0-9]+)*\b/g) || []);
  cites.delete("cc2cc-v2"); // l'identifiant du serveur, pas un binaire
  assert.ok(cites.size >= 3, `plancher : au moins 3 binaires cités (${cites.size})`);
  for (const nom of cites) assert.ok(Object.hasOwn(bin, nom), `${nom} est cité mais n'est pas un binaire publié`);
});

// ── (d) chaque variable d'env citée est LUE dans src/ ───────────────────────
//
// « Lue » veut dire PASSÉE À UN LECTEUR D'ENVIRONNEMENT — jamais sa simple
// présence textuelle : un nom dans un commentaire ou dans un message
// d'erreur n'est pas une variable que le produit honore (finding réviseur
// F9 : la première version de cette garde se contentait du texte). Les
// lecteurs reconnus : `valeurDeLEnvironnement(…, "X")`,
// `nombreDeLEnvironnement(…, "X")`, `process.env.X`, `process.env["X"]`,
// `env.X`, `env["X"]`, `os.environ.get("X")` / `os.environ["X"]` (Python),
// et — parce que src/ lit aussi PAR CONSTANTE (`const CLEF = "X"` puis
// `valeurDeLEnvironnement(env, CLEF)` ou `Object.hasOwn(env, CLEF)`) — une
// constante ainsi passée à un lecteur. Un nom lu par un chemin que cette
// liste ignore rougit ici : on ajoute le lecteur, jamais on ne revient au
// texte.
//
// src/ lit les clefs sous leur nom historique (CC2CC_*) et les traduit par
// `clefValxos` ; une clef VALXOS_* citée est admise si src/ la lit telle
// quelle OU sous la clef historique qui s'y traduit — la MÊME traduction que
// le produit, jamais une copie.
const NOM_ENV = String.raw`(?:VALXOS|CC2CC)_[A-Z0-9_]+`;
const LECTEURS = String.raw`(?:valeurDeLEnvironnement|nombreDeLEnvironnement)`;

function variablesLuesDans(src) {
  const lues = new Set();
  for (const motif of [
    new RegExp(String.raw`${LECTEURS}\([^,()]+,\s*"(${NOM_ENV})"`, "g"),
    new RegExp(String.raw`process\.env\.(${NOM_ENV})\b`, "g"),
    new RegExp(String.raw`process\.env\[\s*"(${NOM_ENV})"\s*\]`, "g"),
    new RegExp(String.raw`\benv\.(${NOM_ENV})\b`, "g"),
    new RegExp(String.raw`\benv\[\s*"(${NOM_ENV})"\s*\]`, "g"),
    new RegExp(String.raw`os\.environ(?:\.get\(|\[)\s*"(${NOM_ENV})"`, "g")
  ]) for (const m of src.matchAll(motif)) lues.add(m[1]);
  for (const m of src.matchAll(new RegExp(String.raw`\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*"(${NOM_ENV})"`, "g"))) {
    const [, constante, valeur] = m;
    const parConstante = new RegExp(
      String.raw`(?:${LECTEURS}|Object\.hasOwn)\([^,()]+,\s*${constante}\b|process\.env\[\s*${constante}\s*\]|\benv\[\s*${constante}\s*\]`
    );
    if (parConstante.test(src)) lues.add(valeur);
  }
  return lues;
}

test("l'ancre de lecture distingue une variable LUE d'un nom seulement ÉCRIT", () => {
  const texteSeulement = 'const x = "CC2CC_FANTOME"; // vu dans CC2CC_FANTOME_AUSSI, jamais lu\nthrow new Error("posez CC2CC_FANTOME");';
  assert.deepEqual([...variablesLuesDans(texteSeulement)], [], "un nom écrit sans lecteur n'est pas lu");
  const lu = 'const CLEF = "CC2CC_PAR_CONSTANTE";\nvaleurDeLEnvironnement(process.env, "CC2CC_DIRECT");\nnombreDeLEnvironnement(env, "CC2CC_NOMBRE", 3);\nif (Object.hasOwn(env, CLEF)) {}\nprocess.env.VALXOS_POINT; env["CC2CC_CROCHET"]; os.environ.get("CC2CC_PYTHON")';
  assert.deepEqual(
    [...variablesLuesDans(lu)].sort(),
    ["CC2CC_CROCHET", "CC2CC_DIRECT", "CC2CC_NOMBRE", "CC2CC_PAR_CONSTANTE", "CC2CC_PYTHON", "VALXOS_POINT"],
    "chaque lecteur reconnu compte, la constante passée à un lecteur aussi"
  );
});

test("chaque variable VALXOS_*/CC2CC_* citée est LUE dans src/ — sous son nom ou son alias historique", () => {
  const doc = lireLaDoc();
  const src = lireTout(path.join(repo, "src"), [".js", ".mjs", ".py"]);
  const lues = variablesLuesDans(src);
  // L'instrument doit POUVOIR voir sa cible : les deux lectures les plus
  // anciennes de src/ (config.js) sont le contrôle positif.
  for (const connue of ["CC2CC_SELF", "CC2CC_V2_HOME"]) {
    assert.ok(lues.has(connue), `sonde impossible : l'ancre ne voit plus la lecture de ${connue} dans src/`);
  }
  const admises = new Set(lues);
  for (const clef of lues) if (clef.startsWith("CC2CC_")) admises.add(clefValxos(clef));
  const citees = new Set(doc.match(new RegExp(String.raw`\b${NOM_ENV}\b`, "g")) || []);
  assert.ok(citees.size >= 3, `plancher : au moins 3 variables citées (${citees.size})`);
  for (const nom of citees) {
    assert.ok(admises.has(nom), `${nom} est citée mais src/ ne la LIT nulle part — présence textuelle ≠ lecture`);
  }
});

// ── (e) l'ancien nom ne se dit qu'au passé ──────────────────────────────────

const MARQUE_HISTORIQUE = /\b(compat(?:ibility)?|legacy|historical(?:ly)?|formerly|deprecated|alias(?:es)?)\b/i;

test("« cc2cc » n'apparaît que sur une ligne qui le dit historique", () => {
  const fautives = lireLaDoc()
    .split("\n")
    .map((ligne, i) => [i + 1, ligne])
    .filter(([, ligne]) => /cc2cc/i.test(ligne) && !MARQUE_HISTORIQUE.test(ligne));
  assert.deepEqual(fautives, [], `lignes portant l'ancien nom sans le dire historique : ${JSON.stringify(fautives)}`);
});

// ── (f) rien de cette machine ne part dans une doc publique ─────────────────

test("aucun chemin /Users/, aucune forme privée, aucune identité de cette machine", () => {
  const doc = lireLaDoc();
  assert.doesNotMatch(doc, /\/Users\//, "aucun chemin absolu de compte");
  for (const [motif, quoi] of FORMES_PRIVEES) assert.doesNotMatch(doc, motif, quoi);
  for (const { motif, quoi } of identitesDeCetteMachine()) assert.doesNotMatch(doc, motif, quoi);
});

// ── (g) la liste des outils vient du code, pas de la mémoire ────────────────

test("la doc liste EXACTEMENT les outils que le serveur enregistre", () => {
  const serveur = fs.readFileSync(path.join(repo, "src/mcp-server/server.js"), "utf8");
  const enregistres = [...serveur.matchAll(/server\.registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1]).sort();
  assert.ok(enregistres.length >= 8, `sonde impossible : ${enregistres.length} outil(s) lus dans server.js`);
  const listes = [...lireLaDoc().matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]).sort();
  assert.deepEqual(listes, enregistres, "la table des outils de la doc et server.js divergent");
});

// ── (h) les vitrines mènent à la doc ────────────────────────────────────────

test("les deux README mènent à la doc de câblage", () => {
  for (const vitrine of ["README.md", "README.fr.md"]) {
    const texte = fs.readFileSync(path.join(repo, vitrine), "utf8");
    assert.match(texte, /\]\(docs\/MCP_CLIENTS\.md\)/, `${vitrine} pointe vers ${DOC}`);
  }
});

// ── (i) le lien du plugin suit la maison Claude Code déclarée ───────────────
//
// La doc promet : « `<claude-home>` est `$CLAUDE_CONFIG_DIR` s'il est posé,
// sinon `~/.claude` ». Cette sonde rend la promesse MÉCANIQUE : rouge sur une
// base où `pluginTargetPath()` ignore CLAUDE_CONFIG_DIR, verte dès que
// l'installeur le suit. Une doc ne peut pas être vraie « plus tard » sans
// qu'un test le dise.
test("le lien du plugin suit la maison Claude Code déclarée par CLAUDE_CONFIG_DIR", (t) => {
  const maison = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-maison-"));
  const avant = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = maison;
  t.after(() => {
    if (avant === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = avant;
    fs.rmSync(maison, { recursive: true, force: true });
  });
  const cible = pluginTargetPath();
  const racines = [maison, fs.realpathSync(maison)];
  assert.ok(racines.some((racine) => cible.startsWith(racine)), `${cible} doit commencer par ${maison}`);
});

// ── (j) les exigences Node viennent des manifestes, pas de la mémoire ───────
//
// Régression née d'un merge : la page disait « no engines field is declared »
// après que package.json en a reçu un. Si le manifeste porte `engines`, la
// page nomme `engines.<moteur>` avec la MÊME contrainte, au caractère près ;
// si la CI épingle une version de Node, la page la nomme aussi.
test("les exigences Node de la page sont celles de package.json et de la CI", () => {
  const doc = lireLaDoc();
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
  if (pkg.engines) {
    for (const [moteur, contrainte] of Object.entries(pkg.engines)) {
      assert.ok(doc.includes(`engines.${moteur}`), `la page nomme engines.${moteur}`);
      assert.ok(doc.includes(contrainte), `la page porte la contrainte exacte « ${contrainte} » de engines.${moteur}`);
    }
  } else {
    assert.match(doc, /no `engines` field/, "sans engines au manifeste, la page le dit");
  }
  const ci = fs.readFileSync(path.join(repo, ".github/workflows/tests.yml"), "utf8");
  const epingle = ci.match(/node-version:\s*"?([\d.]+)"?/);
  if (epingle) assert.ok(doc.includes(epingle[1]), `la page nomme la version Node épinglée par la CI (${epingle[1]})`);
});

// ── (k) les noms du plugin viennent des manifestes, pas de la mémoire ───────
//
// Run 6 (Task 11) : l'identifiant du plugin et la clef MCP deviennent
// `valxos-messenger`. Les noms d'outils que voit le modèle, la cible du lien
// et le geste `claude plugin enable` en dérivent : la page les cite tels que
// les manifestes et `pluginTargetPath()` les fabriquent. L'ancien nom
// `mcp__plugin_cc2cc-v2_…` n'y survit que sur une ligne qui le dit historique
// (garde (f)).
test("la page cite le plugin, la clef MCP, le lien et les noms d'outils tels que le code les fabrique", () => {
  const doc = lireLaDoc();
  const manifeste = JSON.parse(fs.readFileSync(path.join(repo, ".claude-plugin/plugin.json"), "utf8"));
  const clefs = Object.keys(JSON.parse(fs.readFileSync(path.join(repo, "mcp.json"), "utf8")).mcpServers);
  assert.equal(manifeste.name, "valxos-messenger", "l'identifiant du plugin est celui du produit");
  assert.deepEqual(clefs, ["valxos-messenger"], "une seule clef MCP, celle du produit");
  const [clef] = clefs;
  assert.ok(doc.includes(`mcp__plugin_${manifeste.name}_${clef}__send`), "le nom d'outil vu par le modèle via le plugin");
  assert.ok(doc.includes(`claude plugin enable ${manifeste.name}@skills-dir`), "le geste d'activation");
  assert.ok(doc.includes(`<claude-home>/skills/${path.basename(pluginTargetPath())}`), "la cible du lien");
  assert.ok(doc.includes(`server key \`${clef}\``), "la clef de mcp.json");
});

// ── (l) ce qui a été vérifié le 18/10/2026, harnais par harnais ─────────────
//
// Les reçus de la publication (18/10/2026) : chaque section vérifiée nomme la
// version vue, dit « Not tested: » ce qu'elle n'a pas vu, et porte les
// conditions sans lesquelles la lettre ne passait pas. Une condition oubliée
// est un smoke test qui rougit chez l'inconnu (Codex : sans le réglage
// d'approbation, chaque appel d'outil échoue sous `codex exec`).
const VERIFIES_LE_18_10 = [
  ["Claude Code", /^## [^\n]*Claude Code/m, "Claude Code 2.1.302",
    ["npm i -g valxos-messenger --allow-scripts=better-sqlite3", "valxos-messenger install", "claude -p", "_meta['anthropic/alwaysLoad']", "valxos-chaise moissonner"]],
  ["Codex CLI", /^## [^\n]*Codex/m, "codex-cli 0.162.1",
    ['default_tools_approval_mode = "approve"', "MCP tool call requires approval, but approval policy is never", "the 2026-08-29 wiring without the approval setting no longer works on 0.162.1", "codex exec"]],
  ["Gemini CLI", /^## [^\n]*Gemini/m, "gemini 0.58.0",
    [".gemini/settings.json", "GEMINI_CLI_TRUST_WORKSPACE=true", "--skip-trust", "gemini -p"]],
  ["Antigravity CLI (agy)", /^## [^\n]*Antigravity/m, "agy 1.3.5",
    [".agents/plugins/", "plugin.json", "mcp_config.json", "--dangerously-skip-permissions", "~/.gemini/config/mcp_config.json"]],
  ["OpenCode", /^## [^\n]*OpenCode/m, "opencode 1.18.30",
    ["opencode.json", '"type": "local"', '"environment"', "opencode run"]]
];

test("cinq sections vérifiées le 2026-10-18 : la version vue, ce qui n'a pas été testé, les conditions du reçu", () => {
  const doc = lireLaDoc();
  for (const [nom, motif, version, conditions] of VERIFIES_LE_18_10) {
    // La prose se replie à 80 colonnes : on compare à plat.
    const section = sectionDe(doc, motif).replace(/\s+/g, " ");
    assert.ok(section.includes(`Verified on macOS on 2026-10-18 with ${version}`), `${nom} : vérifié le 2026-10-18 avec ${version}`);
    assert.match(section, /Not tested:/, `${nom} : ce qui n'a pas été testé est dit`);
    for (const condition of conditions) assert.ok(section.includes(condition), `${nom} : la section dit ${condition}`);
  }
  const codex = sectionDe(doc, /^## [^\n]*Codex/m);
  assert.match(codex, /```toml[^`]*default_tools_approval_mode = "approve"[^`]*```/, "Codex : le réglage d'approbation est DANS le bloc TOML");
  // Les reçus ont tourné sous des noms jetables : les noms de la page sont
  // des gabarits, et chaque section vérifiée le dit.
  // Claude Code : les appels ont tourné en plusieurs sessions, pas en une
  // séquence — sa phrase le dit, les quatre autres disent « the sequence ».
  for (const [nom, motif] of VERIFIES_LE_18_10.filter(([nom]) => nom !== "Claude Code")) {
    assert.ok(sectionDe(doc, motif).replace(/\s+/g, " ").includes("The sequence below ran on 2026-10-18 under other peer names (`preuve-*`); the names here are placeholders"), `${nom} : la provenance du smoke test est dite`);
  }
  const claude = sectionDe(doc, /^## [^\n]*Claude Code/m).replace(/\s+/g, " ");
  assert.ok(claude.includes("Each call below ran on 2026-10-18 under other peer names (`preuve-*`), in headless runs and in one interactive session, not as this one sequence"), "Claude Code : la provenance du smoke test, exacte");
  assert.ok(claude.includes("connects on 2.1.302, whose default is the 2026-07-28 negotiation"), "Claude Code : la négociation elle-même n'est pas dite observée");
  // P1 (e3) et R7 (e4) : deux sessions interactives, pas une.
  assert.ok(claude.includes("in headless `claude -p` sessions and in two interactive sessions"), "Claude Code : deux sessions interactives");
  // PREUVES/facteur-push-live.md : la poussée observée, avec sa nuance.
  for (const fait of ["observed the same day in the authors' house", "previous release's courier", "connection logic is unchanged in 1.0.0", "the 1.0.0 courier was verified against a stand-in socket"]) {
    assert.ok(claude.includes(fait), `Claude Code : la poussée du Facteur — ${fait}`);
  }
  // R7 (18/10/2026) : le moniteur a tenu 40 minutes ; au-delà, non testé.
  assert.ok(claude.includes("stayed armed for the whole 40-minute session"), "Claude Code : le moniteur au-delà de la deadline de 30 minutes");
  assert.ok(claude.includes("the plugin monitor beyond 40 minutes"), "Claude Code : « Not tested » dit la borne de 40 minutes");
  for (const perime of ["older than 30 minutes", "longer than two minutes"]) assert.ok(!claude.includes(perime), `Claude Code : « ${perime} » est périmé par R7`);
  assert.ok(codex.replace(/\s+/g, " ").includes("is said by `codex mcp add --help` to write an entry; not tested here"), "Codex : codex mcp add reste une affirmation de --help");
  const hermes = sectionDe(doc, /^## [^\n]*Hermes/m).replace(/\s+/g, " ");
  assert.ok(hermes.includes("An earlier live proof (25/08/2026) exists in the authors' records"), "Hermes : la preuve antérieure est datée");
  assert.ok(hermes.includes("was not re-verified for 1.0.0"), "Hermes : et elle n'est pas refaite pour 1.0.0");
});

test("le mot « Proven » n'apparaît jamais sans date", () => {
  const doc = lireLaDoc().replace(/\s+/g, " ");
  for (const m of doc.matchAll(/\b((?:[Nn]ot|[Nn]ever)\s+)?[Pp]roven\b/g)) {
    if (m[1]) continue;
    const suite = doc.slice(m.index, m.index + 60);
    assert.match(suite, /\b(\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4})\b/, `« ${suite} » — un Proven sans date`);
  }
});

// ── (m) les codes rendus aux clients viennent du code ───────────────────────
//
// Le README dit que les codes `refus` et `attente.motif` sont le contrat, et
// qu'ils sont documentés ici. OpenCode (18/10/2026) a reçu
// `destinataire-inconnu`, que la page ne nommait pas : la liste se lit donc
// dans src/, jamais dans la mémoire. `attenteDeLaLettre` (registry.js) et
// `trouverLaBoite` (round.js, rejoué par `avisDAttente` au moment du send)
// sont les deux seules sources d'un `attente.motif` ; `server.js` est la
// seule source d'un `refus` rendu par le guichet MCP.
function corpsDe(fichier, debut) {
  const source = fs.readFileSync(path.join(repo, fichier), "utf8");
  const i = source.indexOf(debut);
  assert.ok(i >= 0, `sonde impossible : ${debut} introuvable dans ${fichier}`);
  const j = source.indexOf("\nexport ", i + 1);
  return source.slice(i, j < 0 ? undefined : j);
}

function sousSectionDe(doc, titre) {
  const debut = doc.indexOf(`\n### ${titre}`);
  assert.ok(debut >= 0, `sous-section « ### ${titre} » introuvable`);
  const fin = doc.slice(debut + 4).search(/\n#{2,3} /);
  return fin < 0 ? doc.slice(debut) : doc.slice(debut, debut + 4 + fin);
}

const codesDeTable = (texte) => [...new Set([...texte.matchAll(/^\| `([a-z]+(?:-[a-z]+)+)` \|/gm)].map((m) => m[1]))].sort();

test("la doc liste EXACTEMENT les codes d'attente et de refus que le guichet rend", () => {
  const doc = lireLaDoc();
  const motifs = (texte) => [...texte.matchAll(/motif: "([a-z]+(?:-[a-z]+)+)"/g)].map((m) => m[1]);
  const attentes = [...new Set([
    ...motifs(corpsDe("src/lib/registry.js", "export function attenteDeLaLettre")),
    ...motifs(corpsDe("src/facteur/round.js", "export function trouverLaBoite"))
  ])].sort();
  assert.ok(attentes.length >= 6, `sonde impossible : ${attentes.length} code(s) d'attente lus dans src/`);
  assert.ok(attentes.includes("destinataire-inconnu"), "contrôle positif : le code vu par OpenCode est lu");
  const serveur = fs.readFileSync(path.join(repo, "src/mcp-server/server.js"), "utf8");
  const refus = [...new Set([...serveur.matchAll(/refus: "([a-z]+(?:-[a-z]+)+)"/g)].map((m) => m[1]))].sort();
  assert.ok(refus.length >= 6, `sonde impossible : ${refus.length} code(s) de refus lus dans server.js`);
  assert.deepEqual(codesDeTable(sousSectionDe(doc, "`attente.motif`")), attentes, "la table des codes d'attente et src/ divergent");
  assert.deepEqual(codesDeTable(sousSectionDe(doc, "`refus`")), refus, "la table des refus et server.js divergent");
  // `chaise-refusee` : les outils qui le rendent se lisent dans server.js —
  // ceux dont le gestionnaire appelle `refusDeChaise`.
  const outils = serveur.split("server.registerTool(").slice(1)
    .filter((bloc) => bloc.includes("refusDeChaise("))
    .map((bloc) => bloc.match(/^\s*"([a-z_]+)"/)[1]).sort();
  assert.ok(outils.length >= 4, `sonde impossible : ${outils.length} outil(s) rendent chaise-refusee`);
  const ligne = sousSectionDe(doc, "`refus`").split("\n").find((l) => l.startsWith("| `chaise-refusee` |"));
  const cites = [...ligne.split("|")[2].matchAll(/`([a-z_]+)`/g)].map((m) => m[1]).sort();
  assert.deepEqual(cites, outils, "chaise-refusee : la colonne des outils est celle de server.js");
});

// ── (n) LA VAGUE FINALE (18/10) : LA PAGE DIT CE QU'ELLE N'A PAS VU ET CE QUE LA VÉRIFICATION VAUT ──
//
// Trois sphères de la page étaient plus fortes que le code : « verified » se
// lisait comme une authentification alors que l'identité est l'environnement du
// processus ; le plugin « as linked by install » n'avait jamais été chargé dans
// une session ; et Codex avait changé de version au milieu de la vérification.
test("l'identité : « checked », jamais « verified » — et la page dit que ce n'est pas une authentification", () => {
  const doc = lireLaDoc().replace(/\s+/g, " ");
  assert.doesNotMatch(doc, /declared `self` is verified|is verified like a declared|is verified as for `send`|never trusts a name given in a tool call/, "plus de « verified » pour un nom que l'appelant contrôle");
  assert.ok(doc.includes("a declared `self` is checked for consistency with the identity it **derives** from its own process environment"), "la vérification est une cohérence avec le nom dérivé");
  assert.ok(
    doc.includes("These checks are not authentication: both names belong to whoever runs the session (SECURITY.md, \"Threat model\")."),
    "la page dit que ce n'est pas une authentification"
  );
  // SECURITY.md porte le détail : le processus du compte, les fiches sans chaise.
  assert.ok(plat(read("SECURITY.md")).includes("any peer card without a chair"), "SECURITY.md porte la même phrase");
  // J1 : un nom accepté part sous le nom dérivé, sauf la lignée d'une chaise ; la page le dit.
  assert.ok(
    doc.includes("An accepted name goes out as the derived name, except a chair's own lineage name, which is kept as written."),
    "la page dit sous quel nom part la lettre d'un `from` accepté"
  );
  // Sans nom posé, plusieurs sessions partagent un NOM (les chaises séparent les boîtes).
  assert.ok(doc.includes("Every client on the machine that sets nothing shares that one name."), "un seul nom, pas « une seule boîte »");
  assert.doesNotMatch(doc, /that one inbox/, "la formule « une seule boîte » est partie");
  // Le dossier : les hooks reprennent la fiche la plus récente (oracle : test/surfaces.test.js, A1).
  assert.ok(
    sectionDe(lireLaDoc(), /^## [^\n]*Claude Code/m).replace(/\s+/g, " ").includes("the hooks may take the name of the most recent card registered for the same directory"),
    "Claude Code : le repli des hooks sur le dossier est dit"
  );
});

function plat(texte) {
  return texte.replace(/\s+/g, " ");
}
function read(relatif) {
  return fs.readFileSync(path.join(repo, relatif), "utf8");
}

test("Claude Code : le lien `skills-dir` et `claude plugin enable` ne sont pas dits vus de bout en bout, et le plugin lié par install n'a pas été chargé", () => {
  const claude = plat(sectionDe(lireLaDoc(), /^## [^\n]*Claude Code/m));
  assert.ok(
    claude.includes("The `skills-dir` link written by `valxos-messenger install` and `claude plugin enable valxos-messenger@skills-dir` were not exercised end to end in a Claude Code session in this release; the plugin was verified from the same tree with `--plugin-dir`."),
    "Claude Code : la phrase de l'inconnu (F7)"
  );
  assert.ok(
    claude.includes("Not tested: the plugin as linked by `valxos-messenger install`, which was not loaded in a Claude Code session;"),
    "Claude Code : « Not tested » dit que le plugin lié n'a pas été chargé dans une session"
  );
});

test("Codex : le reçu MCP du 2026-10-18 reste borné à 0.162.1 ; la sonnette est vérifiée sur 0.163.0 (2026-10-21, puis 2026-10-22 en direct)", () => {
  const codex = plat(sectionDe(lireLaDoc(), /^## [^\n]*Codex/m));
  assert.ok(
    codex.includes("Not tested: the MCP round trip of this section on codex-cli 0.163.0 (the 2026-10-18 verification ran on 0.162.1, which updated itself during that run;"),
    "Codex : la portée du reçu MCP du 18/10 reste bornée à 0.162.1"
  );
  assert.ok(codex.includes("Seen earlier on macOS on 2026-10-21 with codex-cli 0.163.0"), "Codex : ce que la sonde du 21/10 a vu porte sa date et sa version");
  assert.ok(codex.includes("**Verified on macOS on 2026-10-22 with codex-cli 0.163.0**"), "Codex : la marche du 22/10 porte sa date et sa version");
  // Comme la section agy le fait pour 1.4.2.
  assert.ok(plat(sectionDe(lireLaDoc(), /^## [^\n]*Antigravity/m)).includes("Not tested: agy 1.4.2;"), "agy : le précédent");
});

// 1.1.0 — LA SONNETTE CODEX : la sous-section dit ce qui est livré, ce qui a été
// vu le 2026-10-22 (le hook livré, la porte et l'installeur dans un TUI vivant sur
// une maison jetable) et le 2026-10-21, ce qui ne l'a pas été (une maison
// ordinaire, les hooks dans l'app de bureau, l'approbation `/hooks` des hooks que
// l'installeur écrit, l'ouverture d'une app fermée), et chaque fait a son oracle dans l'arbre : le hook et
// son gabarit, la porte du Facteur, l'enveloppe, l'installeur qui tourne (un
// dry-run dans un HOME et un CODEX_HOME jetables). `sonnette-codex-impossible`
// y est une raison de TOURNÉE, jamais un `attente.motif`.
test("Codex : la sous-section « hooks and the doorbell » — les trois pièces, l'enveloppe sans corps, Échap, le clone au démarrage, le smoke test", async () => {
  const doc = lireLaDoc();
  const debut = doc.indexOf("\n### Codex: hooks and the doorbell");
  assert.ok(debut >= 0, "la sous-section existe");
  assert.ok(debut > doc.search(/^## [^\n]*Codex/m) && debut < doc.search(/^## [^\n]*Gemini/m), "elle vit dans la section Codex, avant Gemini");
  const sonnette = plat(doc.slice(debut, doc.indexOf("\n## ", debut + 4)));
  // Revue de la Tâche 12, finding 4, puis la marche du 22/10/2026 sur un Codex jetable : le hook
  // livré, la porte et la sortie de l'installeur ont tourné en direct, une fois, sur une maison
  // jetable. Le statut est le premier des deux, daté, avec ses conditions et ce qui n'a pas été vu.
  assert.ok(sonnette.trimStart().startsWith("### Codex: hooks and the doorbell **Verified on macOS on 2026-10-22 with codex-cli 0.163.0**"), "le statut de la sous-section : vu en direct le 22/10/2026");
  assert.ok(!sonnette.includes("Not yet seen live"), "le troisième statut n'existe plus");
  assert.match(sonnette, /Not tested: a regular Codex home/, "la sous-section dit ce qui n'a pas été vu");
  assert.ok(!sonnette.includes("and its children"), "le couperet ne promet pas tous les descendants (finding 3)");
  for (const fait of [
    "`src/hooks/codex/codex-hook.js`", "`scripts/codex/hooks.template.json`", "`src/facteur/porte-codex.js`", "`src/lib/sonnette.js`",
    "`[features] hooks = true`", "`--serves <name>`", "`VALXOS_SELF`", "`[mcp_servers.valxos_messenger]`",
    "`<office>/codex/<lineage>.json`", "`0600`",
    "`codex queue --thread <thread_id> --message <envelope>`", "`CODEX_HOME`", "5 s",
    "`open codex://threads/<uuid>`", "`lsappinfo find bundleid=com.openai.codex`", "`VALXOS_CODEX_PORTE=cli`", "`VALXOS_CODEX_OUVRIR_APP=0`",
    "`tournee.reason`", "`sonnette-codex-impossible`", "`sonnette-codex-differee`", "`codex-fil-sans-session`",
    "no body ever enters it", "cut at 60 characters",
    "`valxos-messenger install --codex --self your-agent-name", "`--write`", "`--porte app|cli`", "`--codex-home <path>`", "`/hooks`", "`--dangerously-bypass-hook-trust`",
    "`github.com/openai/plugins`", "`$CODEX_HOME/.tmp/plugins`", "`no rollout found`",
    "`VALXOS_GARDE_BUREAU=1`", "the installer never writes the guard",
    "`codex --version`", "`tmp/arg0-macos`", "`valxos-doctor --reap`", "24 h",
    "after **Escape** in the TUI the queue freezes",
    "kills its process group after 5 s (a grandchild that left the group, with `setsid`, survives)",
    "(`no rollout found`; during that first turn, not measured)",
    "`proc_start`", "`cwd`", "`dead_at`", "`CC2CC_SELF`",
    "the hooks serve a rung letter at once",
    "a letter the queue took is never rung again",
    "Not tested:", "`test/codex-hook.test.js`", "`test/porte-codex.test.js`",
    "the hooks in the desktop app", "the `/hooks` approval of the hooks the installer writes",
    "### Smoke test (Codex doorbell)"
  ]) assert.ok(sonnette.includes(fait), `Codex, la sonnette : ${fait}`);
  assert.doesNotMatch(sonnette, /attente\.motif: "sonnette-codex-impossible"/, "la raison de tournée n'est jamais un attente.motif");
  // Les oracles.
  const { argumentsDeSonnette, lienDuFil, MOTIF_SONNETTE_IMPOSSIBLE, MOTIF_SONNETTE_DIFFEREE, BUNDLE_APP_CODEX } = await import("../src/facteur/porte-codex-regles.js");
  assert.deepEqual(argumentsDeSonnette({ thread_id: "t" }, "e"), ["queue", "--thread", "t", "--message", "e"], "la sonnette est codex queue --thread --message");
  assert.equal(lienDuFil("u"), "codex://threads/u", "la porte ouvre l'app sur le fil");
  assert.deepEqual([MOTIF_SONNETTE_IMPOSSIBLE, MOTIF_SONNETTE_DIFFEREE, BUNDLE_APP_CODEX], ["sonnette-codex-impossible", "sonnette-codex-differee", "com.openai.codex"], "les raisons et l'app viennent du code");
  assert.ok(read("src/facteur/porte-codex.js").includes('"codex-fil-sans-session"'), "le détail vient du code");
  assert.match(read("src/facteur/porte-codex.js"), /process\.kill\(-/, "le couperet tue le groupe de l'enfant");
  const { GRACE_APRES_SONNETTE_MS } = await import("../src/hooks/codex/harness-common.js");
  assert.equal(GRACE_APRES_SONNETTE_MS, 0, "le hook Codex sert une lettre sonnée sans grâce");
  const gabarit = JSON.parse(read("scripts/codex/hooks.template.json"));
  for (const [evenement, delai] of [["SessionStart", 10], ["UserPromptSubmit", 5], ["PostToolUse", 5], ["Stop", 5]]) {
    const [groupe] = gabarit.hooks[evenement];
    assert.equal(groupe.hooks[0].timeout, delai, `le gabarit déclare ${evenement}, ${delai} s`);
    assert.match(groupe.hooks[0].command, /^env VALXOS_SELF=__SELF__ VALXOS_MESSENGER_HOME=__BUREAU__ __PORTE__ __NODE__ __PAQUET__\/src\/hooks\/codex\/codex-hook\.js --serves __SELF__$/, `${evenement} : l'identité et le bureau en ligne, --serves`);
  }
  assert.ok(sonnette.includes("10 s for `SessionStart`, 5 s for the three others"), "la doc dit les délais du gabarit");
  const { enveloppeDeSonnette } = await import("../src/lib/sonnette.js");
  const exemple = enveloppeDeSonnette([{ sender: "alice", affichage: { chaise_nom: "atelier" }, table_nom: "team-test", subject: "Beat 7", priority: "normal", body: "BODY" }], { destinataire: "your-agent-name", autresNonLues: 2 });
  assert.ok(sonnette.includes(exemple), `l'enveloppe d'exemple est celle que le code écrit : ${exemple}`);
  // L'installeur qui tourne écrit ce que la doc dit : un dry-run ne touche à rien.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-doc-codex-"));
  try {
    const codexHome = path.join(home, "codex-home");
    fs.mkdirSync(codexHome);
    const sortie = spawnSync(process.execPath, [path.join(repo, "scripts/install.js"), "--codex", "--self", "your-agent-name", "--codex-home", codexHome], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: home, VALXOS_MESSENGER_HOME: path.join(home, "office"), CC2CC_GARDE_BUREAU: "1" }
    });
    assert.equal(sortie.status, 0, sortie.stderr);
    assert.match(sortie.stdout, /\[mcp_servers\.valxos_messenger\]/, "la clef MCP que la doc écrit est celle de l'installeur");
    assert.match(sortie.stdout, /default_tools_approval_mode = "approve"/, "et le réglage d'approbation");
    assert.doesNotMatch(sortie.stdout, /GARDE_BUREAU/, "l'installeur n'écrit jamais la garde");
    assert.deepEqual(fs.readdirSync(codexHome), [], "le dry-run n'a rien écrit");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// 1.1.0 — TREIZE OUTILS, ET LA FORME DE `envoi_status` : la phrase d'ouverture
// compte ce que le serveur enregistre, et la ligne d'`envoi_status` nomme
// `tournee` que le serveur rend.
test("la page compte les outils comme le serveur les enregistre, et `envoi_status` dit `tournee`", () => {
  const serveur = read("src/mcp-server/server.js");
  const enregistres = [...serveur.matchAll(/server\.registerTool\(\s*"([a-z_]+)"/g)].length;
  const MOTS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen"];
  const doc = plat(lireLaDoc());
  assert.ok(doc.includes(`gets the same ${MOTS[enregistres]} tools`), `la page dit ${MOTS[enregistres]} outils`);
  assert.doesNotMatch(doc, /the same nine tools/, "plus de « nine tools » au présent");
  assert.match(serveur, /tournee: tourneeDe\(row\.msg_id\)/, "sonde : envoi_status rend tournee");
  const ligne = lireLaDoc().split("\n").find((l) => l.startsWith("| `envoi_status` |"));
  assert.ok(ligne && ligne.includes("`tournee`") && ligne.includes("`{ state, reason, at }`"), "la ligne d'envoi_status dit tournee et sa forme");
});

// LE CONTRAT DES CHAISES HERMES (1.1.0, Tâche 2) : écrit, pas codé. Pas de
// fiche ; la ligne du registre porte tout — `house` = le chemin absolu de
// HERMES_HOME, `metadata_json.harnais = "hermes"` — la clef que la chaise
// Codex porte déjà et que `porteDeLaChaise` lit (registry.js), jamais une
// clef `door` de plus. La porte Hermes du Facteur vient avec la 1.2.0 : la
// page ne la promet pas pour celle-ci. Les colonnes et la clef citées sont
// celles du code, lues dans le code.
test("Hermes : le contrat de la chaise au registre est écrit — pas de fiche, `house` = HERMES_HOME, `metadata_json.harnais` = hermes, la porte en 1.2.0", () => {
  const hermes = plat(sectionDe(lireLaDoc(), /^## [^\n]*Hermes/m));
  for (const fait of [
    "### A Hermes chair in the registry (contract; the Facteur's door comes later)",
    "**No card file.**",
    "**`house`** is the absolute path of the chair's `HERMES_HOME`",
    "**`metadata_json.harnais`** is `\"hermes\"`: the key a Codex chair's row already carries (with `\"codex\"`)",
    "The Facteur's Hermes door (ringing a Hermes chair through its lineage's socket) is not in this release; it is planned for 1.2.0.",
    "the chair collects it with `inbox` or `valxos-inbox`"
  ]) assert.ok(hermes.includes(fait), `Hermes : ${fait}`);
  const schema = read("src/lib/database.js");
  assert.match(schema, /\bmetadata_json TEXT\b/, "sonde : la colonne metadata_json existe au registre");
  assert.ok(!hermes.includes("metadata_json.door"), "Hermes : le contrat ne nomme pas une clef `door` que le code ne lit pas");
  const registre = read("src/lib/registry.js");
  assert.match(registre, /\bid, lineage, house, instance_session_id\b/, "sonde : la colonne house existe au registre");
  assert.match(registre, /meta\.harnais !== "codex"/, "sonde : porteDeLaChaise lit la clef `harnais`, celle que le contrat nomme");
  for (const source of ["src/lib/registry.js", "src/facteur/round.js"]) {
    assert.doesNotMatch(read(source), /["']hermes["']/, `${source} : la porte Hermes n'est pas codée dans cette release (la page dit 1.2.0)`);
  }
});

test("Hermes : la CLI sait accuser, la page le montre — `valxos-inbox --ack <msg_id>`", () => {
  const hermes = sectionDe(lireLaDoc(), /^## [^\n]*Hermes/m);
  assert.match(hermes, /VALXOS_SELF=your-agent-name valxos-inbox --ack <msg_id>/, "Hermes : le repli CLI accuse aussi");
  assert.match(plat(hermes), /A Hermes skill wrapping those commands is enough/, "Hermes : la skill emballe les trois gestes");
});
