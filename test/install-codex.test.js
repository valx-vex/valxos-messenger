// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// L'INSTALLEUR CODEX (1.1.0, Tâche 11, spec B §5) — `install --codex`.
//
// Ce que le mode pose dans une maison Codex : `[features] hooks = true` et le
// serveur MCP `[mcp_servers.valxos_messenger]` dans config.toml, les quatre
// hooks dans hooks.json (gabarit scripts/codex/hooks.template.json), avec
// l'identité, le bureau, la porte et le node ABSOLU dans la commande même du
// hook : l'app de bureau n'a ni lanceur qui les exporterait, ni le PATH du
// shell. Sans --write : les trois morceaux et le plan, rien ne bouge. Avec
// --write : une sauvegarde datée de chaque fichier changé, un diff, et jamais
// une valeur changée sur place — un conflit, et rien n'est écrit.
//
// D'abord le module de décision (scripts/codex/codex-setup.js) en unité,
// puis l'installeur en sous-processus, dans un HOME jetable
// (test/aide-installeur.js) dont un dossier tient lieu de maison Codex —
// jamais ~/.codex.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as codex from "../scripts/codex/codex-setup.js";
import { arbre, environnement, fauxHome, lancer, rapport, repo } from "./aide-installeur.js";

const SELF = "hal-test";
// Sans --porte, la commande ne pose AUCUNE porte (round 1, constat 2) : chaque
// session dit la sienne par son environnement (`VALXOS_CODEX_PORTE`), et le hook
// lit une porte absente comme `app`.
const VALEURS = { packageRoot: "/opt/paquet", self: SELF, office: "/tmp/office-test/bureau", node: "/opt/node/bin/node", porte: null };
const COMMANDE = "env VALXOS_SELF=hal-test VALXOS_MESSENGER_HOME=/tmp/office-test/bureau /opt/node/bin/node /opt/paquet/src/hooks/codex/codex-hook.js --serves hal-test";
const groupe = (timeout) => [{ hooks: [{ type: "command", command: COMMANDE, timeout }] }];
const HOOKS_ATTENDUS = { hooks: { SessionStart: groupe(10), UserPromptSubmit: groupe(5), PostToolUse: groupe(5), Stop: groupe(5) } };
const BLOC_MCP = [
  "[mcp_servers.valxos_messenger]",
  'command = "/opt/node/bin/node"',
  'args = ["/opt/paquet/src/mcp-server/server.js"]',
  'default_tools_approval_mode = "approve"',
  "",
  "[mcp_servers.valxos_messenger.env]",
  'VALXOS_SELF = "hal-test"',
  'VALXOS_MESSENGER_HOME = "/tmp/office-test/bureau"'
].join("\n");
const gabarit = () => fs.readFileSync(codex.hooksTemplatePath(), "utf8");

test("shellQuote garde nu un chemin simple et cite le reste ; tomlString écrit une chaîne TOML", () => {
  assert.equal(codex.shellQuote("/opt/paquet"), "/opt/paquet");
  assert.equal(codex.shellQuote("hal-test"), "hal-test");
  assert.equal(codex.shellQuote("/tmp/with space/it's"), "'/tmp/with space/it'\\''s'");
  assert.equal(codex.shellQuote(""), "''");
  assert.equal(codex.tomlString('a "b" \\ c'), '"a \\"b\\" \\\\ c"');
  assert.equal(codex.tomlString("del\u007f"), '"del\\u007F"', "TOML refuse un DEL brut, JSON le laisse passer");
});

test("renderHooks : le gabarit rendu porte les quatre événements, les délais 10/5/5/5, l'identité, la porte, le node absolu et --serves", () => {
  const rendu = codex.renderHooks(gabarit(), VALEURS);
  assert.deepEqual(rendu, HOOKS_ATTENDUS);
  assert.deepEqual(Object.keys(rendu.hooks), codex.CODEX_EVENTS);
  assert.ok(COMMANDE.includes(codex.HOOK_MARKER), "la marque qui reconnaît notre hook est dans la commande");
  assert.doesNotMatch(JSON.stringify(rendu), /__[A-Z]+__|GARDE_BUREAU/, "aucun marqueur ne reste, et la garde des suites n'y entre jamais");
  assert.doesNotMatch(COMMANDE, / node /, "jamais un node nu : l'app de bureau n'a pas le PATH du shell");
  assert.doesNotMatch(COMMANDE, /VALXOS_CODEX_PORTE/, "sans --porte, la porte reste celle de la session");
  const epinglee = codex.renderHooks(gabarit(), { ...VALEURS, porte: "cli" }).hooks.Stop[0].hooks[0].command;
  assert.equal(epinglee, COMMANDE.replace("/tmp/office-test/bureau ", "/tmp/office-test/bureau VALXOS_CODEX_PORTE=cli "), "--porte l'épingle, à sa place");
  assert.throws(() => codex.renderHooks(gabarit(), { ...VALEURS, porte: "exec" }), /door "exec" is not one an install pins/);
});

test("renderHooks : un chemin avec une espace reste un seul mot du shell ; un gabarit sans un événement, avec un marqueur inconnu ou une valeur vide est refusé", () => {
  const valeurs = { packageRoot: "/opt/mon paquet", self: SELF, office: "/tmp/office test/it's", node: "/opt/mon node/node", porte: "cli" };
  const rendu = codex.renderHooks(gabarit(), valeurs);
  assert.equal(
    rendu.hooks.Stop[0].hooks[0].command,
    "env VALXOS_SELF=hal-test VALXOS_MESSENGER_HOME='/tmp/office test/it'\\''s' VALXOS_CODEX_PORTE=cli '/opt/mon node/node' '/opt/mon paquet'/src/hooks/codex/codex-hook.js --serves hal-test"
  );
  const mot = spawnSync("/bin/sh", ["-c", `printf '%s|' ${codex.shellQuote("/tmp/office test/it's")}`], { encoding: "utf8" });
  assert.equal(mot.stdout, "/tmp/office test/it's|", "le shell y lit UN mot, intact");
  const sansStop = JSON.parse(gabarit());
  delete sansStop.hooks.Stop;
  assert.throws(() => codex.renderHooks(JSON.stringify(sansStop), VALEURS), /expected the events/);
  const inconnu = JSON.parse(gabarit());
  inconnu.hooks.Stop[0].hooks[0].command += " __AUTRE__";
  assert.throws(() => codex.renderHooks(JSON.stringify(inconnu), VALEURS), /unknown placeholder __AUTRE__/);
  assert.throws(() => codex.renderHooks(gabarit(), { ...VALEURS, node: "" }), /no value for __NODE__/);
});

test("la commande rendue, passée au shell comme Codex la passe : env pose l'identité et le bureau, garde la porte de la session (sauf --porte), puis lance CE node avec le hook et --serves", (t) => {
  const dossier = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "valxos-codex-cmd-")));
  t.after(() => fs.rmSync(dossier, { recursive: true, force: true }));
  const faux = path.join(dossier, "faux node");
  fs.writeFileSync(faux, '#!/bin/sh\nprintf "%s|%s|%s|%s|%s|%s\\n" "$VALXOS_SELF" "$VALXOS_MESSENGER_HOME" "$VALXOS_CODEX_PORTE" "$1" "$2" "$3"\n', { mode: 0o755 });
  const valeurs = { packageRoot: path.join(dossier, "mon paquet"), self: SELF, office: path.join(dossier, "it's office"), node: faux, porte: null };
  const lancer = (porte, envDeLaSession) => {
    const commande = codex.renderHooks(gabarit(), { ...valeurs, porte }).hooks.SessionStart[0].hooks[0].command;
    const sortie = spawnSync("/bin/sh", ["-c", commande], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", ...envDeLaSession } });
    assert.equal(sortie.status, 0, sortie.stderr);
    return sortie.stdout;
  };
  const suite = `${path.join(valeurs.packageRoot, codex.HOOK_MARKER)}|--serves|hal-test\n`;
  assert.equal(lancer(null, {}), `hal-test|${valeurs.office}||${suite}`, "sans porte nulle part : le hook lira app");
  assert.equal(lancer(null, { VALXOS_CODEX_PORTE: "cli" }), `hal-test|${valeurs.office}|cli|${suite}`, "le lanceur du terminal garde SA porte");
  assert.equal(lancer("app", { VALXOS_CODEX_PORTE: "cli" }), `hal-test|${valeurs.office}|app|${suite}`, "--porte épinglée gagne, par choix explicite");
});

test("mcpServerBlock : la clef de la doc 1.0.0, le node absolu, l'approbation, l'identité et le bureau — jamais la garde", () => {
  assert.equal(codex.MCP_SERVER_KEY, "valxos_messenger");
  assert.equal(codex.mcpServerBlock(VALEURS), BLOC_MCP);
  assert.doesNotMatch(codex.mcpServerBlock(VALEURS), /GARDE_BUREAU/);
  assert.equal(codex.FEATURES_BLOCK, "[features]\nhooks = true");
  assert.equal(codex.HOOK_MARKER, "src/hooks/codex/codex-hook.js");
  assert.deepEqual(codex.CODEX_EVENTS, ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"]);
});

// ── config.toml : la découpe, puis le plan de fusion ───────────────────────

const DOC_100 = [
  "[mcp_servers.valxos_messenger]",
  'command = "/opt/homebrew/bin/node"',
  'args = ["/opt/paquet/src/mcp-server/server.js"]',
  "",
  "[mcp_servers.valxos_messenger.env]",
  'VALXOS_SELF = "hal-test"',
  ""
].join("\n");

test("splitToml : la découpe se recompose à l'octet, et une ligne [x] dans une chaîne ou un tableau sur plusieurs lignes n'est pas un en-tête", () => {
  const texte = [
    'model = "o4-mini"',
    'instructions = """',
    "[features]",
    "hooks = false",
    '"""',
    "args = [",
    '  "a",',
    '["b"]',
    "]",
    "",
    '[ mcp_servers . "valxos_messenger" ]',
    'command = "node" # le node du PATH',
    "[[profiles]]",
    'name = "x"',
    ""
  ].join("\n");
  const sections = codex.splitToml(texte);
  assert.equal(sections.flatMap((s) => s.lines).join("\n"), texte, "rien n'est perdu ni réécrit");
  assert.deepEqual(sections.map((s) => [s.name, s.array]), [[null, false], ["mcp_servers.valxos_messenger", false], ["profiles", true]]);
});

test("planCodexConfig : un config.toml vide reçoit les deux tables, dans l'ordre des morceaux", () => {
  const plan = codex.planCodexConfig("", VALEURS);
  assert.equal(plan.text, `${codex.FEATURES_BLOCK}\n\n${BLOC_MCP}\n`);
  assert.deepEqual([plan.features.status, plan.mcp.status, plan.conflicts], ["write", "write", []]);
});

test("planCodexConfig : les autres tables restent à l'octet — un autre serveur, [hooks.state], les commentaires ; tout s'ajoute à la fin", () => {
  const avant = [
    "# ma config",
    'model = "o4-mini"',
    "",
    "[mcp_servers.cc2cc]",
    'command = "node"',
    'args = ["/ancien/src/mcp-server/server.js"]',
    "",
    '[hooks.state."/tmp/office-test/codex/hooks.json:stop:0:0"]',
    'trusted_hash = "sha256:00"',
    ""
  ].join("\n");
  const plan = codex.planCodexConfig(avant, VALEURS);
  assert.equal(plan.text, `${avant}\n${codex.FEATURES_BLOCK}\n\n${BLOC_MCP}\n`, "l'ancien fichier est un préfixe du nouveau");
  const sansFinDeLigne = codex.planCodexConfig('model = "o4-mini"', VALEURS);
  assert.ok(sansFinDeLigne.text.startsWith('model = "o4-mini"\n\n[features]\n'), sansFinDeLigne.text);
  const autreServeurPointe = codex.planCodexConfig('mcp_servers.autre.command = "x"\n', VALEURS);
  assert.equal(autreServeurPointe.mcp.status, "write", "un AUTRE serveur en clef pointée n'empêche pas d'ajouter le nôtre");
});

test("[features] : la clef manquante s'ajoute dans la table ; true ne bouge pas ; false ou une forme pointée est un conflit nommé", () => {
  const ajout = codex.planCodexConfig("[features]\nweb_search = true\n", VALEURS);
  assert.equal(ajout.text, `[features]\nweb_search = true\nhooks = true\n\n${BLOC_MCP}\n`);
  assert.deepEqual(ajout.features, { status: "update", added: ["features.hooks"] });
  assert.equal(codex.planCodexConfig("[features]\nhooks = true # on\n", VALEURS).features.status, "unchanged");
  const faux = codex.planCodexConfig("[features]\nhooks = false\n", VALEURS);
  assert.equal(faux.features.status, "conflict");
  assert.match(faux.conflicts[0], /\[features\] hooks = false/);
  assert.equal(codex.planCodexConfig("features.hooks = true\n", VALEURS).features.status, "conflict");
  assert.equal(
    codex.planCodexConfig('instructions = """\n[features]\nhooks = false\n"""\n', VALEURS).features.status,
    "write",
    "une table écrite dans une chaîne n'en est pas une"
  );
});

test("le serveur MCP : identique, rien ne bouge ; la forme de la doc 1.0.0 reçoit ses clefs manquantes ; une autre identité ou un autre paquet est un conflit ; l'alias historique compte", () => {
  const plein = codex.planCodexConfig("", VALEURS).text;
  const meme = codex.planCodexConfig(plein, VALEURS);
  assert.deepEqual([meme.text, meme.features.status, meme.mcp.status], [plein, "unchanged", "unchanged"]);

  const complete = codex.planCodexConfig(DOC_100, VALEURS);
  assert.equal(complete.text, [
    "[mcp_servers.valxos_messenger]",
    'command = "/opt/homebrew/bin/node"',
    'args = ["/opt/paquet/src/mcp-server/server.js"]',
    'default_tools_approval_mode = "approve"',
    "",
    "[mcp_servers.valxos_messenger.env]",
    'VALXOS_SELF = "hal-test"',
    'VALXOS_MESSENGER_HOME = "/tmp/office-test/bureau"',
    "",
    codex.FEATURES_BLOCK,
    ""
  ].join("\n"), "le node de l'utilisateur reste ; ce qui manque s'ajoute dans SA table");
  assert.deepEqual(complete.mcp, {
    status: "update",
    added: ["mcp_servers.valxos_messenger.default_tools_approval_mode", "mcp_servers.valxos_messenger.env.VALXOS_MESSENGER_HOME"]
  });

  const autre = codex.planCodexConfig(plein.replace('VALXOS_SELF = "hal-test"', 'VALXOS_SELF = "bob"'), VALEURS);
  assert.equal(autre.mcp.status, "conflict");
  assert.match(autre.conflicts.join("\n"), /VALXOS_SELF is "bob", this install writes "hal-test"/);
  const ailleurs = codex.planCodexConfig(plein.replace("/opt/paquet/src", "/ancien/src"), VALEURS);
  assert.match(ailleurs.conflicts.join("\n"), /args is \["\/ancien\/src\/mcp-server\/server\.js"\]/);
  const historique = codex.planCodexConfig(plein.replace('VALXOS_SELF = "hal-test"', 'CC2CC_SELF = "hal-test"'), VALEURS);
  assert.deepEqual([historique.mcp.status, historique.text.includes("VALXOS_SELF")], ["unchanged", false], "la clef historique compte : rien ne s'ajoute par-dessus");
  assert.equal(codex.planCodexConfig(plein.replace('VALXOS_SELF = "hal-test"', 'CC2CC_SELF = "bob"'), VALEURS).mcp.status, "conflict");
  assert.equal(codex.planCodexConfig('[mcp_servers]\nvalxos_messenger = { command = "node" }\n', VALEURS).mcp.status, "conflict");
  assert.equal(codex.planCodexConfig('[mcp_servers.valxos_messenger]\nenv = { VALXOS_SELF = "hal-test" }\n', VALEURS).mcp.status, "conflict");
  assert.equal(codex.planCodexConfig('mcp_servers.valxos_messenger.command = "node"\n', VALEURS).mcp.status, "conflict");
});

test("planCodexConfig est idempotent : le plan d'un plan ne change plus rien", () => {
  for (const depart of ["", "[features]\nweb_search = true\n", 'model = "o4-mini"', DOC_100]) {
    const une = codex.planCodexConfig(depart, VALEURS);
    const deux = codex.planCodexConfig(une.text, VALEURS);
    assert.deepEqual([deux.text, deux.features.status, deux.mcp.status, deux.conflicts], [une.text, "unchanged", "unchanged", []], JSON.stringify(depart));
  }
});

test("tomlProblem (round 1) : un fichier qui finit dans une chaîne ou un tableau sur plusieurs lignes ne se complète pas — nos tables y tomberaient", () => {
  assert.equal(codex.tomlProblem('model = "o4-mini"\n[features]\nhooks = true\n'), null);
  assert.equal(codex.tomlProblem('x = """\n[features]\n"""\n'), null);
  assert.match(String(codex.tomlProblem('instructions = """\nsans fin\n')), /ends inside a multi-line string/);
  assert.match(String(codex.tomlProblem("args = [\n  \"a\",\n")), /ends inside an array/);
});

// A1 (passe adverse, bloquant) : `tomlProblem` ne regardait que les chaînes et les
// tableaux non fermés — `this is not toml` passait, et `--write` le sauvegardait
// puis le réécrivait. Le fichier ENTIER se valide maintenant (TOML 1.0) ; ce que
// l'installeur ne sait pas valider se refuse.
test("A1 — tomlProblem valide le fichier entier : une ligne qui n'est pas du TOML, une clef en double, une table définie deux fois sont refusées, avec la ligne et la colonne", () => {
  const refuse = [
    ["this is not toml", /not valid TOML.*line 1, column 6.*"="/],
    ['model = "o4-mini"\nthis is not toml\n', /line 2, column 6/],
    ['model = "a"\nmodel = "b"\n', /line 2.*defined twice/],
    ["[features]\nhooks = true\n[features]\n", /line 3.*defined twice/],
    ['[mcp_servers.x]\ncommand = "a"\n[mcp_servers.x]\n', /line 3/],
    ["a = 1\n[a]\n", /line 2/],
    ["a = [1]\n[[a]]\n", /line 2/],
    ["x = { a = 1 }\n[x.b]\n", /line 2/],
    ["x = { a = 1 }\nx.b = 2\n", /line 2/],
    ['[a.b]\nc = 1\n[a]\nb.d = 2\n', /line 4/],
    ['[fruit]\napple.color = "red"\n[fruit.apple]\n', /line 3/],
    ["x = \n", /line 1.*value/],
    ["= 1\n", /line 1, column 1/],
    ['x = "sans fin\n', /line 1/],
    ['x = "a" "b"\n', /line 1/],
    ['x = "\\q"\n', /line 1.*escape/],
    ["x = 01\n", /line 1/],
    ["x = 1__0\n", /line 1/],
    ["x = 1.\n", /line 1/],
    ["x = .5\n", /line 1/],
    ["x = 9223372036854775808\n", /line 1/],
    ["x = 2026-13-01\n", /line 1/],
    ["x = 2026-02-30\n", /line 1/],
    ["x = 07:32\n", /line 1/],
    ["x = TRUE\n", /line 1/],
    ["x = [1 2]\n", /line 1/],
    ["x = { a = 1, }\n", /line 1/],
    ["x = { a = 1\n}\n", /line 1/],
    ["[a\n", /a \[ never closed/],
    ["[a] b\n", /line 1, column 5/],
    ["[[a]\n", /a \[ never closed/],
    ["[[a] ]\n", /line 1, column 4.*"\]\]"/],
    ["a = 1 # \u0001\n", /line 1.*control/],
    ["a = 1\rb = 2\n", /line 1/],
    ['instructions = """\nsans fin\n', /ends inside a multi-line string/],
    // S13 (troisième passe adverse) : TOML 1.0 est de l'UTF-8 SANS marque d'ordre ; tomllib la refuse.
    ["\uFEFFmodel = \"o4-mini\"\n", /line 1, column 1.*remove the UTF-8 byte-order mark/]
  ];
  for (const [texte, motif] of refuse) {
    assert.match(String(codex.tomlProblem(texte)), motif, JSON.stringify(texte));
  }
  // Ce qu'un config.toml de Codex porte vraiment reste accepté : rien de valide n'est refusé.
  const accepte = [
    "",
    "# rien que des commentaires\n\n",
    'model = "o4-mini"\r\nmodel_provider = "ollama"\r\n',
    [
      'model = "gpt-5"',
      "model_reasoning_effort = 'high'",
      "approval_policy = \"never\"  # inline comment",
      'notify = ["/usr/local/bin/notify", "--flag"]',
      "",
      "[features]",
      "hooks = true",
      "web_search = false",
      "",
      "[mcp_servers.autre]",
      'command = "npx"',
      "args = [",
      '  "-y", # first',
      "  'pkg@1.2.3',",
      "]",
      'env = { TOKEN_FILE = "/x", "QUOTED KEY" = "y" }',
      "startup_timeout_sec = 20",
      "tool_timeout_sec = 60.5",
      "",
      '[projects."/srv/projets/demo"]',
      'trust_level = "trusted"',
      "",
      '[hooks.state."/tmp/office-test/codex/hooks.json:stop:0:0"]',
      'trusted_hash = "sha256:00"',
      "",
      "[profiles.fast]",
      'model = "o4-mini"',
      "",
      "[[skills]]",
      'name = "a"',
      "[[skills]]",
      'name = "b"',
      "[skills.meta]",
      "x = 1",
      "",
      "[shell_environment_policy]",
      'inherit = "core"',
      "exclude = []",
      "set = {}",
      ""
    ].join("\n"),
    'x = """\n[features]\n"""\n',
    'x = """\\\n   a \\\n  b"""\ny = \'\'\'\nraw \\ "q" \'\'\'\nz = """a""b"""""\n',
    "a.b.c = 1\na.b.d = 2\n[a.e]\n",
    '[fruit]\napple.color = "red"\napple.taste.sweet = true\n[fruit.apple.texture]\nsmooth = true\n',
    "[a.b.c]\nx = 1\n[a]\ny = 2\n",
    "n = [+1, -0, 0, 1_000, 0xDEAD_beef, 0o755, 0b1010, 9223372036854775807, -9223372036854775808]\n",
    "f = [1.0, -0.5, 5e+22, 1e06, -2E-2, 6.626e-34, 9_224_617.445_991, inf, -inf, +nan]\n",
    "d = [1979-05-27T07:32:00Z, 1979-05-27 07:32:00.999-07:00, 1979-05-27T07:32:00, 1979-05-27, 07:32:00, 00:32:00.5, 2024-02-29]\n",
    'k = { a.b = 1, a.c = [ { d = "e" } ] }\n',
    '"quoted"."dotted" = true\n\'lit\' = 1\nbare-key_1 = "\\u00e9\\U0001F600\\t"\n',
    "x = [\n  [1, 2],\n  ['a', \"b\"],\n  { y = 1 },\n]\n"
  ];
  for (const texte of accepte) assert.equal(codex.tomlProblem(texte), null, JSON.stringify(texte));
});

// ── S2 et S13 (seconde passe adverse, re-revue du round FINAL) : UN lexeur ──
// Le pré-scan `scanLine` cherchait le premier `"""` sans voir un guillemet
// échappé, et la regex des en-têtes ratait `[x] # note` en CRLF : un TOML 1.0
// valide était refusé, un `[features]` écrit DANS une chaîne pouvait passer pour
// un en-tête, et `hooks = true` pouvait tomber sous `[tui]`. La validation et la
// découpe sont maintenant une seule lecture, et la sortie de la fusion se relit.
// L'oracle est tomllib (Python ≥ 3.11, TOML 1.0), lancé en `-I` ; les octets
// passent tels quels (CRLF compris). Jamais un skip : sans lui, la sonde ne peut
// pas tourner, et le dit.
function tomllib(texte) {
  const py = spawnSync("python3", ["-I", "-B", "-c", [
    "import sys, json, tomllib",
    "try:",
    "    d = tomllib.loads(sys.stdin.buffer.read().decode('utf-8'))",
    "except tomllib.TOMLDecodeError as e:",
    "    sys.stdout.write(json.dumps({'erreur': str(e)})); sys.exit(0)",
    "sys.stdout.write(json.dumps({'doc': d}, default=str))"
  ].join("\n")], { input: Buffer.from(texte, "utf8"), encoding: "utf8" });
  assert.equal(py.status, 0, `SONDE IMPOSSIBLE : python3 -I avec tomllib (Python ≥ 3.11) ne tourne pas ici (${py.error?.message ?? py.stderr})`);
  return JSON.parse(py.stdout);
}

const NOTE_ECHAPPEE = 'note = """start \\""" still inside\n[features]\nhooks = false\nend"""\n';
const NOTE_LUE = 'start """ still inside\n[features]\nhooks = false\nend';

test("S2 — le texte de la passe adverse (\\\"\"\" dans une chaîne \"\"\") est du TOML 1.0 : accepté, le [features] de la chaîne n'est pas un en-tête, hooks = true va dans un VRAI [features]", () => {
  assert.equal(tomllib(NOTE_ECHAPPEE).doc?.note, NOTE_LUE, "tomllib l'accepte");
  assert.equal(codex.tomlProblem(NOTE_ECHAPPEE), null);
  assert.deepEqual(codex.splitToml(NOTE_ECHAPPEE).map((s) => s.name), [null], "aucun en-tête dans la chaîne");
  const plan = codex.planCodexConfig(NOTE_ECHAPPEE, VALEURS);
  assert.deepEqual([plan.features.status, plan.mcp.status, plan.conflicts], ["write", "write", []]);
  assert.equal(plan.text, `${NOTE_ECHAPPEE}\n${codex.FEATURES_BLOCK}\n\n${BLOC_MCP}\n`);
  const lu = tomllib(plan.text).doc;
  assert.deepEqual([lu.note, lu.features], [NOTE_LUE, { hooks: true }], "la chaîne est intacte, la vraie table porte hooks = true");
  assert.equal(codex.mergedConfigProblem(plan.text, VALEURS), null);

  // Un VRAI [features] après la chaîne : c'est lui qu'on complète, ou lui qui fait conflit.
  const apres = `${NOTE_ECHAPPEE}[features]\nweb_search = true\n`;
  const complete = codex.planCodexConfig(apres, VALEURS);
  assert.deepEqual(complete.features, { status: "update", added: ["features.hooks"] });
  assert.deepEqual(tomllib(complete.text).doc.features, { web_search: true, hooks: true });
  const vraiFaux = NOTE_ECHAPPEE.replace("hooks = false", "hooks = true") + "[features]\nhooks = false\n";
  assert.equal(codex.planCodexConfig(vraiFaux, VALEURS).features.status, "conflict", "le hooks = true de la chaîne ne compte pas");
});

test("S2 — chaînes multi-lignes selon TOML 1.0 : ''' sans échappement, \\\\ avant \"\"\", quatre et cinq guillemets en fin de chaîne ; un fichier qui finit vraiment dans une chaîne est refusé", () => {
  const enTeteReel = "[features]\nhooks = true\n";
  for (const avant of [
    "x = '''C:\\'''\n",          // ''' n'a aucun échappement : le \ ne protège rien
    'x = """C:\\\\"""\n',        // \\ est un antislash échappé : le """ qui suit ferme
    'x = """a""""\n',            // un " de contenu, puis le délimiteur
    'x = """a"""""\n',           // deux " de contenu, puis le délimiteur
    "x = '''a''''\n",
    "x = '''a'''''\n",
    'x = """a\\\n   b"""\n'     // l'antislash de fin de ligne avale la fin de ligne et les blancs
  ]) {
    const texte = avant + enTeteReel;
    assert.equal(tomllib(texte).doc?.features?.hooks, true, `tomllib : ${JSON.stringify(texte)}`);
    assert.equal(codex.tomlProblem(texte), null, JSON.stringify(texte));
    assert.equal(codex.planCodexConfig(texte, VALEURS).features.status, "unchanged", `le [features] réel est lu : ${JSON.stringify(texte)}`);
  }
  const litterale = "x = '''\n[features]\nhooks = false\n'''\n";
  assert.equal(codex.tomlProblem(litterale), null);
  assert.equal(codex.planCodexConfig(litterale, VALEURS).features.status, "write", "un [features] dans ''' n'est pas une table");
  // Les deux refus de scanLine du relecteur (m1) : valides, donc acceptés.
  for (const valide of ['developer_instructions = """\nQuote it like \\""" this.\n"""\n', "x = [''''''']\n"]) {
    assert.equal(tomllib(valide).erreur, undefined, JSON.stringify(valide));
    assert.equal(codex.tomlProblem(valide), null, JSON.stringify(valide));
  }
  // Ouvert pour de bon : refusé, la cause dite.
  for (const ouvert of ['note = """start \\"""\n[features]\nhooks = true\n', "x = '''\n[features]\n", 'x = """a\\"""\n']) {
    assert.ok(tomllib(ouvert).erreur, `tomllib le refuse : ${JSON.stringify(ouvert)}`);
    assert.match(String(codex.tomlProblem(ouvert)), /ends inside a multi-line string/, JSON.stringify(ouvert));
  }
});

const CRLF_COMMENTE = 'model = "o3"\r\n[features] # experimental\r\nweb_search_request = true\r\n';
const CRLF_TUI = 'model = "o3"\r\n[features]\r\nweb_search_request = true\r\n[tui] # ui\r\nanimations = false\r\n';

test("S13 — en CRLF, un en-tête suivi d'un commentaire est un en-tête : hooks = true entre dans [features], une fois, aux fins de ligne du fichier", () => {
  for (const texte of [CRLF_COMMENTE, CRLF_TUI]) {
    assert.deepEqual(codex.splitToml(texte).map((s) => s.name), texte === CRLF_TUI ? [null, "features", "tui"] : [null, "features"]);
    const plan = codex.planCodexConfig(texte, VALEURS);
    assert.deepEqual([plan.features, plan.mcp.status, plan.conflicts], [{ status: "update", added: ["features.hooks"] }, "write", []], JSON.stringify(texte));
    const lu = tomllib(plan.text);
    assert.equal(lu.erreur, undefined, `${JSON.stringify(plan.text)} : ${lu.erreur}`);
    assert.deepEqual(lu.doc.features, { web_search_request: true, hooks: true });
    if (texte === CRLF_TUI) assert.deepEqual(lu.doc.tui, { animations: false }, "rien sous [tui]");
    assert.doesNotMatch(plan.text, /[^\r]\n/, "chaque ligne ajoutée garde le CRLF du fichier");
    assert.ok(plan.text.startsWith(texte.slice(0, texte.indexOf("web_search_request"))), "rien ne bouge avant");
    assert.equal(codex.mergedConfigProblem(plan.text, VALEURS), null);
  }
});

test("S13 — mergedConfigProblem relit la sortie de la fusion : du TOML invalide, hooks = true hors de [features], ou notre serveur absent sont des raisons de ne rien écrire", () => {
  const bon = codex.planCodexConfig("", VALEURS).text;
  assert.equal(codex.mergedConfigProblem(bon, VALEURS), null);
  assert.match(String(codex.mergedConfigProblem(`${bon}[features]\n`, VALEURS)), /not valid TOML.*defined twice/);
  const sousTui = bon.replace("[features]\nhooks = true", "[features]\nweb_search = true\n\n[tui]\nhooks = true");
  assert.equal(tomllib(sousTui).erreur, undefined);
  assert.match(String(codex.mergedConfigProblem(sousTui, VALEURS)), /features\.hooks is not true/);
  assert.match(String(codex.mergedConfigProblem(bon.replace("hooks = true", "hooks = false"), VALEURS)), /features\.hooks is not true/);
  assert.match(String(codex.mergedConfigProblem(bon.replace('VALXOS_SELF = "hal-test"', 'VALXOS_SELF = "bob"'), VALEURS)), /VALXOS_SELF/);
  assert.match(String(codex.mergedConfigProblem(codex.FEATURES_BLOCK, VALEURS)), /mcp_servers\.valxos_messenger/);
  // Une entrée valide dont la fusion ne le serait pas : la relecture l'arrête.
  for (const entree of ["[features.hooks]\nx = 1\n", "[features]\nhooks.when = 1\n", "[[features]]\nx = 1\n"]) {
    assert.equal(codex.tomlProblem(entree), null, JSON.stringify(entree));
    const plan = codex.planCodexConfig(entree, VALEURS);
    if (plan.conflicts.length > 0) continue;
    assert.ok(tomllib(plan.text).erreur, `la fusion naïve serait invalide : ${JSON.stringify(plan.text)}`);
    assert.match(String(codex.mergedConfigProblem(plan.text, VALEURS)), /not valid TOML/, JSON.stringify(entree));
  }
});

// ── hooks.json, sauvegardes, diff ──────────────────────────────────────────

test("planCodexHooks : sans fichier, les quatre hooks naissent", () => {
  const plan = codex.planCodexHooks(null, HOOKS_ATTENDUS);
  assert.equal(plan.status, "write");
  assert.deepEqual(JSON.parse(plan.text), HOOKS_ATTENDUS);
  assert.ok(plan.text.endsWith("}\n"));
  assert.deepEqual(Object.values(plan.events), ["appended", "appended", "appended", "appended"]);
});

test("planCodexHooks : le hook d'un autre outil reste premier, le nôtre s'ajoute après ; rejoué, rien ne change, au caractère près", () => {
  const leur = { type: "command", command: "/usr/local/bin/notify-test", timeout: 3 };
  const existant = `${JSON.stringify({ hooks: { Stop: [{ hooks: [leur] }] }, version: 1 }, null, 2)}\n`;
  const plan = codex.planCodexHooks(existant, HOOKS_ATTENDUS);
  assert.equal(plan.status, "update");
  assert.deepEqual(plan.events, { SessionStart: "appended", UserPromptSubmit: "appended", PostToolUse: "appended", Stop: "appended" });
  const fusion = JSON.parse(plan.text);
  assert.deepEqual(fusion.hooks.Stop, [{ hooks: [leur] }, ...HOOKS_ATTENDUS.hooks.Stop], "son index ne bouge pas, donc son approbation non plus");
  assert.deepEqual(fusion.hooks.SessionStart, HOOKS_ATTENDUS.hooks.SessionStart);
  assert.equal(fusion.version, 1, "les autres clefs du fichier restent");
  const rejoue = codex.planCodexHooks(plan.text, HOOKS_ATTENDUS);
  assert.deepEqual([rejoue.status, rejoue.text], ["unchanged", plan.text]);
  assert.deepEqual(Object.values(rejoue.events), ["unchanged", "unchanged", "unchanged", "unchanged"]);
});

test("planCodexHooks : notre hook sous une autre identité ou une autre porte, un fichier qui n'est pas un objet, un événement qui n'est pas une liste — des conflits, rien de réécrit", () => {
  const existant = `${JSON.stringify(codex.renderHooks(gabarit(), { ...VALEURS, self: "bob" }), null, 2)}\n`;
  const plan = codex.planCodexHooks(existant, HOOKS_ATTENDUS);
  assert.equal(plan.status, "conflict");
  assert.equal(plan.text, existant, "rien n'est réécrit");
  assert.deepEqual(Object.values(plan.events), ["conflict", "conflict", "conflict", "conflict"]);
  assert.match(plan.conflicts[0], /already runs a VALXOS Messenger hook that differs/);
  const autrePorte = `${JSON.stringify(codex.renderHooks(gabarit(), { ...VALEURS, porte: "cli" }), null, 2)}\n`;
  assert.equal(codex.planCodexHooks(autrePorte, HOOKS_ATTENDUS).status, "conflict", "changer de porte se fait à la main, jamais en silence");
  assert.equal(codex.planCodexHooks("{ pas du json", HOOKS_ATTENDUS).status, "conflict");
  assert.equal(codex.planCodexHooks('{"hooks": []}', HOOKS_ATTENDUS).status, "conflict");
  const pasUneListe = codex.planCodexHooks('{"hooks": {"Stop": {}}}', HOOKS_ATTENDUS);
  assert.deepEqual([pasUneListe.status, pasUneListe.events.Stop, pasUneListe.events.SessionStart], ["conflict", "conflict", "appended"]);
});

test("timestampShort et backupName : AAAAMMJJ-HHMM à l'heure locale ; une sauvegarde ne s'écrase jamais", () => {
  const date = new Date(2026, 9, 21, 9, 5);
  assert.equal(codex.timestampShort(date), "20261021-0905");
  assert.equal(codex.backupName("/x/config.toml", { exists: () => false, date }), "/x/config.toml.bak-20261021-0905");
  const prises = new Set(["/x/config.toml.bak-20261021-0905", "/x/config.toml.bak-20261021-0905-2"]);
  assert.equal(codex.backupName("/x/config.toml", { exists: (p) => prises.has(p), date }), "/x/config.toml.bak-20261021-0905-3", "Camp B");
});

test("lineDiff : les lignes ajoutées sous « @@ line N @@ », N dans le fichier neuf", () => {
  assert.equal(
    codex.lineDiff("a\nb\n", "a\nb\n\n[features]\nhooks = true\n", "config.toml"),
    "--- config.toml\n+++ config.toml\n@@ line 3 @@\n+\n+[features]\n+hooks = true\n"
  );
  assert.equal(
    codex.lineDiff("[features]\nweb_search = true\n", "[features]\nweb_search = true\nhooks = true\n", "c"),
    "--- c\n+++ c\n@@ line 3 @@\n+hooks = true\n"
  );
  assert.equal(codex.lineDiff("", "x\n", "n"), "--- n\n+++ n\n@@ line 1 @@\n+x\n");
  assert.equal(codex.lineDiff("a\nb\n", "a\n", "r"), "--- r\n+++ r\n@@ line 2 @@\n-b\n");
});

// ── En sous-processus : l'installeur du dépôt, dans un HOME jetable ────────

function maisonCodex(home) {
  const dossier = path.join(home, "codex-home");
  fs.mkdirSync(dossier);
  return dossier;
}

// Le bureau que `environnement()` pose : celui que l'installeur épingle.
const bureauDe = (home) => path.join(home, ".valxos-messenger");
// Le node que l'installeur épingle : la porte STABLE du node qui le fait
// tourner (stableNodePath, la règle des plists launchd) — ici le `node` du
// PATH jetable, un lien vers process.execPath. Jamais un `node` nu.
const nodeDe = (home) => path.join(home, "bin", "node");

function installCodex(home, args, ajouts = {}) {
  return lancer(home, ["--codex", "--self", SELF, ...args], ajouts);
}

// Les morceaux tels que l'installeur de CE dépôt les écrit pour ce HOME.
function attendus(home, porte = null) {
  const valeurs = { packageRoot: repo, self: SELF, office: bureauDe(home), node: nodeDe(home), porte };
  return {
    valeurs,
    hooks: codex.renderHooks(gabarit(), valeurs),
    config: `${codex.FEATURES_BLOCK}\n\n${codex.mcpServerBlock(valeurs)}\n`
  };
}

for (const [args, ajouts, motif] of [
  [["--codex"], {}, /--codex needs --self NAME/],
  [["--codex", "--self"], {}, /--codex needs --self NAME/],
  [["--codex", "--self", "pas un nom!"], {}, /--self "pas un nom!" is not an acceptable identity/],
  [["--write"], {}, /--write, --self, --codex-home and --porte apply to --codex only/],
  [["--self", SELF], {}, /apply to --codex only/],
  [["--codex-home", "/tmp/codex"], {}, /apply to --codex only/],
  [["--porte", "app"], {}, /apply to --codex only/],
  [["--codex", "--self", SELF, "--launchd"], {}, /--codex does not combine with --launchd/],
  [["--codex", "--self", SELF, "--uninstall"], {}, /--codex does not combine with --uninstall/],
  [["--codex", "--self", SELF, "--write", "--dry-run"], {}, /--write and --dry-run contradict each other/],
  [["--codex", "--self", SELF, "--porte", "exec"], {}, /--porte exec is not a door this installer wires \(app or cli\)/],
  [["--codex", "--self", SELF, "--porte"], {}, /--porte needs app or cli/],
  [["--codex", "--self", SELF, "--codex-home", "relatif/codex"], {}, /--codex-home relatif\/codex is not an absolute path/],
  [["--codex", "--self", SELF], { CODEX_HOME: "relatif/codex" }, /CODEX_HOME=relatif\/codex is not an absolute path/]
]) {
  const nom = `${args.join(" ")}${ajouts.CODEX_HOME ? ` (CODEX_HOME=${ajouts.CODEX_HOME})` : ""}`;
  test(`install ${nom} : refusé (rc 2), la raison en anglais, rien touché`, (t) => {
    const home = fauxHome(t);
    const avant = arbre(home);
    const sortie = lancer(home, args, ajouts);
    assert.equal(sortie.status, 2, `${sortie.stdout}\n${sortie.stderr}`);
    assert.match(sortie.stderr, motif);
    assert.match(sortie.stderr, /Nothing was done\./);
    assert.deepEqual(arbre(home), avant);
  });
}

test("install --codex sans --write : les trois morceaux, le plan, le rapport — et rien ne bouge", (t) => {
  const home = fauxHome(t);
  const codexHome = maisonCodex(home);
  const config = path.join(codexHome, "config.toml");
  fs.writeFileSync(config, 'model = "o4-mini"\n');
  const avant = arbre(home);
  const octets = fs.readFileSync(config);
  const { valeurs, hooks } = attendus(home);

  const sortie = installCodex(home, ["--codex-home", codexHome]);

  assert.equal(sortie.status, 0, `${sortie.stdout}\n${sortie.stderr}`);
  assert.match(sortie.stdout, /^\[DRY RUN\] Codex wiring for hal-test/m);
  const indente = (texte) => texte.replace(/^/gm, "    ");
  assert.ok(sortie.stdout.includes(indente(codex.FEATURES_BLOCK)), "morceau 1 : [features] hooks = true");
  assert.ok(sortie.stdout.includes(indente(JSON.stringify(hooks, null, 2))), "morceau 2 : les quatre hooks");
  assert.ok(sortie.stdout.includes(indente(codex.mcpServerBlock(valeurs))), "morceau 3 : le serveur MCP");
  assert.equal(
    hooks.hooks.SessionStart[0].hooks[0].command,
    `env VALXOS_SELF=hal-test VALXOS_MESSENGER_HOME=${codex.shellQuote(bureauDe(home))} ` +
      `${codex.shellQuote(nodeDe(home))} ${codex.shellQuote(repo)}/src/hooks/codex/codex-hook.js --serves hal-test`
  );
  assert.match(sortie.stdout, /^Door: not pinned\.[\s\S]*VALXOS_CODEX_PORTE=cli/m, "sans --porte : chaque session dit la sienne, et le terminal se dit cli");
  assert.doesNotMatch(sortie.stdout, /GARDE_BUREAU/, "la garde des suites ne s'écrit jamais chez l'utilisateur");
  const r = rapport(sortie);
  assert.deepEqual(
    [r.ok, r.mode, r.dry_run, r.codex_home, r.self, r.office, r.porte, r.node, r.config.features.status, r.config.mcp.status, r.hooks.status, r.written, r.backups, r.conflicts],
    [true, "codex", true, codexHome, SELF, bureauDe(home), null, { chemin: nodeDe(home), repli: false }, "write", "write", "write", [], [], []]
  );
  assert.ok(path.isAbsolute(r.node.chemin), "un node absolu");
  assert.equal(fs.realpathSync(r.node.chemin), fs.realpathSync(process.execPath), "le node même qui fait tourner l'installeur");
  assert.doesNotMatch(sortie.stdout, /^Node: /m, "un lien stable trouvé : rien à annoncer");
  assert.deepEqual(arbre(home), avant, "un dry-run ne crée rien");
  assert.deepEqual(fs.readFileSync(config), octets, "et ne réécrit rien");
});

test("install --codex --porte cli : la porte du terminal entre dans la commande du hook", (t) => {
  const home = fauxHome(t);
  const codexHome = maisonCodex(home);
  const sortie = installCodex(home, ["--codex-home", codexHome, "--porte", "cli"]);
  assert.equal(sortie.status, 0, `${sortie.stdout}\n${sortie.stderr}`);
  const r = rapport(sortie);
  assert.equal(r.porte, "cli");
  const commande = attendus(home, "cli").hooks.hooks.Stop[0].hooks[0].command;
  assert.match(commande, /VALXOS_CODEX_PORTE=cli /);
  assert.ok(sortie.stdout.includes(JSON.stringify(commande)), "la commande imprimée est celle de la porte cli");
  assert.match(sortie.stdout, /^Door: cli, pinned for every session of this Codex home[\s\S]*never opens the desktop app/m);
  const app = installCodex(home, ["--codex-home", codexHome, "--porte", "app"]);
  assert.match(attendus(home, "app").hooks.hooks.Stop[0].hooks[0].command, /VALXOS_CODEX_PORTE=app /);
  assert.equal(rapport(app).porte, "app");
  assert.match(app.stdout, /^Door: app, pinned for every session of this Codex home, the terminal's included/m);
});

test("round 1 — sans lien stable vers le node qui tourne, le binaire lui-même est épinglé, et le repli se DIT (rapport et écran)", (t) => {
  const home = fauxHome(t);
  const codexHome = maisonCodex(home);
  const vide = path.join(home, "path-vide");
  fs.mkdirSync(vide);
  const sortie = installCodex(home, ["--codex-home", codexHome], { PATH: vide });
  assert.equal(sortie.status, 0, `${sortie.stdout}\n${sortie.stderr}`);
  assert.deepEqual(rapport(sortie).node, { chemin: process.execPath, repli: true });
  assert.match(sortie.stdout, /^Node: .* no stable link to it is on PATH[\s\S]*upgrad/m);
  assert.ok(sortie.stdout.includes(JSON.stringify(`env VALXOS_SELF=hal-test VALXOS_MESSENGER_HOME=${codex.shellQuote(bureauDe(home))} ${codex.shellQuote(process.execPath)} `).slice(0, -1)));
});

test("install --codex : la maison Codex est --codex-home, sinon $CODEX_HOME, sinon ~/.codex — jamais créée sans --write", (t) => {
  const home = fauxHome(t);
  const codexHome = maisonCodex(home);
  assert.equal(rapport(installCodex(home, [], { CODEX_HOME: codexHome })).codex_home, codexHome);
  const autre = path.join(home, "autre");
  assert.equal(rapport(installCodex(home, ["--codex-home", autre], { CODEX_HOME: codexHome })).codex_home, autre);
  const parDefaut = installCodex(home, []);
  assert.equal(parDefaut.status, 0, parDefaut.stderr);
  assert.equal(rapport(parDefaut).codex_home, path.join(home, ".codex"));
  assert.equal(fs.existsSync(path.join(home, ".codex")), false);
  assert.equal(fs.existsSync(autre), false);
});

test("install --codex --write dans une maison Codex vide : config.toml et hooks.json naissent privés, exacts, sans sauvegarde — et sans la garde", (t) => {
  const home = fauxHome(t);
  const codexHome = maisonCodex(home);
  const { hooks, config } = attendus(home);
  const fichierConfig = path.join(codexHome, "config.toml");
  const fichierHooks = path.join(codexHome, "hooks.json");

  const sortie = installCodex(home, ["--codex-home", codexHome, "--write"], { CC2CC_GARDE_BUREAU: "1", VALXOS_GARDE_BUREAU: "1" });

  assert.equal(sortie.status, 0, `${sortie.stdout}\n${sortie.stderr}`);
  const r = rapport(sortie);
  assert.deepEqual([r.ok, r.dry_run, r.written, r.backups], [true, false, [fichierConfig, fichierHooks], []]);
  assert.equal(fs.readFileSync(fichierConfig, "utf8"), config);
  assert.deepEqual(JSON.parse(fs.readFileSync(fichierHooks, "utf8")), hooks);
  for (const fichier of [fichierConfig, fichierHooks]) {
    assert.equal(fs.statSync(fichier).mode & 0o777, 0o600, `${fichier} naît privé`);
    assert.doesNotMatch(fs.readFileSync(fichier, "utf8"), /GARDE_BUREAU/, "la garde de l'installeur ne descend jamais dans la config");
  }
  assert.ok(sortie.stdout.includes(`--- ${fichierConfig}`) && sortie.stdout.includes("+[features]"), "le diff est imprimé");
  assert.match(sortie.stdout, /approve these hooks once with \/hooks/);
  assert.deepEqual(fs.readdirSync(codexHome).sort(), ["config.toml", "hooks.json"], "aucun temporaire ne reste");
  assert.equal(fs.existsSync(bureauDe(home)), false, "le mode Codex n'ouvre pas le bureau : les hooks le feront");
});

test("install --codex --write sur des fichiers existants : sauvegardes datées à l'octet, les autres tables gardées, leur hook gardé premier, leur mode gardé", (t) => {
  const home = fauxHome(t);
  const codexHome = maisonCodex(home);
  const { valeurs, hooks } = attendus(home);
  const fichierConfig = path.join(codexHome, "config.toml");
  const fichierHooks = path.join(codexHome, "hooks.json");
  const configAvant = 'model = "o4-mini"\n\n[features]\nweb_search = true\n\n[mcp_servers.cc2cc]\ncommand = "node"\nargs = ["/ancien/src/mcp-server/server.js"]\n';
  const leur = { type: "command", command: "/usr/local/bin/notify-test", timeout: 3 };
  const hooksAvant = `${JSON.stringify({ hooks: { Stop: [{ hooks: [leur] }] } }, null, 2)}\n`;
  fs.writeFileSync(fichierConfig, configAvant, { mode: 0o644 });
  fs.writeFileSync(fichierHooks, hooksAvant, { mode: 0o644 });

  const sortie = installCodex(home, ["--codex-home", codexHome, "--write"]);

  assert.equal(sortie.status, 0, `${sortie.stdout}\n${sortie.stderr}`);
  const r = rapport(sortie);
  assert.deepEqual([r.config.features.status, r.config.mcp.status, r.hooks.status], ["update", "write", "update"]);
  assert.equal(r.backups.length, 2);
  const [sauvegardeConfig, sauvegardeHooks] = r.backups;
  assert.match(path.basename(sauvegardeConfig), /^config\.toml\.bak-\d{8}-\d{4}$/);
  assert.match(path.basename(sauvegardeHooks), /^hooks\.json\.bak-\d{8}-\d{4}$/);
  assert.equal(fs.readFileSync(sauvegardeConfig, "utf8"), configAvant, "la sauvegarde est le fichier d'avant, à l'octet");
  assert.equal(fs.readFileSync(sauvegardeHooks, "utf8"), hooksAvant);
  assert.equal(
    fs.readFileSync(fichierConfig, "utf8"),
    `model = "o4-mini"\n\n[features]\nweb_search = true\nhooks = true\n\n[mcp_servers.cc2cc]\ncommand = "node"\nargs = ["/ancien/src/mcp-server/server.js"]\n\n${codex.mcpServerBlock(valeurs)}\n`,
    "l'autre serveur reste tel quel ; hooks = true entre dans SA table ; le nôtre s'ajoute à la fin"
  );
  const fusion = JSON.parse(fs.readFileSync(fichierHooks, "utf8"));
  assert.deepEqual(fusion.hooks.Stop, [{ hooks: [leur] }, ...hooks.hooks.Stop]);
  assert.deepEqual(fusion.hooks.SessionStart, hooks.hooks.SessionStart);
  assert.equal(fs.statSync(fichierConfig).mode & 0o777, 0o644, "le mode du fichier de l'utilisateur est gardé");
});

test("install --codex --write sur un config.toml qui est un lien (des dotfiles) : le lien reste un lien, le fichier qu'il désigne reçoit la fusion", (t) => {
  const home = fauxHome(t);
  const codexHome = maisonCodex(home);
  const dotfiles = path.join(home, "dotfiles");
  fs.mkdirSync(dotfiles);
  const cible = path.join(dotfiles, "codex-config.toml");
  fs.writeFileSync(cible, 'model = "o4-mini"\n', { mode: 0o600 });
  const lien = path.join(codexHome, "config.toml");
  fs.symlinkSync(cible, lien);

  const sortie = installCodex(home, ["--codex-home", codexHome, "--write"]);

  assert.equal(sortie.status, 0, `${sortie.stdout}\n${sortie.stderr}`);
  assert.ok(fs.lstatSync(lien).isSymbolicLink(), "le lien des dotfiles n'est pas remplacé par un fichier");
  assert.equal(fs.readlinkSync(lien), cible);
  assert.ok(fs.readFileSync(cible, "utf8").startsWith('model = "o4-mini"\n\n[features]\nhooks = true\n'));
  assert.equal(fs.readFileSync(rapport(sortie).backups[0], "utf8"), 'model = "o4-mini"\n', "la sauvegarde est le contenu d'avant");
  assert.deepEqual(fs.readdirSync(dotfiles), ["codex-config.toml"], "aucun temporaire ne reste à côté de la cible");
});

test("install --codex --write deux fois : un seul changement — la seconde ne sauvegarde rien et n'écrit rien", (t) => {
  const home = fauxHome(t);
  const codexHome = maisonCodex(home);
  fs.writeFileSync(path.join(codexHome, "config.toml"), 'model = "o4-mini"\n');
  const premiere = installCodex(home, ["--codex-home", codexHome, "--write"]);
  assert.equal(premiere.status, 0, `${premiere.stdout}\n${premiere.stderr}`);
  assert.equal(rapport(premiere).backups.length, 1, "une sauvegarde : celle de config.toml (hooks.json n'existait pas)");
  const apresUne = arbre(home);
  const lire = () => ["config.toml", "hooks.json"].map((f) => fs.readFileSync(path.join(codexHome, f), "utf8"));
  const contenus = lire();

  const seconde = installCodex(home, ["--codex-home", codexHome, "--write"]);

  assert.equal(seconde.status, 0, `${seconde.stdout}\n${seconde.stderr}`);
  const r = rapport(seconde);
  assert.deepEqual(
    [r.written, r.backups, r.config.features.status, r.config.mcp.status, r.hooks.status],
    [[], [], "unchanged", "unchanged", "unchanged"]
  );
  assert.match(seconde.stdout, /Nothing to change/);
  assert.deepEqual(arbre(home), apresUne, "aucun fichier neuf, aucune sauvegarde de plus");
  assert.deepEqual(lire(), contenus);
});

test("install --codex --write sur un conflit : sortie 1, les conflits nommés, rien d'écrit, aucune sauvegarde", (t) => {
  const home = fauxHome(t);
  const codexHome = maisonCodex(home);
  const { valeurs } = attendus(home);
  fs.writeFileSync(path.join(codexHome, "config.toml"), "[features]\nhooks = false\n");
  fs.writeFileSync(path.join(codexHome, "hooks.json"), `${JSON.stringify(codex.renderHooks(gabarit(), { ...valeurs, self: "bob" }), null, 2)}\n`);
  const avant = arbre(home);
  const lire = () => ["config.toml", "hooks.json"].map((f) => fs.readFileSync(path.join(codexHome, f), "utf8"));
  const contenus = lire();

  const sortie = installCodex(home, ["--codex-home", codexHome, "--write"]);

  assert.equal(sortie.status, 1, `${sortie.stdout}\n${sortie.stderr}`);
  assert.match(sortie.stderr, /Refusing to write/);
  const r = rapport(sortie);
  assert.equal(r.ok, false);
  assert.equal(r.conflicts.length, 5, "hooks = false, et les quatre hooks d'une autre identité");
  assert.deepEqual([r.written, r.backups], [[], []]);
  assert.deepEqual(arbre(home), avant);
  assert.deepEqual(lire(), contenus);

  const seche = installCodex(home, ["--codex-home", codexHome]);
  assert.equal(seche.status, 1, "le dry-run d'un conflit le dit aussi : sortie 1");
  assert.match(seche.stdout, /--write would refuse/);
});

// ── Round 1, constat 1 : un fichier illisible n'est jamais un fichier absent ──
// `readIfExists` (partagé par le reste de l'installeur) lit TOUTE erreur comme
// une absence : un config.toml en mode 000 était remplacé sans sauvegarde, et
// le rapport disait ok. Le mode Codex lit à trois issues — absent (ENOENT seul),
// contenu, illisible — et un illisible ou un invalide se refuse, sortie 1, avec
// `{ refus, fichier, cause }` au rapport : rien d'écrit, rien de sauvegardé.
function refusSansTrace(home, codexHome, args, attendu) {
  const avant = arbre(home);
  const sortie = installCodex(home, ["--codex-home", codexHome, ...args]);
  assert.equal(sortie.status, 1, `${sortie.stdout}\n${sortie.stderr}`);
  const r = rapport(sortie);
  assert.deepEqual([r.ok, r.refus, r.fichier], [false, attendu.refus, attendu.fichier]);
  assert.match(String(r.cause), attendu.cause);
  assert.match(sortie.stderr, /Refusing to wire Codex: .* cannot be used \(.*\)\. Nothing was written\./);
  assert.doesNotMatch(sortie.stderr, /\n\s+at /, "une phrase, jamais une pile");
  assert.deepEqual([r.written, r.backups], [[], []]);
  assert.deepEqual(arbre(home), avant, "aucune sauvegarde, aucun fichier neuf");
  return r;
}

test("config.toml en mode 000 : --write refuse (sortie 1), le fichier reste à l'octet, aucune sauvegarde, hooks.json ne naît pas ; le dry-run refuse aussi", (t) => {
  const home = fauxHome(t);
  const codexHome = maisonCodex(home);
  const config = path.join(codexHome, "config.toml");
  const contenu = 'model = "o4-mini"\n\n[mcp_servers.autre]\ncommand = "x"\n\n[mcp_servers.autre.env]\nCLEF = "y"\n';
  fs.writeFileSync(config, contenu);
  fs.chmodSync(config, 0o000);
  // Jamais un skip (test/quarantaine.test.js) : sous root, la sonde ne peut pas tourner, et le dit.
  assert.throws(() => fs.readFileSync(config), /EACCES/, "SONDE IMPOSSIBLE : un fichier en mode 000 se lit ici (root ?)");
  const attendu = { refus: "fichier-illisible", fichier: config, cause: /EACCES/ };

  refusSansTrace(home, codexHome, ["--write"], attendu);
  refusSansTrace(home, codexHome, [], attendu);

  fs.chmodSync(config, 0o600);
  assert.equal(fs.readFileSync(config, "utf8"), contenu, "la config de l'utilisateur est intacte");
  assert.equal(fs.existsSync(path.join(codexHome, "hooks.json")), false);
});

test("A1 — config.toml = « this is not toml » : --write sort 1 (`fichier-invalide`), le fichier reste à l'octet (sha256), aucune sauvegarde, hooks.json ne naît pas ; le dry-run refuse aussi", (t) => {
  const home = fauxHome(t);
  const codexHome = maisonCodex(home);
  const config = path.join(codexHome, "config.toml");
  fs.writeFileSync(config, "this is not toml");
  const empreinte = () => crypto.createHash("sha256").update(fs.readFileSync(config)).digest("hex");
  const avant = empreinte();
  const attendu = { refus: "fichier-invalide", fichier: config, cause: /not valid TOML.*line 1, column 6/ };
  for (const args of [["--write"], []]) {
    refusSansTrace(home, codexHome, args, attendu);
    assert.equal(empreinte(), avant, `${args.join(" ") || "dry-run"} : la config de l'utilisateur est intacte`);
    assert.deepEqual(fs.readdirSync(codexHome), ["config.toml"], "aucun .bak, aucun hooks.json");
  }
});

test("config.toml lien cassé, dossier, octets qui ne sont pas de l'UTF-8 ; hooks.json qui n'est pas du JSON ; config.toml qui finit dans une chaîne : refusés, rien d'écrit", (t) => {
  const cas = [
    ["config.toml", (f) => fs.symlinkSync(path.join(path.dirname(f), "dotfiles-absents", "config.toml"), f), "fichier-illisible", /symlink whose target does not exist/],
    ["config.toml", (f) => fs.mkdirSync(f), "fichier-illisible", /is a directory/],
    ["config.toml", (f) => fs.writeFileSync(f, Buffer.from([0x6d, 0x3d, 0x22, 0xff, 0xfe, 0x22, 0x0a])), "fichier-illisible", /not valid UTF-8/],
    ["hooks.json", (f) => fs.writeFileSync(f, "{ pas du json"), "fichier-invalide", /not valid JSON/],
    ["config.toml", (f) => fs.writeFileSync(f, 'instructions = """\nsans fin\n'), "fichier-invalide", /ends inside a multi-line string/],
    ["config.toml", (f) => fs.writeFileSync(f, "this is not toml"), "fichier-invalide", /not valid TOML.*line 1, column 6/]
  ];
  for (const [nom, poser, refus, cause] of cas) {
    const home = fauxHome(t);
    const codexHome = maisonCodex(home);
    const fichier = path.join(codexHome, nom);
    poser(fichier);
    refusSansTrace(home, codexHome, ["--write"], { refus, fichier, cause });
  }
  const home = fauxHome(t);
  const codexHome = maisonCodex(home);
  const lien = path.join(codexHome, "config.toml");
  fs.symlinkSync(path.join(home, "dotfiles-absents", "config.toml"), lien);
  installCodex(home, ["--codex-home", codexHome, "--write"]);
  assert.ok(fs.lstatSync(lien).isSymbolicLink(), "le lien cassé reste un lien : il n'est jamais remplacé par un fichier");
  assert.equal(fs.existsSync(path.join(home, "dotfiles-absents")), false);
});

// ── S2 et S13 avec l'installeur réel : le texte de la passe adverse, les deux CRLF du relecteur,
// et une fusion qui serait invalide (refus `fusion-invalide`, rien d'écrit) ────
test("S2/S13 — install --codex --write sur le texte de la passe adverse et sur les deux CRLF du relecteur : sortie 0, un config.toml que tomllib lit, features.hooks = true", (t) => {
  for (const avant of [NOTE_ECHAPPEE, CRLF_COMMENTE, CRLF_TUI]) {
    const home = fauxHome(t);
    const codexHome = maisonCodex(home);
    const fichier = path.join(codexHome, "config.toml");
    fs.writeFileSync(fichier, avant);
    const sortie = installCodex(home, ["--codex-home", codexHome, "--write"]);
    assert.equal(sortie.status, 0, `${JSON.stringify(avant)}\n${sortie.stdout}\n${sortie.stderr}`);
    const r = rapport(sortie);
    assert.deepEqual([r.ok, r.refus, r.backups.length], [true, null, 1]);
    assert.equal(fs.readFileSync(r.backups[0], "utf8"), avant, "la sauvegarde est le fichier d'avant, à l'octet");
    const lu = tomllib(fs.readFileSync(fichier, "utf8"));
    assert.equal(lu.erreur, undefined, `${JSON.stringify(avant)} : ${lu.erreur}`);
    assert.equal(lu.doc.features.hooks, true, JSON.stringify(avant));
    assert.equal(lu.doc.mcp_servers.valxos_messenger.env.VALXOS_SELF, SELF);
    if (avant === NOTE_ECHAPPEE) assert.equal(lu.doc.note, NOTE_LUE);
    if (avant === CRLF_TUI) assert.deepEqual(lu.doc.tui, { animations: false });
  }
});

test("S13 (troisième passe) — un config.toml qui commence par une marque d'ordre UTF-8 : fichier-invalide, motif bom, sortie 1, rien d'écrit, aucune sauvegarde ; la relecture de sortie la refuse aussi", (t) => {
  const BOM = "\uFEFF";
  assert.ok(tomllib(`${BOM}model = "o4-mini"\n`).erreur, "tomllib refuse la marque d'ordre");
  assert.match(String(codex.mergedConfigProblem(BOM + codex.planCodexConfig("", VALEURS).text, VALEURS)), /not valid TOML.*byte-order mark/);
  const home = fauxHome(t);
  const codexHome = maisonCodex(home);
  const config = path.join(codexHome, "config.toml");
  const avant = `${BOM}model = "o4-mini"\n`;
  fs.writeFileSync(config, avant);
  for (const args of [["--write"], []]) {
    const r = refusSansTrace(home, codexHome, args, { refus: "fichier-invalide", fichier: config, cause: /remove the UTF-8 byte-order mark/ });
    assert.equal(r.motif, "bom", JSON.stringify(r));
    assert.equal(fs.readFileSync(config, "utf8"), avant, "le fichier reste à l'octet");
    assert.deepEqual(fs.readdirSync(codexHome), ["config.toml"], "aucun .bak, aucun hooks.json");
  }
});

test("S13 — une fusion dont la sortie ne serait pas du TOML valide : `fusion-invalide`, sortie 1, rien d'écrit, aucune sauvegarde, hooks.json ne naît pas ; le dry-run refuse aussi", (t) => {
  const home = fauxHome(t);
  const codexHome = maisonCodex(home);
  const fichier = path.join(codexHome, "config.toml");
  const avant = "[features.hooks]\nx = 1\n";
  fs.writeFileSync(fichier, avant);
  for (const args of [["--write"], []]) {
    const etat = arbre(home);
    const sortie = installCodex(home, ["--codex-home", codexHome, ...args]);
    assert.equal(sortie.status, 1, `${sortie.stdout}\n${sortie.stderr}`);
    const r = rapport(sortie);
    assert.deepEqual([r.ok, r.refus, r.fichier, r.written, r.backups], [false, "fusion-invalide", fichier, [], []]);
    assert.match(String(r.cause), /not valid TOML/);
    assert.match(sortie.stderr, /Refusing to wire Codex: merging into .*config\.toml would not give a valid file \(.*\)\. Nothing was written\./);
    assert.doesNotMatch(sortie.stderr, /\n\s+at /, "une phrase, jamais une pile");
    assert.deepEqual(arbre(home), etat, "aucune sauvegarde, aucun fichier neuf");
    assert.equal(fs.readFileSync(fichier, "utf8"), avant);
  }
});

// ── Round 1, constat 3 : une écriture interrompue se dit, sans pile ─────────
test("round 1 — hooks.json ne s'écrit pas après config.toml : sortie 1, `ecriture-interrompue`, ce qui est déjà écrit et sa sauvegarde nommés, jamais une pile", (t) => {
  const home = fauxHome(t);
  const codexHome = maisonCodex(home);
  const fichierConfig = path.join(codexHome, "config.toml");
  const fichierHooks = path.join(codexHome, "hooks.json");
  fs.writeFileSync(fichierConfig, 'model = "o4-mini"\n');
  // hooks.json est un lien vers un fichier LISIBLE dans un dossier en lecture seule :
  // la lecture passe, la sauvegarde aussi (elle va dans la maison Codex), le
  // remplacement atomique (un temporaire à côté de la cible) échoue.
  const verrouille = path.join(home, "verrouille");
  fs.mkdirSync(verrouille);
  const cible = path.join(verrouille, "hooks.json");
  const hooksAvant = '{\n  "hooks": {}\n}\n';
  fs.writeFileSync(cible, hooksAvant);
  fs.symlinkSync(cible, fichierHooks);
  fs.chmodSync(verrouille, 0o555);
  let sortie;
  try {
    assert.throws(() => fs.writeFileSync(path.join(verrouille, "sonde"), ""), /EACCES/, "SONDE IMPOSSIBLE : un dossier en 0555 s'écrit ici (root ?)");
    sortie = installCodex(home, ["--codex-home", codexHome, "--write"]);
  } finally {
    // Avant toute assertion : le nettoyage du HOME jetable doit pouvoir passer.
    fs.chmodSync(verrouille, 0o755);
  }

  assert.equal(sortie.status, 1, `${sortie.stdout}\n${sortie.stderr}`);
  const r = rapport(sortie);
  assert.deepEqual([r.ok, r.refus, r.fichier], [false, "ecriture-interrompue", fichierHooks]);
  assert.match(String(r.cause), /EACCES/);
  assert.deepEqual(r.written, [fichierConfig], "config.toml était déjà écrit : le rapport le dit");
  assert.equal(r.backups.length, 2);
  const [sauvegardeConfig] = r.backups;
  assert.equal(fs.readFileSync(sauvegardeConfig, "utf8"), 'model = "o4-mini"\n', "sa sauvegarde est là pour défaire");
  assert.match(sortie.stderr, new RegExp(`Writing ${fichierHooks.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} failed`));
  assert.ok(sortie.stderr.includes(`restore ${fichierConfig} from ${sauvegardeConfig}`), sortie.stderr);
  assert.doesNotMatch(sortie.stderr, /\n\s+at /, "une phrase, jamais une pile");
  assert.equal(fs.readFileSync(cible, "utf8"), hooksAvant, "le hooks.json de l'utilisateur n'a pas bougé");
  assert.deepEqual(fs.readdirSync(verrouille), ["hooks.json"], "aucun temporaire");
});

test("install --codex --write vers une maison Codex qui n'existe pas : refusé (sortie 1), rien n'est créé", (t) => {
  const home = fauxHome(t);
  const absente = path.join(home, "pas-de-codex");
  const sortie = installCodex(home, ["--codex-home", absente, "--write"]);
  assert.equal(sortie.status, 1, `${sortie.stdout}\n${sortie.stderr}`);
  assert.match(sortie.stderr, /does not exist/);
  assert.equal(fs.existsSync(absente), false);
});

test("valxos-messenger install --codex relaie au mode Codex, et son aide le nomme", (t) => {
  const home = fauxHome(t);
  const codexHome = maisonCodex(home);
  const point = path.join(repo, "src", "bin", "valxos-messenger.js");
  const sortie = spawnSync(process.execPath, [point, "install", "--codex", "--self", SELF, "--codex-home", codexHome], {
    encoding: "utf8", cwd: repo, env: environnement(home)
  });
  assert.equal(sortie.status, 0, `${sortie.stdout}\n${sortie.stderr}`);
  assert.equal(rapport(sortie).mode, "codex");
  const aide = spawnSync(process.execPath, [point, "--help"], { encoding: "utf8", env: environnement(home) });
  assert.equal(aide.status, 0, aide.stderr);
  assert.match(aide.stdout, /valxos-messenger install --codex --self NAME \[--codex-home DIR\] \[--porte app\|cli\] \[--write\]/);
  assert.match(aide.stdout, /VALXOS_CODEX_PORTE/, "l'aide dit d'où vient la porte sans --porte");
  assert.match(aide.stdout, /approve the hooks once in Codex: \/hooks/);
});
