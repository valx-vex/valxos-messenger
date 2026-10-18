// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { FORMES_PRIVEES, identitesDeCetteMachine, modeCI } from "./aide-identites.js";
import { fautesDansLesFichiers, lignesFautives, motifAdresseEnDur, motifsDansTest, motifsDesNoms, nomsDeLaMaison } from "./aide-noms-maison.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { formatAdditionalContext } from "../src/lib/format.js";
import { envPropre, poserLeBureau } from "./aide-env.js";

const repo = path.resolve(new URL("..", import.meta.url).pathname);

// B1 — le rebrand des surfaces VISIBLES : le produit s'appelle VALXOS Messenger.
// Run 6 (Task 11) a déplacé l'identifiant du plugin, la clef mcp.json, le
// moniteur et les skills vers `valxos-messenger` ; les variables d'env
// CC2CC_*, le CC2CC_EVENT du moniteur et les noms de fil restent. L'ancien nom
// reste dit sur les surfaces de continuité (« formerly ») : une personne qui
// cherche cc2cc-v2 ou CEREAL doit retrouver le produit sans que ces
// identifiants redeviennent sa marque visible.

test("le serveur MCP porte l'IDENTIFIANT en clef et le NOM en prose — et l'ancien nom reste dit", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-v2-surfaces-"));
  const client = new Client({ name: "surfaces-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(repo, "src/mcp-server/server.js")],
    env: { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_SELF: "surfaces-probe" }
  });
  await client.connect(transport);
  try {
    assert.equal(client.getServerVersion().name, "valxos_messenger");
    const instructions = client.getInstructions() || "";
    assert.match(instructions, /VALXOS Messenger/);
    assert.match(instructions, /cc2cc-v2/i, "l'identifiant historique reste nommé dans les instructions");
    assert.doesNotMatch(instructions, /server id cc2cc-v2/, "cc2cc-v2 n'est plus l'identifiant du serveur (Task 11) — seulement « formerly »");
    assert.match(instructions, /CEREAL/, "l'ancien nom de produit reste nommé dans les instructions");
    const tools = await client.listTools();
    assert.ok(tools.tools.length >= 8, "le serveur expose ses outils");
    // LES DEUX REGISTRES, ET CHACUN À SA PLACE : le champ `name` du serveur est
    // une CLEF (les clients s'en servent pour le retrouver) — il porte
    // l'identifiant. Les descriptions sont de la PROSE, lue par un humain ou par
    // un modèle — elles portent le nom. Exiger l'identifiant dans une phrase
    // anglaise a effacé le fronton validé de la porte web : on ne recommence pas.
    for (const outil of tools.tools) {
      assert.match(
        outil.description || "",
        /VALXOS Messenger/,
        `la description de ${outil.name} annonce le produit par son NOM (la prose, pas la clef)`
      );
    }
  } finally {
    await client.close();
  }
});

// A1 (revue de l'inconnu, 18/10) — LE SERVEUR DIT D'OÙ VIENT LE NOM. Les
// instructions annoncées à chaque client disaient « Use register to set your
// agent name », et la skill « Register your identity with `register` ». Faux :
// `register` écrit une fiche pour un nom ; le nom qui relève et accuse vient de
// VALXOS_SELF (ou VALXOS_SESSION_NAME), dans l'environnement qui lance le
// serveur. Un client qui suivait l'instruction s'enregistrait sous un nom,
// écrivait à ce nom, et ne trouvait jamais sa lettre : le serveur trompait
// l'inconnu par sa propre surface. Précision des réfutateurs : `register` ne
// renomme pas la session en cours, mais une session Claude Code SANS nom,
// lancée plus tard dans le même dossier, peut prendre le nom d'une fiche
// enregistrée là (les hooks retombent sur la fiche la plus récente du dossier) :
// la skill le dit, et l'oracle plus bas le prouve.
const PHRASE_DU_NOM = "Your name comes from VALXOS_SELF (or VALXOS_SESSION_NAME) in the environment that starts this server; whoami shows it. register writes a peer card for a name; it does not rename this session.";
const PHRASE_DE_LA_SKILL = `${PHRASE_DU_NOM} An unnamed Claude Code session started later in the same directory may take the name of a card registered there; set VALXOS_SELF rather than relying on it.`;

test("A1 — les instructions du serveur et la skill disent d'où vient le nom, et register ne change pas qui parle", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-a1-"));
  const client = new Client({ name: "a1-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(repo, "src/mcp-server/server.js")],
    env: { ...envPropre(), CC2CC_V2_HOME: root, VALXOS_SELF: "a1-sonde" }
  });
  await client.connect(transport);
  try {
    const instructions = client.getInstructions() || "";
    assert.ok(instructions.includes(PHRASE_DU_NOM), "les instructions disent d'où vient le nom");
    assert.doesNotMatch(instructions, /register to set your agent name/i, "register ne fixe plus l'identité dans les instructions");
    // La phrase est vraie : l'oracle est le serveur qui tourne, pas la prose.
    const quiParle = async () => JSON.parse((await client.callTool({ name: "whoami", arguments: {} })).content[0].text).id;
    assert.equal(await quiParle(), "a1-sonde", "le nom vient de VALXOS_SELF, dans l'environnement du serveur");
    const enregistre = JSON.parse((await client.callTool({ name: "register", arguments: { id: "a1-un-autre" } })).content[0].text);
    assert.equal(enregistre.registered, true, "register pose bien une fiche pour l'autre nom");
    assert.equal(await quiParle(), "a1-sonde", "register écrit une fiche pour un nom ; il ne renomme pas la session");
  } finally {
    await client.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
  const skill = fs.readFileSync(path.join(repo, "skills/messaging/SKILL.md"), "utf8");
  assert.ok(skill.includes(PHRASE_DE_LA_SKILL), "la skill dit la même chose que le serveur, et ce que les hooks font sans nom posé");
  assert.doesNotMatch(skill, /Register your identity/i, "la skill ne dit plus que register donne l'identité");
});

test("A1 — l'oracle de la skill : sans nom dans l'environnement, les hooks reprennent le nom de la fiche la plus récente du même dossier", async () => {
  const root = poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "valxos-a1-dossier-")));
  const { openDatabase, registerPeer } = await import("../src/lib/database.js");
  const { resolveSelfId } = await import("../src/lib/identity.js");
  const CLEFS = ["VALXOS_SELF", "CC2CC_SELF", "VALXOS_SESSION_NAME", "CC2CC_SESSION_NAME"];
  const avant = Object.fromEntries(CLEFS.map((clef) => [clef, process.env[clef]]));
  const db = openDatabase({ file: path.join(root, "broker.db") });
  try {
    for (const clef of CLEFS) delete process.env[clef];
    // Une session qui a posé une fiche avec `register` depuis ce dossier…
    registerPeer(db, { id: "carte-a1", project_path: "/dossier/a1", description: "fiche posée par register", status: "active" });
    // …donne son nom à la session sans nom lancée plus tard dans le même dossier,
    assert.equal(resolveSelfId(db, { cwd: "/dossier/a1" }), "carte-a1", "les hooks reprennent la fiche du dossier");
    // …et pas à celle d'un autre dossier, ni à celle qui a posé son nom.
    assert.notEqual(resolveSelfId(db, { cwd: "/dossier/ailleurs" }), "carte-a1", "un autre dossier ne la reprend pas");
    process.env.VALXOS_SELF = "nom-choisi";
    assert.equal(resolveSelfId(db, { cwd: "/dossier/a1" }), "nom-choisi", "VALXOS_SELF l'emporte : c'est le conseil de la skill");
  } finally {
    for (const clef of CLEFS) {
      if (avant[clef] === undefined) delete process.env[clef];
      else process.env[clef] = avant[clef];
    }
    db.close();
  }
});

// F5 (verdict du 18/10) — LES COMMENTAIRES NE RACONTENT PLUS UN RÉSIDU FERMÉ.
// Le guichet MCP portait 74 lignes où un « Texte d'origine » était suivi de
// deux « MIS À JOUR » : un récit disait qu'un client sans fiche pouvait déclarer
// la chaise d'une sœur et poser son `delivered_at`, puis, deux paragraphes plus
// bas, que `refusDeChaiseDeclaree` fermait ce cas. Le lecteur ne savait pas quelle
// clause était vivante. Le commentaire garde la règle d'aujourd'hui et ses
// dates ; l'histoire du résidu est au CHANGELOG.
test("F5 — server.js et registry.js ne gardent que la règle vivante : pas de récit en strates, pas de renvoi à un point supprimé", () => {
  const serveur = fs.readFileSync(path.join(repo, "src/mcp-server/server.js"), "utf8");
  assert.doesNotMatch(serveur, /Texte d'origine|MIS À JOUR|CE QUE CE GUICHET NE SAIT TOUJOURS PAS FAIRE/, "plus de commentaire en strates");
  assert.doesNotMatch(serveur, /\bpoint [123]\b/, "plus de renvoi à un point numéroté d'un récit supprimé");
  assert.match(serveur, /LA RÈGLE D'AUJOURD'HUI \(fixes des 27 et 28\/09/, "la règle vivante porte sa date");
  assert.match(serveur, /function refusDeChaiseDeclaree\b/, "sonde : la règle que le commentaire cite existe dans le code");
  // Un commentaire se replie sur plusieurs lignes `//` : on compare à plat.
  const registre = fs.readFileSync(path.join(repo, "src/lib/registry.js"), "utf8").replace(/\s*\n\s*\/\/\s*/g, " ");
  assert.doesNotMatch(registre, /devait redresser l'avis/, "la page ne « doit » plus redresser l'avis");
  assert.ok(
    registre.includes("Historique : la page redressait l'avis (fonction retirée le 18/10) ; depuis le 18/10 l'avis est vrai tel quel."),
    "l'historique tient en une phrase datée"
  );

  // C3 (FIX-C, 18/10) — le même renvoi pendait ailleurs : database.js disait « le résidu documenté
  // dans server.js, point 1 », un passage que F5 a retiré. La règle se dit là où elle sert, en une
  // phrase datée, et aucun fichier de src/ ne renvoie plus à un point de server.js.
  const sources = execFileSync("git", ["ls-files", "src"], { cwd: repo, encoding: "utf8" }).split("\n").filter((f) => f.endsWith(".js"));
  assert.ok(sources.length > 20, `sonde impossible : ${sources.length} sources de src/ seulement`);
  for (const source of sources) {
    const texte = fs.readFileSync(path.join(repo, source), "utf8").replace(/\s*\n\s*\/\/\s*/g, " ");
    // `.test()` et non `doesNotMatch` : un échec ne doit pas recracher le fichier entier.
    assert.equal(/documenté dans server\.js|server\.js, point \d/.test(texte), false, `${source} renvoie à un point de server.js qui n'existe plus`);
  }
  const base = fs.readFileSync(path.join(repo, "src/lib/database.js"), "utf8").replace(/\s*\n\s*\/\/\s*/g, " ");
  assert.ok(
    base.includes("reste le destinataire exact, porte 1, tant que sa lignée ne mène à aucune chaise en service avec session ; dès qu'elle y mène, le nom nu n'a qu'une copie et la chaise signe (règle du 28/09/2026, `nomNuTenuParUneChaise`)."),
    "database.js dit la règle du nom nu elle-même, en une phrase datée"
  );
  assert.equal(/export function nomNuTenuParUneChaise\b/.test(base), true, "sonde : la fonction que la phrase cite existe dans le code");
});

test("valxos-doctor annonce le produit VALXOS Messenger dans sa sortie", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-v2-doctor-"));
  const sortie = execFileSync("node", [path.join(repo, "src/bin/valxos-doctor.js")], {
    encoding: "utf8",
    env: { ...envPropre(), CC2CC_V2_HOME: root }
  });
  const rapport = JSON.parse(sortie);
  assert.equal(rapport.product, "VALXOS Messenger (formerly cc2cc-v2 / CEREAL)");
});

test("le pli remis en fenêtre porte l'en-tête VALXOS Messenger", () => {
  const rows = [
    {
      seq: 1,
      msg_id: "m1",
      sender: "a",
      recipient: "b",
      subject: "s",
      thread_id: null,
      priority: "normal",
      msg_type: "message",
      body: "hello",
      created_at: "2026-08-19T00:00:00Z"
    }
  ];
  const texte = formatAdditionalContext(rows);
  assert.match(
    texte,
    /^VALXOS Messenger: 1 unread message\(s\) for this session\./,
    "le pli porte le nom du produit ; l'alias cc2cc-v2 n'est plus un identifiant vivant (Task 11)"
  );
  assert.doesNotMatch(texte.split("\n")[0], /cc2cc-v2/, "l'en-tête ne nomme plus l'ancien identifiant");
  assert.match(texte, /--- VALXOS Messenger message seq=1/);
});

test("les manifestes du produit portent le nouveau nom sans perdre l'ancien (revue adverse : finding n°2 et S9)", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
  // Le nom npm porte le trait d'union depuis le Run 6 (Task 10) ; le souligné
  // reste l'identifiant MCP (serverInfo), pas le nom du paquet.
  assert.equal(pkg.name, "valxos-messenger");
  assert.match(pkg.description, /VALXOS Messenger/);
  assert.match(pkg.description, /cc2cc-v2/, "l'identifiant historique reste dit");
  assert.match(pkg.description, /CEREAL/, "l'ancien nom de produit reste dit");
  const hooks = JSON.parse(fs.readFileSync(path.join(repo, "hooks/hooks.json"), "utf8"));
  assert.match(hooks.description, /VALXOS Messenger/);
  assert.match(hooks.description, /cc2cc-v2/, "l'identifiant historique reste dit");
  assert.match(hooks.description, /CEREAL/, "l'ancien nom de produit reste dit");
  // monitors.json ne portait QUE l'ancien nom (revue adverse S9) — le seul manifeste
  // que ce fichier ne surveillait pas encore. Le nom de moniteur est un
  // identifiant machine : resté `cc2cc-v2-inbox` en B1, il suit le plugin
  // vers `valxos-messenger-inbox` en Run 6 (Task 11).
  const monitors = JSON.parse(fs.readFileSync(path.join(repo, "monitors/monitors.json"), "utf8"));
  assert.match(monitors[0].description, /VALXOS Messenger/);
  assert.match(monitors[0].description, /cc2cc-v2/, "l'identifiant historique reste dit");
  assert.match(monitors[0].description, /CEREAL/, "l'ancien nom de produit reste dit");
  assert.equal(monitors[0].name, "valxos-messenger-inbox", "le moniteur suit l'identifiant du plugin (Task 11)");
  // Une seule forme pour dire la continuité, sur chaque manifeste du plugin.
  const CONTINUITE = /VALXOS Messenger \(formerly cc2cc-v2 \/ CEREAL\)/;
  assert.match(hooks.description, CONTINUITE);
  assert.match(monitors[0].description, CONTINUITE);
  assert.doesNotMatch(hooks.description + monitors[0].description, /server id cc2cc-v2/);
  const mcp = JSON.parse(fs.readFileSync(path.join(repo, "mcp.json"), "utf8"));
  assert.deepEqual(Object.keys(mcp.mcpServers), ["valxos-messenger"], "une seule clef MCP, celle du produit (formerly cc2cc-v2)");
  assert.equal(
    mcp.mcpServers["valxos-messenger"].env,
    undefined,
    "le manifeste ne doit pas court-circuiter le nouveau défaut et le repli historique de baseDir"
  );
});

// C6 (FIX-C, 18/10, Q18) — LES MANIFESTES NE PROMETTENT PAS CE QUE LE README NIE. Le README dit « This is
// not instant messaging » et « no real-time push outside a Claude Code session » ; la description du
// plugin disait « durable real-time inter-instance messaging ». Une description publiée (npm, plugin,
// hooks, moniteur, skills) ne promet donc ni temps réel ni instantané. Et `"devDependencies": {}` est du
// bruit : le README dit « 0 development dependencies », le manifeste le prouve en n'en ayant AUCUN champ
// (npm lui-même n'écrit pas de champ vide, et le verrou en recopie la racine).
test("C6 — aucune description publiée ne promet du temps réel ; le manifeste npm n'écrit pas de devDependencies vide", () => {
  const lire = (relatif) => fs.readFileSync(path.join(repo, relatif), "utf8");
  const pkg = JSON.parse(lire("package.json"));
  const plugin = JSON.parse(lire(".claude-plugin/plugin.json"));
  const hooks = JSON.parse(lire("hooks/hooks.json"));
  const moniteurs = JSON.parse(lire("monitors/monitors.json"));
  const skills = ["skills/messaging/SKILL.md", "skills/chaise/SKILL.md"].map((f) => [f, /^description: (.+)$/m.exec(lire(f))?.[1]]);
  const descriptions = [
    ["package.json", pkg.description],
    [".claude-plugin/plugin.json", plugin.description],
    ["hooks/hooks.json", hooks.description],
    ...moniteurs.map((m, i) => [`monitors/monitors.json[${i}]`, m.description]),
    ...skills
  ];
  for (const [ou, description] of descriptions) {
    assert.ok(typeof description === "string" && description.length > 20, `sonde impossible : ${ou} n'a pas de description lisible`);
    assert.equal(/real[- ]?time|instant/i.test(description), false, `${ou} promet du temps réel ou de l'instantané : « ${description} »`);
  }
  assert.equal(
    plugin.description,
    "VALXOS Messenger (formerly cc2cc-v2 / CEREAL): durable inter-instance messaging for coding sessions.",
    "la description du plugin dit ce que le README dit"
  );

  assert.equal(Object.hasOwn(pkg, "devDependencies"), false, "package.json n'écrit pas de devDependencies vide");
  const verrou = JSON.parse(lire("package-lock.json"));
  assert.equal(Object.hasOwn(verrou.packages[""], "devDependencies"), false, "la racine du verrou suit le manifeste");
  assert.match(lire("README.md"), /0 development\s+dependencies/, "sonde : le README dit toujours zéro dépendance de développement");
});

test("les commandes portent le produit, et chaque ancien nom reste un alias déprécié vers la même cible", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
  const commandes = new Map([
    ["send", "src/bin/valxos-send.js"],
    ["peers", "src/bin/valxos-peers.js"],
    ["inbox", "src/bin/valxos-inbox.js"],
    ["unregister", "src/bin/valxos-unregister.js"],
    ["chaise", "src/bin/valxos-chaise.js"],
    ["monitor", "src/monitor/valxos_monitor.py"],
    ["migrate-v1", "scripts/migrate-v1.js"],
    ["doctor", "src/bin/valxos-doctor.js"],
    ["web", "src/bin/valxos-web.js"],
    ["migrate-home", "scripts/migrate-home.js"]
  ]);

  assert.equal(commandes.size, 10, "SONDE IMPOSSIBLE : l'inventaire des commandes a perdu une entrée");
  for (const [suffixe, cible] of commandes) {
    assert.equal(pkg.bin[`valxos-${suffixe}`], cible, `valxos-${suffixe} est le nom publié`);
    assert.equal(pkg.bin[`cc2cc-${suffixe}`], cible, `cc2cc-${suffixe} reste l'alias exact, jamais un autre programme`);
  }
  assert.equal(pkg.bin.facteur, "src/bin/facteur.js", "facteur est un métier : son nom ne bouge pas");
  assert.equal(pkg.bin["valxos-facteur"], undefined, "le produit n'invente pas un alias que le brief exclut");
  assert.equal(pkg.bin["valxos-messenger"], "src/bin/valxos-messenger.js", "le point d'entrée un-clic est publié");
  assert.equal(
    Object.keys(pkg.bin).length,
    22,
    "les 11 noms valxos-* (incluant valxos-messenger), les 10 alias cc2cc-* (dont cc2cc-migrate-home) et facteur forment exactement 22 points d'entrée"
  );
  const verrou = JSON.parse(fs.readFileSync(path.join(repo, "package-lock.json"), "utf8"));
  assert.deepEqual(verrou.packages[""].bin, pkg.bin, "le verrou npm publie exactement les mêmes commandes que le manifeste");

  const readmeAnglais = fs.readFileSync(path.join(repo, "README.md"), "utf8");
  const readmeFrancais = fs.readFileSync(path.join(repo, "README.fr.md"), "utf8");
  for (const suffixe of commandes.keys()) assert.match(readmeAnglais, new RegExp(`valxos-${suffixe}\\b`));
  assert.match(readmeAnglais, /valxos-migrate-home\b/);
  assert.match(readmeAnglais, /\bfacteur\b/);
  assert.match(readmeAnglais, /ten `cc2cc-\*` executables are deprecated aliases/i, "la compatibilité est dite comme dépréciée en anglais");
  assert.match(readmeFrancais, /cc2cc-\*[^\n]*dépréciés|dépréciés[^\n]*cc2cc-\*/i, "la version française conserve la même dette nommée");
  assert.match(readmeAnglais, /22 CLI entry points/, "le README compte tous les exécutables publiés, alias compris");

  const installeur = fs.readFileSync(path.join(repo, "scripts/install.js"), "utf8");
  assert.match(
    installeur,
    /package\.json[\s\S]*\.bin/,
    "l'installeur dérive les liens du manifeste : deux listes de commandes finiraient par diverger"
  );
});

test("les deux README portent la bannière, se relient et gardent les faits vérifiables", () => {
  const premiereLigne = (fichier) =>
    fs
      .readFileSync(path.join(repo, fichier), "utf8")
      .split("\n")
      .find((ligne) => ligne.trim().length > 0);
  // Un titre de page est un NOM, jamais l'identifiant souligné (voir « DEUX
  // REGISTRES » plus bas) : le nom npm reste confiné à la section d'installation.
  assert.equal(premiereLigne("README.md"), "# VALXOS Messenger");
  assert.equal(premiereLigne("README.fr.md"), "# VALXOS Messenger");
  const readme = fs.readFileSync(path.join(repo, "README.md"), "utf8");
  const francais = fs.readFileSync(path.join(repo, "README.fr.md"), "utf8");
  assert.match(readme, /\[Lire en français\]\(README\.fr\.md\)/, "la vitrine anglaise mène à la française");
  assert.match(francais, /\[Read this in English\]\(README\.md\)/, "la vitrine française ramène à l'anglaise");
  for (const [motif, preuve] of [
    [/cc2cc-v2/, "l'identifiant historique reste trouvable"],
    [/CEREAL/, "l'ancien nom de produit reste trouvable"],
    [/Claude Code/, "l'intégration native est nommée"],
    [/Codex/, "le harnais CLI ou MCP est nommé"],
    [/Hermes/, "le harnais CLI ou MCP est nommé"],
    [/AGPL-3\.0-only/, "la licence est haute et exacte"],
    [/fully local[^\n]*SQLite and Unix sockets[^\n]*no external service/i, "la frontière locale est dite sans promettre zéro dépendance"],
    [/3 direct runtime dependencies/, "les dépendances runtime sont comptées"],
    [/0 development\s+dependencies/, "les dépendances de développement sont comptées"],
    [/\d+ dependency package entries/, "le lockfile est compté hors entrée racine"],
    [/`node --test test\/\*\.test\.js`/, "la PHRASE de la gate est haute — jamais un nombre, il change à chaque test ajouté"],
    [/## Known limitations/, "les limites ne disparaissent pas de la vitrine"],
    [/## Contributing/, "la vitrine dit comment contribuer"],
    // En absolu (audit du paquet, 18/10, P6) : les deux guides ne voyagent pas
    // dans le paquet npm ; un lien relatif y serait mort sur la page npm.
    [/\[CONTRIBUTING\.md\]\(https:\/\/github\.com\/valx-vex\/valxos-messenger\/blob\/main\/CONTRIBUTING\.md\)/, "et mène au guide, au dépôt public"],
    [/\[SECURITY\.md\]\(https:\/\/github\.com\/valx-vex\/valxos-messenger\/blob\/main\/SECURITY\.md\)/, "et à la politique de sécurité, au dépôt public"]
  ]) assert.match(readme, motif, preuve);
  // Aucun compte de tests en prose, dans aucune des deux vitrines : le nombre
  // change à chaque test ajouté, et la suite l'imprime elle-même (rev-t8).
  for (const [nom, texte] of [["README.md", readme], ["README.fr.md", francais]]) {
    const comptes = [...texte.matchAll(/\b\d{3,4}\s+tests?\b/g)].map((m) => m[0]);
    assert.deepEqual(comptes, [], `${nom} écrit un compte de tests : ${comptes.join(", ")}`);
  }
  assert.doesNotMatch(francais, /n'utilise pas `npm test`/, "la vitrine française ne contredit plus scripts.test — npm test EST la gate");
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
  const verrou = JSON.parse(fs.readFileSync(path.join(repo, "package-lock.json"), "utf8"));
  assert.deepEqual(
    Object.keys(pkg.dependencies || {}),
    ["@modelcontextprotocol/sdk", "better-sqlite3", "zod"],
    "les trois dépendances runtime NOMMÉES par le README sont celles du manifeste"
  );
  assert.equal(Object.keys(pkg.devDependencies || {}).length, 0, "le zéro développement vient du manifeste");
  // L'oracle est le verrou, jamais un nombre recopié : un `npm update` change ce
  // compte (128 → 130 le 18/10, avec le SDK 1.32), et le README le suit.
  const enTrousseau = Object.keys(verrou.packages || {}).filter(Boolean).length;
  assert.equal(
    Number(/(\d+) dependency package entries/.exec(readme)?.[1]),
    enTrousseau,
    "le compte du README exclut l'entrée racine et compte chaque paquet du verrou"
  );
  const finDesFaitsHauts = readme.indexOf("## Install");
  assert.ok(finDesFaitsHauts > 0, "la section d'installation existe");
  for (const fait of ["AGPL-3.0-only", "fully local", `${enTrousseau} dependency package entries`, "`node --test test/*.test.js`"]) {
    assert.ok(readme.indexOf(fait) < finDesFaitsHauts, `${fait} doit rester avant l'installation`);
  }
  // LA SECTION KNOWN LIMITATIONS N'EST PAS VIDE (rev-t8) : bug_report.yml,
  // config.yml et SECURITY.md y envoient ; un titre sans corps est un lien mort
  // qui a l'air vivant. Le corps : des puces, les trois ensembles de la garde
  // web, et le renvoi vers docs/FACTEUR.md dont l'ancre est un vrai titre.
  const debutLimites = readme.indexOf("## Known limitations");
  const finLimites = readme.indexOf("\n## ", debutLimites + 1);
  const limites = readme.slice(debutLimites, finLimites < 0 ? undefined : finLimites);
  const puces = limites.split("\n").filter((ligne) => /^- /.test(ligne));
  assert.ok(puces.length >= 8, `la section Known limitations porte ses puces (${puces.length} vues)`);
  for (const ensemble of [/\*\*Structurally closed:\*\*/, /\*\*Closed by lists that must be maintained:\*\*/, /\*\*Not closed:\*\*/]) {
    assert.match(limites, ensemble, "les trois ensembles honnêtes de la garde web sont dans la vitrine anglaise");
  }
  assert.match(limites, /The danger is not the hole; it is the sentence claiming there is none\./, "la phrase-règle de la garde");
  const renvoi = /\]\(docs\/FACTEUR\.md#([^)]+)\)/.exec(limites);
  assert.ok(renvoi, "la section renvoie vers docs/FACTEUR.md par une ancre");
  const facteur = fs.readFileSync(path.join(repo, "docs", "FACTEUR.md"), "utf8");
  const slug = (titre) => titre.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s+/g, "-");
  const titres = [...facteur.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map((m) => slug(m[1]));
  assert.ok(titres.includes(decodeURIComponent(renvoi[1])), `l'ancre ${renvoi[1]} est un titre de docs/FACTEUR.md`);
  assert.match(francais, /cc2cc-v2/, "l'identifiant historique reste trouvable en français");
  assert.match(francais, /CEREAL/, "l'ancien nom de produit reste trouvable en français");
  assert.match(francais, /Ce que le produit ne promet pas/, "les limites françaises sont conservées");
  assert.equal(
    fs.existsSync(path.join(repo, "STATUS.md")),
    false,
    "STATUS.md est sorti de l'arbre publié (périmé, privé) — R6"
  );
});

// ── DEUX REGISTRES, ET C'EST VOULU ─────────────────────────────────────────
//
// `valxos_messenger` est un IDENTIFIANT : nom de paquet, mots-clefs, champ
// `name` du serveur MCP. « VALXOS Messenger » est un NOM : titre de page,
// fronton, prose. Les deux sont justes, chacun dans son registre — personne
// n'écrit `<h1>valxos_messenger</h1>` sur une page qu'un humain regarde.
//
// La première version de ce test exigeait l'identifiant PARTOUT et interdisait
// le nom — elle a effacé le fronton qui avait été validé (« VALXOS ·
// Messenger », point médian compris). Ruling du 23/08 : l'ennemi que la règle
// de nommage désigne, c'est L'ANCIEN NOM. Pas les majuscules.
//
// Ce test dit donc les trois choses vraies : l'ancien nom a disparu du
// visible ; l'identifiant est là où il doit être ; le nom d'affichage aussi.
const NOM_AFFICHE = /VALXOS[\s·]+Messenger/;

test("les surfaces visibles ont perdu l'ancien nom, et gardé les DEUX registres du nouveau", () => {
  const parFichier = new Map(
    [
      "docs/FACTEUR.md",
      "README.md",
      "README.fr.md",
      "skills/messaging/SKILL.md",
      "skills/chaise/SKILL.md",
      "src/web/public/index.html"
    ].map((f) => [f, fs.readFileSync(path.join(repo, f), "utf8")])
  );

  // L'INSTRUMENT DOIT POUVOIR VOIR SA CIBLE : une liste vide passerait sinon.
  assert.equal(parFichier.size, 6, "SONDE IMPOSSIBLE : le balayage a perdu des fichiers");

  // ── LA DETTE DE NOMMAGE, COMPTABLE ────────────────────────────────────────
  //
  // « cc2cc » n'a PAS disparu du visible, et il ne le doit pas : le préfixe
  // `cc2cc-*` nomme les alias dépréciés conservés par contrat ; `cc2cc-v2`
  // reste dit comme ancien identifiant (« formerly ») du plugin et du serveur,
  // dont le lien historique est encore lu par des sessions vivantes.
  //
  // Plutôt que de le taire, on l'ÉNUMÈRE. Chaque forme survivante est nommée
  // avec l'étage qui la fermera. Une forme non prévue fait rougir : la dette
  // ne grossit pas en silence, et le jour où les étages 2 et 3 passent, ce
  // test devient l'inventaire de ce qu'il reste à faire.
  const DETTE_ATTENDUE = new Map([
    // étage 2 — famille des alias de commandes, conservée et dite dépréciée.
    ["cc2cc-*", 2],
    // étage 3 — ancien identifiant MCP/plugin, dit « formerly ». Les
    // identifiants de skill (`cc2cc-v2-messaging`, `cc2cc-v2-chaise`) sont
    // fermés depuis Task 11 : les revoir ici ferait rougir. Le répertoire
    // historique ne figure plus comme défaut, seulement comme compatibilité.
    ["cc2cc-v2", 3],
    ["vm_cc2cc", 3],
    ["CC2CC_*", 3]
  ]);
  const formes = [...DETTE_ATTENDUE.keys()].sort((a, b) => b.length - a.length);
  // Les variables d'environnement sont une FAMILLE, pas une liste : `CC2CC_*`
  // est une clef de machine (étage 3), et la doc a RAISON de les nommer — un
  // réglage qu'on ne peut pas écrire est un réglage qui n'existe pas.
  const FAMILLE_ENV = /CC2CC_[A-Z0-9_]+/g;

  for (const [fichier, contenu] of parFichier) {
    // ① CE QUI COMPTE : aucune forme de l'ancien nom qui ne soit INSCRITE.
    let reste = contenu.replace(FAMILLE_ENV, "");
    for (const forme of formes) reste = reste.split(forme).join("");
    const surprises = reste.match(/cc2cc[\w-]*/gi) || [];
    assert.deepEqual(
      [...new Set(surprises)],
      [],
      `${fichier} porte une forme de l'ancien nom qui n'est PAS inscrite à la dette — inscris-la avec son étage, ou fais-la disparaître`
    );
    // ② et le produit se nomme, dans l'un OU l'autre registre selon sa nature.
    assert.ok(
      /valxos_messenger/.test(contenu) || NOM_AFFICHE.test(contenu),
      `${fichier} ne nomme le produit dans aucun des deux registres`
    );
  }

  // ③ LE FRONTON EST CELUI DE LA MAQUETTE VALIDÉE, au caractère près.
  const page = parFichier.get("src/web/public/index.html");
  assert.match(
    page,
    /<h1 class="marque__nom">VALXOS <span>·<\/span> Messenger<\/h1>/,
    "le fronton validé — un identifiant en minuscules à sa place serait une régression de design"
  );
  assert.match(page, /<title>VALXOS Messenger — web door<\/title>/, "le titre d'onglet est un nom, pas une clef");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(repo, ".claude-plugin/plugin.json"), "utf8")
  );
  assert.equal(manifest.name, "valxos-messenger", "l'identifiant du plugin est celui du produit (Task 11)");
  assert.match(manifest.description, /^VALXOS Messenger \(formerly cc2cc-v2 \/ CEREAL\)/);
  assert.ok(manifest.keywords.includes("valxos-messenger"), "le mot-clef suit le nom du paquet");
  assert.ok(!manifest.keywords.includes("valxos_messenger"), "plus de mot-clef souligné");
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
  assert.equal(manifest.version, pkg.version, "la version du plugin est celle du paquet");
  // Les skills portent l'identifiant du plugin en préfixe.
  const nomDeSkill = (f) => /^name: (.+)$/m.exec(parFichier.get(f))?.[1];
  assert.equal(nomDeSkill("skills/messaging/SKILL.md"), "valxos-messenger-messaging");
  assert.equal(nomDeSkill("skills/chaise/SKILL.md"), "valxos-messenger-chaise");
  const descriptionDeSkill = (f) => /^description: (.+)$/m.exec(parFichier.get(f))?.[1];
  assert.match(descriptionDeSkill("skills/messaging/SKILL.md"), /VALXOS Messenger \(formerly cc2cc-v2 \/ CEREAL\)/);
  assert.match(parFichier.get("skills/messaging/SKILL.md"), /`valxos-messenger` MCP tools/, "la skill nomme la clef MCP vivante");
});

// ── AUCUNE IDENTITÉ DE CETTE MACHINE NE PART EN PUBLIC ─────────────────────
//
// Un audit de conformité a compté, dans l'arbre : 131 lignes portant le prénom
// de l'opérateur, 25 le nom de sa machine, et des chemins révélant le nom de
// son compte. Ce n'était pas une fuite de secret — c'était un logiciel bâti
// pour UN humain nommé, sur UNE machine nommée. Un inconnu qui l'installe ne
// doit pas hériter du fronton de quelqu'un d'autre.
//
// La garde porte sur le DÉPÔT ENTIER, pas sur les fichiers qu'on a pensé à
// regarder : c'est la leçon de la semaine — corriger l'instance qu'un rapport
// a nommée n'est pas fermer la classe.
test("AUCUNE IDENTITÉ PERSONNELLE DANS L'ARBRE — la classe, pas les fichiers connus", () => {
  const suivis = execFileSync("git", ["ls-files", "-z"], { cwd: repo, encoding: "utf8" })
    .split("\0").filter(Boolean);
  // TROIS ISSUES : un balayage qui ne trouve pas ses fichiers n'est pas vert.
  assert.ok(suivis.length > 50, `SONDE IMPOSSIBLE : ${suivis.length} fichiers suivis seulement`);

  // ⚠️ LES NOMS NE S'ÉCRIVENT PLUS ICI — voir test/aide-identites.js.
  // Cette liste contenait le prénom de l'opérateur et le nom de la machine en
  // clair. Logiquement correct (une assertion négative a le droit de nommer ce
  // qu'elle interdit, et la garde l'exemptait), et pourtant une fuite : `grep
  // <prénom>` sur le dépôt public le trouvait DANS LA GARDE CENSÉE L'INTERDIRE.
  // Une garde ne peut pas s'attraper elle-même.
  // Les identités se DÉCOUVRENT maintenant à l'exécution. Effet de bord heureux :
  // la garde protégeait un humain nommé, elle protège désormais quiconque la lance.
  const decouvertes = identitesDeCetteMachine();
  // TROIS ISSUES : sans identité découverte, ce volet ne prouve rien et le dit.
  // En mode CI (ruling 10), compte, machine et domicile sont ceux du runner et
  // ne se cherchent pas : le plancher tombe à zéro là, et seulement là.
  assert.ok(
    decouvertes.length >= (modeCI() ? 0 : 3),
    `SONDE IMPOSSIBLE : ${decouvertes.length} identité(s) découverte(s) — compte, machine et domicile devraient toujours l'être`
  );
  const INTERDITS = [
    ...decouvertes.map(({ motif, quoi }) => [motif, quoi]),
    ...FORMES_PRIVEES
  ];
  const fautes = [];
  for (const rel of suivis) {
    if (rel.endsWith(".woff2")) continue;           // binaires : prouvés ailleurs
    if (rel === "test/surfaces.test.js") continue;  // ce fichier NOMME les interdits
    const contenu = fs.readFileSync(path.join(repo, rel), "utf8");
    for (const [motif, quoi] of INTERDITS) {
      const m = contenu.match(motif);
      // Une ligne qui INTERDIT le motif a le droit de l'écrire : c'est une garde,
      // pas une fuite. On regarde donc si la ligne porte une assertion négative.
      if (!m) continue;
      const ligne = contenu.split("\n").find((l) => motif.test(l)) || "";
      if (/doesNotMatch|doesNotInclude|INTERDIT|n'embarque aucune/.test(ligne)) continue;
      fautes.push(`${rel} : ${quoi} — « ${ligne.trim().slice(0, 70)} »`);
    }
  }
  assert.deepEqual(fautes, [], `des identités de cette machine partiraient en public :\n${fautes.join("\n")}`);
});

// ── LE DÉTECTEUR DES NOMS DE LA MAISON : SA MÉCANIQUE, SUR DES NOMS FICTIFS ─
//
// Les auteurs gardent les noms de leurs agents, de leurs instances, de leurs
// maisons, de leurs relecteurs et de leurs modèles hors de l'arbre public. La
// garde qui les cherche dans le paquet et dans test/ vit dans un fichier privé,
// test/noms-prives.test.js, que l'export public exclut : une liste encodée
// reste réversible (verdict du 18/10/2026), donc une liste ne voyage pas, ni en
// clair ni encodée. Ce qui voyage, c'est la MÉCANIQUE — test/aide-noms-maison.js :
// frontières de mot, casse, forme tronquée, nom versionné, haché de commit —
// et la preuve qu'elle mord. La voici, sur des noms FICTIFS écrits en clair, et
// sur des fichiers temporaires comme la garde réelle lit des fichiers.
const NOMS_FICTIFS = {
  agents: ["zz-agent-fictif", "zz-agent-bis"],
  tronque: "zz-agent-bi",
  instances: ["zz-instance", "zz-instance-bis"],
  surnom: "zz-surnom",
  lignee: "zz-lignee",
  relecteurs: ["Zz-Relecteur", "ZZ-RELECTEUR"],
  modeles: ["zz-modele", "zz-modelx"],
  maisons: ["zz", "zy"],
  role: "zz-role"
};

test("le détecteur des noms de la maison mord sur des noms fictifs, dans des fichiers temporaires, et laisse passer un fichier propre", (t) => {
  const motifs = motifsDesNoms(NOMS_FICTIFS);
  const vus = (texte, m = motifs) => nomsDeLaMaison(texte, m).map((trouve) => trouve.quoi);
  // TROIS ISSUES : un détecteur qui a perdu une catégorie ne garde plus rien de
  // cette catégorie, et le dirait vert.
  assert.deepEqual(
    [...new Set(motifs.map(([, quoi]) => quoi))].sort(),
    [
      "un nom d'agent", "un nom d'agent tronqué", "un nom d'instance", "un surnom", "une adresse de lignée",
      "un nom de relecteur", "un nom de modèle relecteur", "un nom de modèle relecteur versionné", "une maison",
      "un rôle d'orchestrateur", "un commit de l'historique privé", "un haché de l'historique privé"
    ].sort(),
    "SONDE IMPOSSIBLE : le détecteur a perdu une catégorie de noms"
  );

  // Chaque catégorie, sur un texte d'une ligne.
  const [a, b] = NOMS_FICTIFS.agents;
  const { tronque, relecteurs, modeles, lignee } = NOMS_FICTIFS;
  assert.deepEqual(vus(`// une lettre de ${b} à ${a}`), ["un nom d'agent", "un nom d'agent"]);
  assert.deepEqual(vus(`send({ to: "claude-${a}@${NOMS_FICTIFS.instances[0]}" })`), ["un nom d'agent", "un nom d'instance"]);
  assert.deepEqual(vus(`// ${NOMS_FICTIFS.surnom}_opus`), ["un surnom"]);
  assert.deepEqual(vus(`// claude-${lignee}`), ["une adresse de lignée"]);
  assert.deepEqual(vus(`// (remède ${relecteurs[0]} #3, C7)`), ["un nom de relecteur"]);
  assert.deepEqual(vus(`// re-verdict ${modeles[0]}`), ["un nom de modèle relecteur"]);
  assert.deepEqual(vus(`"x-${modeles[1]}"`), ["un nom de modèle relecteur"]);
  assert.deepEqual(vus(`".claude-${NOMS_FICTIFS.maisons[0]}",`), ["une maison"]);
  assert.deepEqual(vus(`// à la place du ${NOMS_FICTIFS.role}`), ["un rôle d'orchestrateur"]);
  // Les trois formes que la revue du 18/10 a trouvées vivantes : le relecteur en
  // capitales, la forme tronquée d'un nom d'agent, le nom de modèle collé à son
  // numéro. Chacune mord seule, et le nom entier ne compte qu'une fois.
  assert.equal(relecteurs[1], relecteurs[0].toUpperCase(), "SONDE IMPOSSIBLE : la seconde forme du relecteur n'est pas sa forme capitale");
  assert.deepEqual(vus(`// ${relecteurs[1]} F3 (passe adverse)`), ["un nom de relecteur"]);
  assert.deepEqual(vus(`deposerAncienNom(db, "${tronque}", "bob", { now: T0 });`), ["un nom d'agent tronqué"]);
  assert.deepEqual(vus(`parNom.${tronque.toUpperCase()}.sert ; "${b}2"`), ["un nom d'agent tronqué"]);
  assert.deepEqual(vus(`sender: "bob-${modeles[0]}7",`), ["un nom de modèle relecteur versionné"]);
  // Un haché fictif, écrit en deux morceaux pour que le balayage de ce fichier
  // même ne l'accuse pas : il ne désigne aucun commit.
  const hache = ["abc", "1234"].join("");
  assert.deepEqual(vus(`// commit ${hache}`), ["un commit de l'historique privé", "un haché de l'historique privé"]);
  assert.deepEqual(vus(`// facteur.js/${hache}`), ["un haché de l'historique privé"]);

  // Des fichiers temporaires : la garde réelle lit des fichiers, la mécanique
  // aussi. Le fautif porte les noms fictifs que la mission cite — un agent, une
  // instance, une maison, le relecteur en capitales, le modèle versionné — plus
  // un haché ; le propre porte tout ce qui ne doit PAS mordre.
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-noms-fictifs-"));
  t.after(() => fs.rmSync(dossier, { recursive: true, force: true }));
  const ecrire = (nom, lignes) => fs.writeFileSync(path.join(dossier, nom), `${lignes.join("\n")}\n`);
  ecrire("fautif.js", [
    "// une première ligne propre",
    `// une lettre de ${a} à bob`,
    `send({ to: "claude-${NOMS_FICTIFS.instances[0]}" });`,
    `const maison = ".claude-${NOMS_FICTIFS.maisons[0]}";`,
    `// ${relecteurs[1]} F3 (passe adverse)`,
    `sender: "bob-${modeles[0]}7",`,
    `// commit ${hache}`
  ]);
  ecrire("propre.js", [
    "// alice, bob, claude-alice@atelier, alice-codex, bobby, bob-cli, haiku",
    `const adresses = ["alice-${lignee}", "bob-${lignee}"];`,
    'const lien = "https://github.com/x/y"; const couleur = "#1a2b3c";',
    'const uuid = "00000000-0000-4000-8000-000000000000";',
    // En minuscules, le relecteur est un mot comme un autre : la casse compte.
    `// le verrou reste au ${relecteurs[0].toLowerCase()}, intact`,
    // Un identifiant de session de fixture : un nom pour test/, un haché pour le paquet.
    `const session = { sessionId: "${hache}0-3f2c-4d66", prefixe: "${hache}0" };`
  ]);
  const fichiers = ["fautif.js", "propre.js"];
  const fautesDuPaquet = fautesDansLesFichiers({ racine: dossier, fichiers, motifs });
  const fautesDeTest = fautesDansLesFichiers({ racine: dossier, fichiers, motifs: motifsDansTest(motifs) });
  const lieux = (fautes) => fautes.map((f) => f.split(" — ")[0]);
  const attendues = [
    "fautif.js:2 : un nom d'agent",
    "fautif.js:3 : un nom d'instance",
    "fautif.js:4 : une maison",
    "fautif.js:5 : un nom de relecteur",
    "fautif.js:6 : un nom de modèle relecteur versionné",
    "fautif.js:7 : un commit de l'historique privé",
    "fautif.js:7 : un haché de l'historique privé"
  ];
  // Le fichier fautif est relevé ligne à ligne, dans les deux frontières ; la
  // ligne propre du fautif (la première) ne l'est jamais.
  assert.deepEqual(lieux(fautesDeTest), attendues, "dans test/ : chaque nom fictif est relevé, à sa ligne");
  // Le paquet est plus strict sur les hachés nus : l'identifiant de session de
  // fixture, qui passe dans test/, y est un haché (propre.js:6, deux fois).
  assert.deepEqual(lieux(fautesDuPaquet).filter((l) => l.startsWith("fautif.js")), attendues, "dans le paquet : les mêmes noms fictifs");
  assert.deepEqual(lieux(fautesDuPaquet).filter((l) => l.startsWith("propre.js")), ["propre.js:6 : un haché de l'historique privé"], "dans le paquet, un identifiant de session est un haché");
  // Le fichier propre ne mord jamais dans test/ : ni exemple, ni lignée d'exemple,
  // ni lien, ni couleur, ni UUID, ni mot en minuscules, ni identifiant de session.
  assert.deepEqual(fautesDeTest.filter((f) => f.startsWith("propre.js")), [], "le fichier propre passe");
  // Une exception inscrite (le fichier ET la source du motif) retire exactement
  // ce relevé-là.
  const motifAgent = motifs[0][0];
  const sansExceptions = fautesDansLesFichiers({ racine: dossier, fichiers: ["fautif.js"], motifs: motifsDansTest(motifs), exceptions: [{ fichier: "fautif.js", motif: motifAgent.source }] });
  assert.equal(sansExceptions.length, attendues.length - 1, "une exception retire un relevé, pas les autres");
  // Même la mécanique d'adresse en dur : un nom d'agent écrit comme destinataire.
  const adresse = motifAdresseEnDur(NOMS_FICTIFS.agents);
  assert.deepEqual(lignesFautives(`const to = "${a}";`, adresse), [1]);
  assert.deepEqual(lignesFautives(`send({ to: '${a}#sess-1' })`, adresse), [1]);
  assert.deepEqual(lignesFautives(`valxos-send --to ${b} 'salut'`, adresse), [1]);
  assert.deepEqual(lignesFautives(`  recipient: claude-${a}`, adresse), [1]);
  assert.deepEqual(lignesFautives(`const to = "${a}-${lignee}"; // --to ${a}-${lignee}`, adresse), []);
  assert.deepEqual(lignesFautives(`// une lettre à « ${a} » a dormi sept semaines`, adresse), []);
});

// ── AUCUN OCTET 0x00 DANS UN FICHIER SUIVI TEXTE (rev-t8, 29/08/2026) ─────────
// Un U+0000 LITTÉRAL vivait dans src/web/serveur.js (`signatureDeLaLettre`,
// séparateur d'un template string) et dans test/web-garde-spawn.test.js.
// git les voyait texte (heuristique sur les 8000 premiers octets) ; `file`
// disait « data » et grep BSD les traitait en binaire : tout `grep` d'un
// humain ou d'un agent sur serveur.js rendait VIDE, sans un mot. C'est ainsi
// que l'octet a été trouvé — par un grep muet. L'échappement `\0` produit la
// même chaîne et laisse le fichier lisible par tous les outils.
// L'oracle est `git ls-files` (les fichiers publiés, jamais l'atelier) ; sans
// git, la marche de l'arbre — et une sonde qui ne voit aucun fichier rougit.
test("aucun fichier suivi texte ne contient un octet 0x00 — un NUL rend grep muet pour tout humain et tout agent", () => {
  const BINAIRES_CONNUS = /\.(woff2?|ttf|otf|eot|png|jpe?g|gif|ico|pdf|db|sqlite|gz|tgz|zip)$/i;
  const HORS_ARBRE = new Set([".git", "node_modules", "coverage", "tmp", ".claude", ".superpowers"]);
  let fichiers;
  try {
    fichiers = execFileSync("git", ["ls-files", "-z"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\0").filter(Boolean);
  } catch {
    fichiers = [];
    const marcher = (dossier, prefixe) => {
      for (const entree of fs.readdirSync(dossier, { withFileTypes: true })) {
        if (HORS_ARBRE.has(entree.name)) continue;
        const relatif = prefixe ? `${prefixe}/${entree.name}` : entree.name;
        if (entree.isDirectory()) marcher(path.join(dossier, entree.name), relatif);
        else if (entree.isFile()) fichiers.push(relatif);
      }
    };
    marcher(repo, "");
  }
  const textes = fichiers.filter((f) => !BINAIRES_CONNUS.test(f));
  assert.ok(textes.length >= 100, `la sonde voit l'arbre publié (${textes.length} fichiers texte)`);
  const coupables = [];
  for (const relatif of textes) {
    const octets = fs.readFileSync(path.join(repo, relatif));
    const position = octets.indexOf(0);
    if (position < 0) continue;
    const ligne = octets.subarray(0, position).toString("utf8").split("\n").length;
    coupables.push(`${relatif}:${ligne} (octet ${position})`);
  }
  assert.deepEqual(coupables, [], `un octet 0x00 dans un fichier texte suivi — grep y est muet :\n  ${coupables.join("\n  ")}`);
});

// ── list_peers montre l'alias COMME UN ALIAS ───────────────────────────────

async function bureauAvecAlias() {
  // Le bureau du PROCESSUS de test aussi : openDatabase et registerPeer
  // écrivent dans la maison d'exécution, jamais dans celle du lanceur.
  const root = poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-v2-surfaces-alias-")));
  const { openDatabase, registerPeer } = await import("../src/lib/database.js");
  const { poserAlias, registerInstance } = await import("../src/lib/registry.js");
  const db = openDatabase({ file: path.join(root, "broker.db") });
  registerPeer(db, { id: "alice", project_path: "/x", description: "fiche héritée", status: "active" });
  registerInstance(db, { lineage: "alice-eternal", sessionId: "sess-1", pid: process.pid });
  poserAlias(db, "alice", "alice-eternal");
  db.close();
  return root;
}

test("list_peers (guichet MCP) range l'alias parmi les alias, jamais parmi les pairs", async () => {
  const root = await bureauAvecAlias();
  const client = new Client({ name: "surfaces-alias", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(repo, "src/mcp-server/server.js")],
    env: { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_SELF: "surfaces-probe" }
  });
  await client.connect(transport);
  try {
    const res = JSON.parse((await client.callTool({ name: "list_peers", arguments: {} })).content[0].text);
    assert.deepEqual(res.aliases.map((a) => [a.id, a.alias_de, a.kind]), [["alice", "alice-eternal", "alias"]]);
    const fiche = res.peers.find((p) => p.id === "alice");
    assert.equal(fiche.masque_par_alias, "alice-eternal", "la fiche héritée est dite masquée, pas adressable");
    assert.ok(res.peers.every((p) => p.kind !== "alias"));
  } finally {
    await client.close();
  }
});

test("valxos-peers range l'alias parmi les alias, jamais parmi les pairs", async () => {
  const root = await bureauAvecAlias();
  const sortie = JSON.parse(execFileSync("node", [path.join(repo, "src/bin/valxos-peers.js")], {
    encoding: "utf8",
    env: { ...envPropre(), CC2CC_V2_HOME: root }
  }));
  assert.deepEqual(sortie.aliases.map((a) => [a.id, a.alias_de, a.kind]), [["alice", "alice-eternal", "alias"]]);
  assert.equal(sortie.peers.find((p) => p.id === "alice").masque_par_alias, "alice-eternal");
});

test("README : installation — l'URL GitHub à ton LLM d'abord, npm i -g valxos-messenger ensuite", () => {
  for (const f of ["README.md", "README.fr.md"]) {
    const t = fs.readFileSync(path.join(repo, f), "utf8");
    const llm = t.search(/github\.com\/valx-vex\/valxos-messenger/); const npm = t.indexOf("npm i -g valxos-messenger");
    assert.ok(llm >= 0 && npm > llm, `${f} : la méthode LLM précède npm`);
    assert.doesNotMatch(t, /--package valxos_messenger/, `${f} : plus de nom npm souligné`);
    // N3 : npm 12 bloque les scripts d'installation des dépendances.
    assert.ok(t.includes("npm i -g valxos-messenger --allow-scripts=better-sqlite3"), `${f} : l'installation npm autorise le script de better-sqlite3`);
    assert.match(t, /npm 12/, `${f} : le pourquoi est dit`);
  }
});

// Revue finale (28/09), dérive n°1 — la phrase de routage du README anglais
// disait qu'avec plusieurs chaises vivantes « la livraison va à l'une d'elles ».
// Faux : la lettre attend une désignation ; ensuite la désignée la reçoit et
// chaque autre chaise vivante en voit une copie cc. Les deux README le disent.
test("README : plusieurs chaises vivantes — la lettre attend une désignation, puis copie cc aux autres (en et fr)", () => {
  const en = fs.readFileSync(path.join(repo, "README.md"), "utf8").replace(/\s+/g, " ");
  const fr = fs.readFileSync(path.join(repo, "README.fr.md"), "utf8").replace(/\s+/g, " ");
  assert.doesNotMatch(en, /delivery goes to one of them/);
  assert.match(en, /waits for a human designation/);
  assert.match(en, /cc copy/);
  assert.match(fr, /attend une désignation humaine/);
  assert.match(fr, /copie cc/);
});

// ── LES SURFACES LUES PARLENT ANGLAIS (T4b-b, 18/10) ────────────────────────
// Le mot de l'auteur : « tout le messenger est en anglais, c'était une erreur à
// nous ». Tout ce que le Messenger dit à un humain ou injecte dans un modèle
// est en anglais : aide et erreurs du CLI, ligne du Facteur, moniteur, prose
// des réponses MCP et HTTP. Les CODES ne changent pas (`refus`, `motif`,
// `etat` et leurs valeurs), ni les identifiants, ni les commentaires.
//
// Les seules chaînes françaises admises sont des CODES du contrat, chacune
// avec sa raison (« au guichet » et « en attente », les deux autres valeurs de
// `etat`, ne portent ni accent ni deux mots-outils : le détecteur ne les relève
// pas). Une prose française qui revient sur une surface rougit ici.
const CODES_FRANCAIS_ADMIS = [
  { fichier: "src/lib/format.js", texte: "accusée", pourquoi: "valeur stable de `etat` (doctor, MCP, porte web)" },
  { fichier: "src/lib/format.js", texte: "reçue", pourquoi: "valeur stable de `etat`" },
  { fichier: "src/facteur/round.js", texte: "ACCUSÉE", pourquoi: "valeur `etat` du journal du Facteur" },
  { fichier: "src/facteur/round.js", texte: "RÉSERVÉE", pourquoi: "valeur `etat` du journal du Facteur" },
  { fichier: "src/facteur/round.js", texte: "DIFFÉRÉE", pourquoi: "valeur `etat` du journal du Facteur" },
  { fichier: "src/facteur/round.js", texte: "PRÊTE", pourquoi: "valeur `etat` du journal du Facteur" },
  { fichier: "src/web/serveur.js", texte: "reçue", pourquoi: "comparaison au code `etat` de etatDeLaLettre" }
];

test("le détecteur des surfaces lit les chaînes, jamais les commentaires ni les regex", async () => {
  const { litterauxJs, litterauxPy, parleFrancais } = await import("./aide-surfaces.js");
  const js = [
    "// un commentaire en français, ignoré",
    "/* lui aussi : la lettre attend */",
    "const r = /lignée|chaise/u.test(x) ? a / b : 0;",
    "const s = `Letter ${id} — ${n > 1 ? \"la lettre attend sans chaise\" : \"ok\"} done`;",
    "const t = 'the letter waits';",
    "const sql = `UPDATE peers SET x = 1 -- la même règle que là-bas\n WHERE id = ?`;"
  ].join("\n");
  const textes = litterauxJs(js).map((l) => l.texte);
  assert.ok(textes.includes("la lettre attend sans chaise"), "une chaîne dans une expression de gabarit se lit");
  assert.ok(textes.includes("the letter waits"));
  assert.ok(!textes.some((t) => /commentaire|lui aussi/.test(t)), "les commentaires ne sont pas des chaînes");
  assert.ok(!textes.some((t) => /lignée\|chaise/.test(t)), "une regex n'est pas une chaîne");
  assert.deepEqual(litterauxJs(js).filter((l) => parleFrancais(l.texte)).map((l) => l.texte), ["la lettre attend sans chaise"],
    "seule la prose française est relevée — pas l'anglais, pas un commentaire SQL");
  const py = [
    "def f():",
    "    \"\"\"Une docstring en francais, ignoree.\"\"\"",
    "    print(\"le moniteur ecoute deja sur ce socket\")  # un commentaire",
    "    print(f\"listening on {sock}\")"
  ].join("\n");
  assert.deepEqual(litterauxPy(py).filter((l) => parleFrancais(l.texte)).map((l) => l.texte),
    ["le moniteur ecoute deja sur ce socket"], "le français sans accents se reconnaît à ses mots-outils");
});

test("aucune prose française sur une surface lue : CLI, Facteur, moniteur, MCP, HTTP (T4b-b)", async () => {
  const { fichiersDesSurfaces, prosesFrancaises } = await import("./aide-surfaces.js");
  // Le front web (src/web/public/) a sa propre tâche ; il n'est pas lu ici.
  const fichiers = fichiersDesSurfaces(repo, { exclus: ["src/web/public"] });
  for (const attendu of ["src/bin/valxos-chaise.js", "src/facteur/round.js", "src/mcp-server/server.js", "src/web/serveur.js", "src/monitor/valxos_monitor.py", "scripts/migrate-home.js"]) {
    assert.ok(fichiers.includes(attendu), `SONDE IMPOSSIBLE : ${attendu} n'est pas dans l'inventaire des surfaces`);
  }
  const relevees = fichiers.flatMap((f) => prosesFrancaises(repo, f));
  const admis = (r) => CODES_FRANCAIS_ADMIS.some((c) => c.fichier === r.fichier && c.texte === r.texte);
  // Chaque code admis existe encore : une liste d'exceptions qui ne sert plus
  // est une porte ouverte pour la prochaine.
  for (const code of CODES_FRANCAIS_ADMIS) {
    assert.ok(relevees.some((r) => r.fichier === code.fichier && r.texte === code.texte),
      `le code admis « ${code.texte} » (${code.fichier}) n'existe plus : retirez-le de la liste`);
  }
  const prose = relevees.filter((r) => !admis(r)).map((r) => `${r.fichier}:${r.ligne}: ${r.texte.slice(0, 120)}`);
  assert.deepEqual(prose, [], `prose française sur une surface lue :\n${prose.join("\n")}`);
});
