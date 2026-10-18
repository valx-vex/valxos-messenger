// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
//
// LE PAQUET PUBLIABLE — ce que `npm publish` emporterait, prouvé sans publier.
//
// Trois familles de sondes, toutes sans réseau :
//   1. le manifeste (package.json) porte la version taguée, la licence qui
//      correspond au fichier LICENSE et aux en-têtes SPDX, l'adresse du dépôt
//      public, le plancher Node dérivé des dépendances, l'accès public et la
//      liste blanche `files` qui ne nomme QUE ce qui existe et doit partir
//      (un retrait « ! » peut viser un chemin absent du miroir public) ;
//   2. chaque commande de `bin` existe, porte son shebang, est exécutable dans
//      l'index git (pas seulement sur ce disque) ;
//   3. le tarball que `npm pack` produirait contient le serveur, les commandes,
//      les docs et le plugin — et rien de l'atelier (test/, tmp/, .claude/,
//      .worktrees/, graphify-out/, node_modules/) ; puis le point d'entrée
//      un-clic S'EXÉCUTE depuis un tarball extrait, avec et sans
//      CLAUDE_CONFIG_DIR, sans écrire un octet dans le faux HOME.
//
// La version attendue est écrite EN DUR : ce test est la check-list de
// release. Un bump de version passe par ici, et entraîne le verrou npm, le
// manifeste du plugin et le CHANGELOG dans le même geste.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lireJson = (relatif) => JSON.parse(fs.readFileSync(path.join(repo, relatif), "utf8"));
const pkg = lireJson("package.json");

// La release est `1.0.0` : rc.3 promu tel quel le 26/09/2026 (package.json et
// le verrou l'ont suivie ce jour-là ; le manifeste du plugin et le CHANGELOG
// ont suivi le 27/09, Run 6). Une seule version, partout.
const VERSION_ATTENDUE = "1.0.0";
const DEPOT_PUBLIC = "https://github.com/valx-vex/valxos-messenger";

// Ce qui DOIT partir — chaque entrée existe dans l'arbre.
const FICHIERS_REQUIS = [
  "src/", "scripts/", "docs/", ".claude-plugin/", "skills/", "hooks/", "monitors/",
  "mcp.json", "README.md", "README.fr.md", "LICENSE", "CHANGELOG.md"
];
// Ce qui ne part JAMAIS — l'atelier, les copies du harnais, les caches.
const PREFIXES_INTERDITS = [
  "test/", "tmp/", ".claude/", ".worktrees/", "graphify-out/", "node_modules/",
  ".github/", ".superpowers/", "coverage/",
  // Les plans de l'atelier vivent sous docs/ mais ne sont pas de la doc
  // utilisateur : `files` les retire par une entrée « ! » (Run 6, Task 10).
  "docs/superpowers/",
  // Le runbook de l'opérateur nomme la session de la chaise désignée et la carte des maisons :
  // il vit sous docs/ pour l'équipe, jamais dans le paquet (Run 6, Task 13).
  "docs/runbooks/",
  // Le registre des quarantaines décrit le banc (test/), qui ne part pas : il
  // reste au dépôt, à côté des tests qu'il nomme (audit du paquet, 18/10).
  "docs/QUARANTAINE.md"
];
// `.export-exclude` est la liste de l'export public (tools/export-public.js) : elle reste au dépôt et au miroir.
const FICHIERS_INTERDITS = ["package-lock.json", ".gitignore", ".npmrc", ".export-exclude"];

// npm ne se contente pas de `files` : il exclut toujours node_modules et
// package-lock.json, et inclut toujours package.json, README*, LICENSE*,
// CHANGELOG*. La liste blanche reste la seule frontière que l'on CHOISIT.
// Un dossier promis sans sa barre (`"skills": "./skills"` dans plugin.json)
// est couvert par l'entrée `skills/` de la liste blanche.
// Une entrée « !chemin/ » retire ce que l'entrée d'un dossier parent a pris.
function couvertParEntree(chemin, entree) {
  return entree.endsWith("/") ? chemin.startsWith(entree) || `${chemin}/` === entree : chemin === entree;
}
function couvertParFiles(chemin) {
  const retraits = pkg.files.filter((e) => e.startsWith("!")).map((e) => e.slice(1));
  return pkg.files.some((entree) => !entree.startsWith("!") && couvertParEntree(chemin, entree))
    && !retraits.some((retrait) => couvertParEntree(chemin, retrait));
}

// Du bytecode Python : un `.pyc`, ou n'importe quoi sous un `__pycache__/` (C1, FIX-C).
const estDuBytecode = (chemin) => /(^|\/)__pycache__(\/|$)/.test(chemin) || chemin.endsWith(".pyc");

function environnementMinimal(home, supplement = {}) {
  return {
    PATH: process.env.PATH || "",
    HOME: home,
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
    LC_ALL: "C",
    TZ: "UTC",
    ...supplement
  };
}

// npm ne parle à personne pendant ces sondes : pas de notifier de mise à jour,
// pas de fund, pas d'audit, pas de scripts de cycle de vie. Et pas de dry-run
// HÉRITÉ : sous `npm publish --dry-run`, la gate prepublishOnly transmet
// `npm_config_dry_run=true` à ses enfants — un `npm pack` qui l'hérite
// n'écrit rien. Un drapeau explicite en argument (`--dry-run`) garde le
// dernier mot sur l'environnement, donc la sonde dry-run reste un dry-run.
function npm(args, options = {}) {
  return spawnSync("npm", [...args, "--ignore-scripts"], {
    encoding: "utf8",
    cwd: repo,
    env: {
      ...process.env,
      npm_config_dry_run: "false",
      npm_config_update_notifier: "false",
      npm_config_fund: "false",
      npm_config_audit: "false",
      npm_config_loglevel: "error"
    },
    ...options
  });
}

// L'installeur imprime un résumé lisible PUIS un objet JSON indenté : le
// dernier bloc qui commence par « { » en début de ligne est le verdict machine.
function verdictMachine(stdout) {
  const debut = stdout.lastIndexOf("\n{\n");
  assert.ok(debut >= 0, `pas de verdict JSON dans la sortie :\n${stdout.slice(-1500)}`);
  return JSON.parse(stdout.slice(debut + 1));
}

// ── 1. LE MANIFESTE ─────────────────────────────────────────────────────────

test("la version publiée est celle du tag, partout : manifeste, verrou npm, manifeste du plugin, CHANGELOG", () => {
  assert.equal(pkg.version, VERSION_ATTENDUE, "package.json dit la version du tag");

  const verrou = lireJson("package-lock.json");
  assert.equal(verrou.version, VERSION_ATTENDUE, "le verrou npm (racine) suit le manifeste");
  assert.equal(verrou.packages[""].version, VERSION_ATTENDUE, "le verrou npm (packages['']) suit le manifeste");

  const plugin = lireJson(".claude-plugin/plugin.json");
  assert.equal(plugin.version, VERSION_ATTENDUE, "le manifeste du plugin Claude Code suit le manifeste npm");

  const changelog = fs.readFileSync(path.join(repo, "CHANGELOG.md"), "utf8");
  const titres = [...changelog.matchAll(/^## \[([^\]]+)\]/gm)].map((m) => m[1]);
  const premiereRelease = titres.find((t) => t !== "Unreleased");
  assert.equal(premiereRelease, VERSION_ATTENDUE, "la première entrée de release du CHANGELOG est celle de cette version");
  assert.equal(titres.filter((t) => t === "Unreleased").length <= 1, true, "au plus une section Unreleased");
});

// La version que le serveur MCP ANNONCE à ses clients est lue sur le moteur
// qui tourne, pas dans le source : un client se connecte au serveur publié
// (`main`) dans un bureau jetable et lit ce qu'il déclare.
test("le serveur MCP s'annonce à la version du manifeste — une seule vérité, lue sur le serveur qui tourne", async () => {
  const bureau = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-paquet-mcp-"));
  // Le bureau jetable disparaît quoi qu'il arrive — y compris si `connect`
  // jette (serveur qui ne démarre pas) : le nettoyage enveloppe la connexion.
  try {
    const client = new Client({ name: "package-publishable", version: "0.0.0" });
    const transport = new StdioClientTransport({
      command: "node",
      args: [path.join(repo, pkg.main)],
      env: { ...environnementMinimal(bureau), CC2CC_V2_HOME: bureau, CC2CC_SELF: "package-probe" }
    });
    await client.connect(transport);
    try {
      const annonce = client.getServerVersion();
      // Deux noms, un produit : le paquet npm s'appelle `valxos-messenger`
      // (trait d'union, nom public) ; le serveur MCP s'annonce `valxos_messenger`
      // (souligné, un identifiant MCP). Le second n'est donc plus lu dans pkg.name.
      assert.equal(annonce.name, "valxos_messenger", "serverInfo reste l'identifiant choisi le 23/08 (ruling 1), pas le nom npm");
      assert.equal(annonce.version, pkg.version, "la version annoncée est celle du manifeste");
    } finally {
      await client.close();
    }
  } finally {
    fs.rmSync(bureau, { recursive: true, force: true });
  }
});

test("la licence du manifeste est celle du fichier LICENSE et de chaque en-tête SPDX de l'arbre", () => {
  assert.equal(pkg.license, "AGPL-3.0-only");

  const licence = fs.readFileSync(path.join(repo, "LICENSE"), "utf8");
  assert.match(licence, /GNU AFFERO GENERAL PUBLIC LICENSE/, "LICENSE est l'AGPL");
  assert.match(licence, /Version 3, 19 November 2007/, "LICENSE est la version 3");

  // Chaque en-tête SPDX de l'arbre publié dit la même chose que le manifeste.
  const sources = execFileSync("git", ["ls-files", "src", "scripts", "hooks", "skills", "monitors", "docs"], {
    cwd: repo, encoding: "utf8"
  }).split("\n").filter(Boolean);
  const identifiants = new Set();
  let porteurs = 0;
  for (const relatif of sources) {
    if (!/\.(js|mjs|py|css|html|md|json)$/.test(relatif)) continue;
    const texte = fs.readFileSync(path.join(repo, relatif), "utf8");
    const m = /SPDX-License-Identifier:\s*([A-Za-z0-9.+-]+)/.exec(texte);
    if (!m) continue;
    porteurs += 1;
    identifiants.add(m[1]);
  }
  assert.ok(porteurs >= 30, `les en-têtes SPDX existent bien dans l'arbre (${porteurs} porteurs)`);
  assert.deepEqual([...identifiants], [pkg.license], "un seul identifiant SPDX dans l'arbre, celui du manifeste");
});

test("le manifeste porte l'adresse publique du dépôt, ses mots-clefs, l'accès public et la garde de publication", () => {
  assert.deepEqual(pkg.repository, { type: "git", url: `git+${DEPOT_PUBLIC}.git` });
  assert.equal(pkg.homepage, `${DEPOT_PUBLIC}#readme`);
  assert.deepEqual(pkg.bugs, { url: `${DEPOT_PUBLIC}/issues` });
  assert.ok(Array.isArray(pkg.keywords) && pkg.keywords.length >= 6, "des mots-clefs pour être trouvé");
  for (const clef of ["claude-code", "mcp", "valxos-messenger"]) assert.ok(pkg.keywords.includes(clef), `mot-clef ${clef}`);
  assert.ok(typeof pkg.author === "string" && pkg.author.length > 0, "un auteur");
  assert.notEqual(pkg.private, true, "un paquet publiable n'est pas privé");
  assert.deepEqual(pkg.publishConfig, { access: "public" }, "l'accès est public, dit dans le manifeste");
  assert.equal(pkg.scripts.prepublishOnly, "npm test", "aucune publication sans la suite verte");
});

test("engines.node est le plancher du contrat d'exécution : au moins celui de chaque dépendance, satisfait par ce Node", () => {
  assert.ok(pkg.engines && typeof pkg.engines.node === "string", "engines.node est déclaré");
  const plancher = Number(/^>=(\d+)(?:\.\d+)*$/.exec(pkg.engines.node)?.[1]);
  assert.ok(Number.isFinite(plancher), `engines.node est un plancher « >=N » (lu : ${pkg.engines.node})`);

  // Le code de src/ n'exige rien au-delà de Node 16.9 (Object.hasOwn, fs.cpSync,
  // crypto.randomUUID, lstatSync throwIfNoEntry, préfixe node:). La suite
  // elle-même veut node:test (18). Le plancher réel vient des dépendances :
  // better-sqlite3 (module natif) ne publie plus rien sous Node 20.
  assert.ok(plancher >= 18, "au moins Node 18 : node:test et le SDK MCP");
  for (const dependance of Object.keys(pkg.dependencies)) {
    const manifeste = lireJson(path.join("node_modules", dependance, "package.json"));
    const contrat = manifeste.engines?.node;
    if (!contrat) continue;
    const majeurs = [...contrat.matchAll(/(\d+)(?=\.|$|\s|\|)/g)].map((m) => Number(m[1]));
    const plancherDependance = Math.min(...majeurs);
    assert.ok(
      plancher >= plancherDependance,
      `${dependance} exige « ${contrat} » — notre plancher ${plancher} ne peut pas promettre moins`
    );
  }

  const majeurCourant = Number(process.versions.node.split(".")[0]);
  assert.ok(majeurCourant >= plancher, `ce Node (${process.versions.node}) satisfait le plancher qu'il déclare`);

  const verrou = lireJson("package-lock.json");
  assert.deepEqual(verrou.packages[""].engines, pkg.engines, "le verrou npm porte le même plancher");
});

// Les fautes de la liste blanche `files` pour une racine donnée. Une entrée
// POSITIVE existe, et un dossier se nomme avec sa barre. Un retrait « ! » vise
// l'intérieur d'une entrée prise, mais il n'a PAS à exister : une exclusion
// d'un chemin absent est inoffensive, et le miroir public n'a ni docs/runbooks/
// ni docs/superpowers/ — l'export les retire (verdict du 18/10 : ce test
// rougissait sur l'arbre public exact, et `prepublishOnly` le rejoue). Quand un
// retrait existe, la règle de la barre le tient quand même.
//
// DEUX RÈGLES DE PLUS (FIX-C, 18/10), mesurées sur npm 11 avec un faux
// `.pyc` : un retrait GLOBAL (`!**/…`) vise l'intérieur de TOUTES les entrées
// prises, et n'a donc pas de mère ; et npm applique le DERNIER motif qui
// correspond — un retrait posé AVANT une entrée qu'il vise ne l'atteint pas
// (`["src/", "!**/*.pyc", "scripts/"]` laissait partir scripts/__pycache__/).
// Un retrait vient donc après chaque entrée qu'il vise.
function fautesDeFiles(files, racine) {
  const fautes = [];
  const prises = files.map((e, rang) => ({ e, rang })).filter(({ e }) => !e.startsWith("!"));
  files.forEach((brute, rang) => {
    const retrait = brute.startsWith("!");
    const entree = brute.replace(/^!/, "");
    const global = retrait && entree.startsWith("**/");
    const meres = prises.filter(({ e }) => e.endsWith("/") && entree.startsWith(e));
    if (retrait && !global && meres.length === 0) {
      fautes.push(`le retrait « ${brute} » vise l'intérieur d'une entrée de files`);
    }
    if (retrait) {
      const visees = global ? prises : meres;
      const apres = visees.find(({ rang: rangVise }) => rangVise > rang);
      if (apres) {
        fautes.push(`le retrait « ${brute} » précède « ${apres.e} » : npm applique le dernier motif qui correspond, un retrait vient après chaque entrée qu'il vise`);
      }
    }
    const surDisque = path.join(racine, entree.replace(/\/$/, ""));
    if (!fs.existsSync(surDisque)) {
      if (!retrait) fautes.push(`files nomme « ${entree} » qui n'existe pas dans l'arbre`);
      return;
    }
    if (fs.statSync(surDisque).isDirectory() !== entree.endsWith("/")) {
      fautes.push(`« ${entree} » : un dossier se nomme avec sa barre, un fichier sans`);
    }
  });
  return fautes;
}

test("`files` : une exclusion d'un chemin absent est valide, une entrée prise absente ne l'est pas", (t) => {
  const racine = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-files-"));
  t.after(() => fs.rmSync(racine, { recursive: true, force: true }));
  fs.mkdirSync(path.join(racine, "docs"));
  fs.writeFileSync(path.join(racine, "README.md"), "x");
  // L'arbre du miroir public : docs/ existe, ni docs/runbooks/ ni docs/superpowers/.
  assert.deepEqual(fautesDeFiles(["docs/", "!docs/runbooks/", "!docs/superpowers/", "README.md"], racine), []);
  // Une entrée prise qui manque reste une faute, dossier ou fichier.
  assert.deepEqual(fautesDeFiles(["docs/", "src/", "LICENSE"], racine), [
    "files nomme « src/ » qui n'existe pas dans l'arbre",
    "files nomme « LICENSE » qui n'existe pas dans l'arbre"
  ]);
  // Un retrait qui existe garde la règle de la barre ; un retrait sans entrée mère reste une faute.
  fs.mkdirSync(path.join(racine, "docs", "runbooks"));
  assert.deepEqual(fautesDeFiles(["docs/", "!docs/runbooks"], racine), ["« docs/runbooks » : un dossier se nomme avec sa barre, un fichier sans"]);
  assert.deepEqual(fautesDeFiles(["README.md", "!docs/runbooks/"], racine), ["le retrait « !docs/runbooks/ » vise l'intérieur d'une entrée de files"]);

  // Un retrait global n'a pas de mère, mais il vient APRÈS toutes les entrées prises : npm applique
  // le dernier motif qui correspond (mesuré, npm 11). Le retrait local obéit à la même règle.
  fs.mkdirSync(path.join(racine, "src"));
  assert.deepEqual(fautesDeFiles(["docs/", "src/", "README.md", "!**/__pycache__/", "!**/*.pyc"], racine), []);
  assert.deepEqual(fautesDeFiles(["src/", "!**/*.pyc", "docs/"], racine), [
    "le retrait « !**/*.pyc » précède « docs/ » : npm applique le dernier motif qui correspond, un retrait vient après chaque entrée qu'il vise"
  ]);
  assert.deepEqual(fautesDeFiles(["!docs/runbooks/", "docs/"], racine), [
    "le retrait « !docs/runbooks/ » précède « docs/ » : npm applique le dernier motif qui correspond, un retrait vient après chaque entrée qu'il vise"
  ], "un retrait local posé avant sa mère est une faute d'ordre");
});

test("la liste blanche `files` ne nomme que ce qui existe et doit partir, et couvre chaque point d'entrée publié", () => {
  assert.ok(Array.isArray(pkg.files) && pkg.files.length > 0, "files est une liste blanche explicite");

  assert.deepEqual(fautesDeFiles(pkg.files, repo), [], "la liste blanche `files` est conforme");
  for (const requis of FICHIERS_REQUIS) assert.ok(pkg.files.includes(requis), `« ${requis} » doit partir`);
  for (const entree of pkg.files) {
    for (const interdit of PREFIXES_INTERDITS) assert.ok(!entree.startsWith(interdit), `« ${entree} » n'a rien à faire dans le paquet`);
    assert.ok(!FICHIERS_INTERDITS.includes(entree), `« ${entree} » n'a rien à faire dans le paquet`);
  }

  // Chaque chemin que le paquet PROMET est couvert par la liste blanche.
  const promis = new Set([pkg.main, ...Object.values(pkg.bin)]);
  const plugin = lireJson(".claude-plugin/plugin.json");
  for (const clef of ["hooks", "mcpServers", "skills"]) promis.add(plugin[clef].replace(/^\.\//, ""));
  promis.add(plugin.experimental.monitors.replace(/^\.\//, ""));
  const racineDuPlugin = (commande) => /\$\{CLAUDE_PLUGIN_ROOT\}\/([^"\s]+)/.exec(commande)?.[1];
  for (const evenements of Object.values(lireJson("hooks/hooks.json").hooks))
    for (const { hooks } of evenements) for (const { command } of hooks) promis.add(racineDuPlugin(command));
  for (const { command } of lireJson("monitors/monitors.json")) promis.add(racineDuPlugin(command));
  for (const { args } of Object.values(lireJson("mcp.json").mcpServers)) promis.add(racineDuPlugin(args.join(" ")));
  for (const chemin of promis) {
    assert.ok(chemin, "chaque promesse du plugin se lit");
    assert.ok(fs.existsSync(path.join(repo, chemin)), `promis mais absent de l'arbre : ${chemin}`);
    assert.ok(couvertParFiles(chemin), `promis mais hors de la liste blanche files : ${chemin}`);
  }
});

// ── 2. LES COMMANDES ────────────────────────────────────────────────────────

test("chaque commande de `bin` existe, porte son shebang, et est exécutable dans l'index git", () => {
  const cibles = [...new Set(Object.values(pkg.bin))];
  assert.equal(Object.keys(pkg.bin).length, 22, "22 points d'entrée publiés (README)");

  const index = spawnSync("git", ["ls-files", "-s", "--", ...cibles], { cwd: repo, encoding: "utf8" });
  const modes = new Map();
  if (index.status === 0) {
    for (const ligne of index.stdout.split("\n").filter(Boolean)) {
      const [mode, , , chemin] = ligne.split(/\s+/);
      modes.set(chemin, mode);
    }
  }

  for (const [nom, cible] of Object.entries(pkg.bin)) {
    const absolu = path.join(repo, cible);
    assert.ok(fs.existsSync(absolu), `bin.${nom} → ${cible} n'existe pas`);
    const premiereLigne = fs.readFileSync(absolu, "utf8").split("\n")[0];
    const shebang = cible.endsWith(".py") ? "#!/usr/bin/env python3" : "#!/usr/bin/env node";
    assert.equal(premiereLigne, shebang, `bin.${nom} → ${cible} commence par son shebang`);

    if (index.status === 0) {
      assert.equal(modes.get(cible), "100755", `bin.${nom} → ${cible} est exécutable dans git (mode 100755)`);
    } else {
      // Pas de git ici (tarball extrait, dépôt absent) : le disque est la seule
      // preuve disponible, et elle est dite comme telle.
      assert.ok(fs.statSync(absolu).mode & 0o111, `bin.${nom} → ${cible} est exécutable sur disque (git indisponible)`);
    }
  }
  assert.ok(fs.existsSync(path.join(repo, pkg.main)), "main existe");
});

// Le paquet s'appelle `valxos-messenger` depuis le Run 6 (Task 10), comme son
// bin principal : `npx valxos-messenger install` trouverait donc le paquet.
// La forme documentée reste explicite et nomme le paquet — elle ne dépend pas
// de la coïncidence entre nom de paquet et nom de bin (l'ancien nom souligné
// `valxos_messenger` rendait la forme courte E404, rev-t3) :
// `npx --package valxos-messenger valxos-messenger …`.
// La garde lit chaque invocation `npx` des documents publiés (les READMEs et
// docs/, qui partent dans le tarball).
test("chaque `npx` des documents publiés nomme le paquet (--package), un bin qui existe, et autorise le script de better-sqlite3", () => {
  const documents = [
    "README.md", "README.fr.md",
    ...fs.readdirSync(path.join(repo, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`)
  ];
  const invocations = [];
  for (const document of documents) {
    const lignes = fs.readFileSync(path.join(repo, document), "utf8").split("\n");
    lignes.forEach((ligne, i) => {
      for (const m of ligne.matchAll(/\bnpx\s+([^`]+)/g)) {
        invocations.push({ ou: `${document}:${i + 1}`, tokens: m[1].trim().split(/\s+/) });
      }
    });
  }
  assert.ok(invocations.length >= 3, `les documents publiés montrent l'installeur un-clic par npx (${invocations.length} invocations vues)`);
  for (const { ou, tokens: brut } of invocations) {
    // N3 (seconde passe adverse, 28/09) : npm 12 bloque les scripts
    // d'installation des dépendances ; better-sqlite3 a besoin du sien (le
    // binaire précompilé). Chaque npx le porte, AVANT le bin (un drapeau après
    // le bin irait au programme, pas à npm).
    const autorise = brut.indexOf("--allow-scripts=better-sqlite3");
    assert.ok(autorise >= 0 && autorise < 3, `${ou} : l'invocation npx porte --allow-scripts=better-sqlite3 avant le bin`);
    const tokens = brut.filter((tok, i) => i !== autorise);
    assert.equal(tokens[0], "--package", `${ou} : une invocation npx vise le registre, elle nomme le paquet (--package) — sinon npx cherche un paquet au nom du bin : E404`);
    assert.equal(tokens[1], pkg.name, `${ou} : le paquet nommé est celui du manifeste`);
    assert.ok(Object.hasOwn(pkg.bin, tokens[2]), `${ou} : « ${tokens[2]} » est un bin publié`);
  }
});

// ── 3. LE TARBALL ───────────────────────────────────────────────────────────

test("npm pack --dry-run emporte le serveur, chaque commande, les docs et le plugin — et rien de l'atelier", (t) => {
  const depart = Date.now();
  const sec = npm(["pack", "--dry-run", "--json"]);
  // La durée se LIT (≈ 0,5 s seul, quelques secondes sous la suite entière) ;
  // elle ne gate pas — une horloge dans une gate rougit sur une machine lente.
  t.diagnostic(`npm pack --dry-run : ${Date.now() - depart} ms`);
  assert.equal(sec.status, 0, `npm pack --dry-run a échoué :\n${sec.stderr}`);

  const [tarball] = JSON.parse(sec.stdout);
  assert.equal(tarball.name, pkg.name);
  assert.equal(tarball.version, pkg.version);
  assert.equal(tarball.filename, `${pkg.name}-${pkg.version}.tgz`);
  assert.ok(!fs.existsSync(path.join(repo, tarball.filename)), "un dry-run n'écrit aucun tarball dans le dépôt");
  const chemins = tarball.files.map((f) => f.path);
  assert.equal(tarball.entryCount, chemins.length);

  const attendus = [
    pkg.main,
    ...new Set(Object.values(pkg.bin)),
    "package.json", "README.md", "README.fr.md", "LICENSE", "CHANGELOG.md",
    "docs/FACTEUR.md", "docs/INSTALL_ONE_CLICK.md",
    ".claude-plugin/plugin.json", "hooks/hooks.json", "monitors/monitors.json", "mcp.json",
    "skills/chaise/SKILL.md", "skills/messaging/SKILL.md",
    "src/hooks/startup_sync.js", "src/hooks/piggyback_fetch.js", "src/hooks/safety_net_poll.js",
    "src/web/serveur.js", "src/web/public/index.html"
  ];
  for (const attendu of attendus) assert.ok(chemins.includes(attendu), `le tarball emporte ${attendu}`);

  for (const chemin of chemins) {
    for (const interdit of PREFIXES_INTERDITS) assert.ok(!chemin.startsWith(interdit), `le tarball emporte l'atelier : ${chemin}`);
    assert.ok(!FICHIERS_INTERDITS.includes(chemin), `le tarball emporte ${chemin}`);
    assert.ok(!estDuBytecode(chemin), `le tarball emporte du bytecode Python : ${chemin}`);
    assert.ok(fs.existsSync(path.join(repo, chemin)), `le tarball nomme un fichier absent : ${chemin}`);
  }
});

// C1 (re-revue de la vague finale, 18/10) — AUCUN BYTECODE PYTHON NE PART DANS
// LE PAQUET. Le moniteur est un script Python lancé depuis l'arbre : tout ce qui
// l'importe écrit `src/monitor/__pycache__/*.pyc`, qui porte le chemin absolu de
// la source — donc le nom du compte — et des octets NUL. `files` prend `src/`
// en entier, et le `.gitignore` de la racine ne protège PAS npm quand `files`
// existe (mesuré, npm 11 : le .pyc part, `__pycache__/` fût-il ignoré par git).
// Or `prepublishOnly` lance la suite juste avant le `pack` : un seul import du
// moniteur dans la suite, et le paquet part avec.
//
// L'épreuve est sur UNE COPIE de l'arbre que `files` prend, où l'on POSE du
// faux bytecode sous chaque entrée prise — pas seulement sous src/. Le témoin
// vient d'abord : le même manifeste SANS les retraits le laisse partir, sinon
// la sonde ne voit rien et ce test ne prouverait rien (sonde impossible). Puis
// le vrai manifeste : rien de ce qui est posé ne part, et la liste du paquet
// est celle du vrai arbre.

test("C1 — aucun bytecode Python ne part dans le paquet, où qu'il soit posé sous une entrée de `files`", (t) => {
  const atelier = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-bytecode-"));
  t.after(() => fs.rmSync(atelier, { recursive: true, force: true }));
  const copie = path.join(atelier, "copie");
  fs.mkdirSync(copie);

  // L'arbre que `files` prend, rien d'autre : ni node_modules, ni .git, ni le banc. Le .gitignore
  // vient avec — c'est lui qui, à tort, passerait pour une protection.
  fs.copyFileSync(path.join(repo, "package.json"), path.join(copie, "package.json"));
  fs.copyFileSync(path.join(repo, ".gitignore"), path.join(copie, ".gitignore"));
  for (const entree of pkg.files.filter((e) => !e.startsWith("!"))) {
    fs.cpSync(path.join(repo, entree), path.join(copie, entree), { recursive: true });
  }
  assert.match(fs.readFileSync(path.join(copie, ".gitignore"), "utf8"), /^__pycache__\/$/m, "le .gitignore de la copie ignore déjà __pycache__/ : c'est lui que npm ne lit pas");

  // Du faux bytecode sous chaque dossier pris, et deux .pyc isolés.
  const octets = Buffer.from("\0\0\0\0faux bytecode, sans chemin de compte\0");
  const poses = [
    "src/monitor/__pycache__/valxos_monitor.cpython-314.pyc",
    "src/__pycache__/autre.cpython-314.pyc",
    "scripts/__pycache__/install.cpython-314.pyc",
    "docs/__pycache__/x.cpython-314.pyc",
    ".claude-plugin/__pycache__/x.cpython-314.pyc",
    "skills/chaise/__pycache__/x.cpython-314.pyc",
    "hooks/__pycache__/x.cpython-314.pyc",
    "monitors/__pycache__/x.cpython-314.pyc",
    "src/isole.pyc",
    "docs/isole.pyc"
  ];
  for (const relatif of poses) {
    fs.mkdirSync(path.join(copie, path.dirname(relatif)), { recursive: true });
    fs.writeFileSync(path.join(copie, relatif), octets);
  }

  const cheminsDuPaquet = (racine) => {
    const sortie = npm(["pack", "--dry-run", "--json"], { cwd: racine });
    assert.equal(sortie.status, 0, `npm pack --dry-run a échoué dans ${racine} :\n${sortie.stderr}`);
    return JSON.parse(sortie.stdout)[0].files.map((f) => f.path);
  };

  // Le témoin : le manifeste sans ses retraits de bytecode.
  const manifeste = fs.readFileSync(path.join(copie, "package.json"), "utf8");
  const sansRetrait = { ...pkg, files: pkg.files.filter((e) => !/__pycache__|\.pyc$/.test(e)) };
  fs.writeFileSync(path.join(copie, "package.json"), JSON.stringify(sansRetrait, null, 2));
  const temoin = cheminsDuPaquet(copie);
  for (const relatif of poses) {
    assert.ok(temoin.includes(relatif), `sonde impossible : sans retrait, ${relatif} aurait dû partir — la sonde ne voit pas ce qu'elle cherche`);
  }

  // Le vrai manifeste.
  fs.writeFileSync(path.join(copie, "package.json"), manifeste);
  const emportes = cheminsDuPaquet(copie);
  assert.deepEqual(emportes.filter(estDuBytecode), [], "du bytecode part dans le paquet");
  assert.deepEqual([...emportes].sort(), [...cheminsDuPaquet(repo)].sort(), "la copie, bytecode posé, donne le paquet du vrai arbre");
});

test("le point d'entrée un-clic s'exécute depuis un tarball extrait — avec et sans CLAUDE_CONFIG_DIR — sans écrire dans le faux HOME", (t) => {
  const atelier = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-paquet-"));
  t.after(() => fs.rmSync(atelier, { recursive: true, force: true }));

  const pack = npm(["pack", "--json", "--pack-destination", atelier]);
  assert.equal(pack.status, 0, `npm pack a échoué :\n${pack.stderr}`);
  const [{ filename }] = JSON.parse(pack.stdout);
  const tarball = path.join(atelier, filename);
  assert.ok(fs.existsSync(tarball), "le tarball est écrit dans l'atelier jetable");

  const extrait = path.join(atelier, "extrait");
  fs.mkdirSync(extrait);
  execFileSync("tar", ["-xzf", tarball, "-C", extrait]);
  const paquet = path.join(extrait, "package");
  assert.ok(fs.existsSync(path.join(paquet, "scripts", "install.js")), "l'installeur est dans le tarball");
  assert.ok(!fs.existsSync(path.join(paquet, "node_modules")), "un tarball n'embarque pas node_modules");

  const variantes = [
    ["avec CLAUDE_CONFIG_DIR", (home) => ({ CLAUDE_CONFIG_DIR: path.join(home, "claude") })],
    ["sans CLAUDE_CONFIG_DIR", () => ({})]
  ];
  for (const [nom, supplement] of variantes) {
    const home = fs.mkdtempSync(path.join(atelier, "home-"));
    const env = environnementMinimal(home, supplement(home));
    const sonde = spawnSync("node", [path.join(paquet, "src/bin/valxos-messenger.js"), "install", "--dry-run"], {
      encoding: "utf8", cwd: atelier, env
    });
    assert.equal(sonde.status, 0, `${nom} : le dry-run sort en erreur\n${sonde.stderr}\n${sonde.stdout.slice(-800)}`);
    assert.match(sonde.stdout, /\[DRY RUN\] Installing valxos-messenger/, `${nom} : le dry-run s'annonce`);

    const verdict = verdictMachine(sonde.stdout);
    assert.equal(verdict.ok, true, `${nom} : le cœur de l'installation serait vert`);
    assert.equal(verdict.mode, "dry-run", `${nom} : le mode est dit`);
    assert.equal(fs.realpathSync(verdict.repo), fs.realpathSync(paquet), `${nom} : l'installeur travaille depuis le paquet extrait, pas depuis le dépôt`);
    assert.equal(verdict.cliLinks.length, 22, `${nom} : les 22 commandes seraient liées`);
    for (const lien of verdict.cliLinks) {
      assert.ok(lien.link.startsWith(home), `${nom} : le lien ${lien.name} viserait le faux HOME`);
      assert.ok(fs.existsSync(lien.source), `${nom} : la source du lien ${lien.name} existe dans le paquet`);
    }
    assert.ok(verdict.pluginTarget.startsWith(home), `${nom} : le plugin viserait le faux HOME`);

    // Un dry-run n'écrit RIEN — pas un dossier, pas un lien, pas une fiche.
    assert.deepEqual(fs.readdirSync(home), [], `${nom} : le faux HOME est resté vide`);
  }
});

// Sous `npm publish --dry-run`, la gate `prepublishOnly` → `npm test` hérite
// `npm_config_dry_run=true` : un `npm pack` imbriqué devient lui-même un
// dry-run, n'écrit aucun tarball, et la preuve ci-dessus rougit — la gate
// casse sa propre publication d'essai (rev-t3). Le helper `npm()` neutralise
// l'héritage ; ce test le rejoue avec l'environnement d'une telle gate.
test("un dry-run hérité de `npm publish --dry-run` n'empêche pas la preuve d'écrire son tarball", () => {
  const atelier = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-paquet-herite-"));
  const avant = process.env.npm_config_dry_run;
  process.env.npm_config_dry_run = "true";
  try {
    const pack = npm(["pack", "--json", "--pack-destination", atelier]);
    assert.equal(pack.status, 0, `npm pack a échoué :\n${pack.stderr}`);
    const [{ filename }] = JSON.parse(pack.stdout);
    assert.ok(fs.existsSync(path.join(atelier, filename)), "le tarball est écrit malgré npm_config_dry_run=true hérité");
  } finally {
    if (avant === undefined) delete process.env.npm_config_dry_run;
    else process.env.npm_config_dry_run = avant;
    fs.rmSync(atelier, { recursive: true, force: true });
  }
});

// Le manifeste du plugin va dans `$CLAUDE_CONFIG_DIR/skills` quand le lanceur
// pose cette variable (rc2, « une machine peut héberger plusieurs maisons »).
// L'installeur faisait bien le `mkdir` là — mais `pluginTargetPath()`
// (config.js) posait encore le lien sous `~/.claude/skills`. Constaté ici en
// `todo`, corrigé depuis : `claudeHomeDir()` (config.js) est la règle unique du
// dossier, du lien, du résumé, de l'uninstall et du doctor
// (test/install-cli.test.js en prouve chaque face). Le verrou reste.
test("sous CLAUDE_CONFIG_DIR, le lien du plugin suit la maison désignée", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-maison-"));
  const maison = path.join(home, "claude");
  const sonde = spawnSync("node", [path.join(repo, "scripts/install.js"), "--dry-run"], {
    encoding: "utf8", cwd: repo, env: environnementMinimal(home, { CLAUDE_CONFIG_DIR: maison })
  });
  fs.rmSync(home, { recursive: true, force: true });
  assert.equal(sonde.status, 0, sonde.stderr);
  assert.ok(verdictMachine(sonde.stdout).pluginTarget.startsWith(maison), "le lien du plugin vise la maison désignée");
});

// I3 (revue finale, 28/09) — LE CHANGELOG QUI PART DANS LE TARBALL DÉCRIT CE
// CODE-CI. Il disait « 1.0.0 = rc.3 inchangé », gardait tout le Run 6 sous
// [Unreleased], comptait neuf `cc2cc-*` et appelait `valxos_messenger` le nom
// public.
test("I3 — le [1.0.0] du CHANGELOG décrit ce code ; aucune entrée [Unreleased] en attente ; l'histoire des noms est juste", () => {
  const changelog = fs.readFileSync(path.join(repo, "CHANGELOG.md"), "utf8");
  const unreleased = changelog.match(/^## \[Unreleased\]\n([\s\S]*?)(?=^## \[)/m);
  assert.ok(!unreleased || unreleased[1].trim() === "", "aucune entrée ne reste sous [Unreleased] au moment de publier");
  const debut = changelog.indexOf("## [1.0.0]");
  const fin = changelog.indexOf("\n## [", debut + 1);
  const entree = changelog.slice(debut, fin);
  assert.doesNotMatch(entree, /promoted unchanged/, "1.0.0 n'est pas rc.3 inchangé");
  for (const fait of ["--allow-scripts=better-sqlite3", "valxos-messenger@skills-dir", "ten `cc2cc-*`", "moissonner", "print-disabled", "Known limitations"]) {
    assert.ok(entree.includes(fait), `le [1.0.0] dit : ${fait}`);
  }
  assert.doesNotMatch(changelog, /valxos_messenger\*\* — the public product name/, "valxos_messenger est l'identifiant du serveur MCP, pas le nom public");
  assert.doesNotMatch(changelog, /nine `cc2cc-\*`/);
});

// Première release publique (18/10) — le [1.0.0] porte la date de la
// publication, pas celle du run privé du 28/09, et son chapeau dit l'histoire
// privée UNE fois : le dépôt public commence à cette release. Les lignes des
// changements du run de publication (alwaysLoad, --exclude, README) y sont.
test("le [1.0.0] du CHANGELOG est daté du 2026-10-18, aucun [Unreleased] ne le précède, le chapeau dit l'histoire privée une fois", () => {
  const changelog = fs.readFileSync(path.join(repo, "CHANGELOG.md"), "utf8");
  assert.match(changelog, /^## \[1\.0\.0\] — 2026-10-18$/m, "l'en-tête est exactement « ## [1.0.0] — 2026-10-18 »");
  assert.equal([...changelog.matchAll(/^## \[1\.0\.0\]/gm)].length, 1, "un seul en-tête [1.0.0] : une release, un arbre");

  const debut = changelog.indexOf("## [1.0.0] — 2026-10-18");
  assert.ok(debut >= 0);
  const avant = changelog.slice(0, debut);
  const unreleased = avant.match(/^## \[Unreleased\]\n([\s\S]*)$/m);
  assert.ok(!unreleased || unreleased[1].trim() === "", "aucune section [Unreleased] non vide ne précède le [1.0.0]");

  const fin = changelog.indexOf("\n## [", debut + 1);
  const entree = changelog.slice(debut, fin);
  const chapeau = entree.split("\n### ")[0].replace(/\s+/g, " ");
  for (const fait of [
    "First public release, on npm and on `https://github.com/valx-vex/valxos-messenger`",
    "The commits and tags before this one are private and stay in the private repository",
    "1.0.0-rc.1 to rc.3 were cut on 26–29 August 2026",
    "rc.3 was tagged 1.0.0 in the private repository on 26 September, unchanged and never published",
    "(\"VALXOS Messenger partout\", everywhere)",
    "the publication run of 18 October",
    "The public repository starts at this release"
  ]) {
    assert.ok(chapeau.includes(fait), `le chapeau du [1.0.0] dit : ${fait}`);
  }

  const normalise = entree.replace(/\s+/g, " ");
  for (const fait of [
    "_meta['anthropic/alwaysLoad']",
    "tools/export-public.js --exclude <prefix>",
    "docs/runbooks/",
    "Antigravity CLI (agy)",
    "only Claude Code sessions are woken by the Facteur",
    "MCP_PROTOCOL_NEGOTIATION=legacy",
    "deferred-tools behaviour",
    "npm pack --ignore-scripts",
    "under Claude Code's Monitor deadline (2.1.271)"
  ]) {
    assert.ok(normalise.includes(fait), `le [1.0.0] dit : ${fait}`);
  }
});

// La vague finale du 18/10 : le [1.0.0] porte une section Added et une section
// Fixed, les lignes exactes de la vague, et le complément de la ligne des
// commentaires (la garde des noms privés reste hors de l'arbre public). L'ordre
// des sections est celui de Keep a Changelog.
test("le [1.0.0] du CHANGELOG dit la vague finale : Added, Fixed, et la garde privée hors de l'arbre public", () => {
  const changelog = fs.readFileSync(path.join(repo, "CHANGELOG.md"), "utf8");
  const debut = changelog.indexOf("## [1.0.0] — 2026-10-18");
  const fin = changelog.indexOf("\n## [", debut + 1);
  assert.ok(debut >= 0 && fin > debut, "sonde impossible : le [1.0.0] est introuvable");
  const parSection = new Map(changelog.slice(debut, fin).split(/\n### /).slice(1).map((s) => {
    const [titre, ...reste] = s.split("\n");
    return [titre.trim(), reste.join("\n").replace(/\s+/g, " ")];
  }));
  assert.deepEqual([...parSection.keys()], ["Added", "Changed", "Deprecated", "Fixed", "Known limitations"], "les sections du [1.0.0], dans l'ordre de Keep a Changelog");
  assert.ok(
    parSection.get("Added").includes("`valxos-inbox --ack <msg_id>` acknowledges a letter from the CLI, with the same guards as the MCP `ack` tool."),
    "Added : l'accusé de la CLI"
  );
  assert.ok(
    parSection.get("Changed").includes("`docs/QUARANTAINE.md` stays in the repository and leaves the npm package; the private-name guard itself stays out of the public tree."),
    "Changed : la garde des noms privés reste hors de l'arbre public"
  );
  for (const ligne of [
    "`valxos-messenger install` creates the office (`~/.valxos-messenger`, or the one `VALXOS_MESSENGER_HOME` names) so the doctor that follows has one to read.",
    "`tools/export-public.js` applies the exclusions listed in `.export-exclude` by default.",
    "The Stop hook's reason frames the letter excerpt as untrusted text."
  ]) assert.ok(parSection.get("Changed").includes(ligne), `Changed : ${ligne.slice(0, 60)}…`);
  for (const ligne of [
    "Web door: the composer's default destination counts chairs in service again (`chaises` was dropped when a mailbox was normalised; the default fell back to alphabetical order).",
    "`valxos-web`, `valxos-migrate-home` and `valxos-monitor` answer `-h`/`--help` and refuse unknown flags before opening anything.",
    "`valxos-messenger doctor` passes its flags to `valxos-doctor` (`--reap` was silently dropped).",
    "`valxos-doctor` creates nothing: without an office it reports `dbExists: false`.",
    "`uninstall` removes only the CLI links that point at this package's own `bin` targets; a same-named link to anything else is kept and listed.",
    "`uninstall` no longer advises `--force` for a CLI path that is not a symlink; it leaves it in place.",
    "The Python monitor creates the office directories `0700`, like the Node side, and its own files private (`0600`).",
    "The web door serves its page from a path that contains a space.",
    "The web door tightens an existing `web.env` to `0600` when it loads it.",
    "A forged opening `<cross-session-message` tag in a letter body is neutralised like the closing one; the context header says letters are untrusted text.",
    "MCP `send` and `valxos-send` with a declared sender set to the caller's own human address or old name post the letter once (it was posted twice, then refused).",
    "The npm package never carries Python bytecode (`__pycache__/`), which held absolute source paths.",
    "Long help and error texts are no longer cut when piped (`valxos-chaise -h | less`)."
  ]) assert.ok(parSection.get("Fixed").includes(ligne), `Fixed : ${ligne.slice(0, 60)}…`);
});
