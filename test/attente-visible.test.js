// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// L'ATTENTE VISIBLE (chantier 2 du run publiable, 20/08). La leçon de la seq 81 :
// une lignée sœur a posté vers une lignée à deux chaises vivantes sans désignée, a reçu
// un `sent:true` sec, et n'a jamais su que sa lettre refusait les dés pendant
// 20 heures. La lettre EST prise en charge (A9) — c'est l'ATTENTE qui doit se
// dire au posteur, au moment du send, dérivée de la MÊME résolution qui sert à
// livrer (loi du 13/08 : jamais une seconde détection qui divergerait).
// ⚠️ Bases JETABLES (mkdtemp + CC2CC_V2_HOME) : le bureau vivant n'ouvre jamais.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import net from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { openDatabase, registerPeer } from "../src/lib/database.js";
import {
  attenteDeLaLettre,
  registerInstance,
  resolveRecipient,
  designatePrimary,
  libelleStatut,
  porteDeReveil,
  deposerAncienNom
} from "../src/lib/registry.js";
import { procStartOf } from "../src/lib/postbox.js";
import { envPropre, poserLeBureau } from "./aide-env.js";
import { quarantaine } from "./aide-quarantaine.js";

// ⚠️ LE JETABLE VAUT AUSSI POUR CE PROCESSUS-CI (revue adverse F2, 21/08). Un `file`
// explicite ne protège PAS le bureau vivant : `ensureRuntimeDirs`,
// `writeHeartbeat` et le registre lisent `baseDir()` — donc l'ENV du runner,
// jamais le fichier qu'on vient de leur imposer. Sans ce plancher, les gestes
// EN PROCESSUS de ce fichier écrivaient dans le VRAI ~/.cc2cc-v2 (fiches et
// répertoires constatés le 21/08). Les tests qui posent leur propre racine la
// posent par-dessus ; l'état d'origine se restaure à la fin du fichier.
const BUREAU_INITIAL = process.env.CC2CC_V2_HOME;
poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-attente-plancher-")));
after(() => {
  if (BUREAU_INITIAL === undefined) delete process.env.CC2CC_V2_HOME;
  else process.env.CC2CC_V2_HOME = BUREAU_INITIAL;
});


const repo = path.resolve(new URL("..", import.meta.url).pathname);

function maisonJetable() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-attente-"));
}

// Deux chaises vivantes, aucune désignée : le miroir exact de la fixture
// « ambigu » de registry.test.js (lignes 204-210).
function ligneeAmbigue(db, lignee) {
  registerInstance(db, { lineage: lignee, sessionId: "aaaa1111-0000-4000-8000-000000000001", house: "/h/work", pid: 111 });
  registerInstance(db, { lineage: lignee, sessionId: "bbbb2222-0000-4000-8000-000000000002", house: "/h/b", pid: 222 });
}

test("attenteDeLaLettre : ambigu → avis nommé ; inconnu → avis destinataire-inconnu ; et ne jette JAMAIS", (t) => {
  const root = maisonJetable();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  t.after(() => db.close());
  ligneeAmbigue(db, "alice-attente");
  const avis = attenteDeLaLettre(db, "alice-attente");
  assert.equal(avis.motif, "lignee-ambigue");
  assert.equal(avis.candidats, 2);
  // Un avis est une phrase : il commence par une majuscule, puisque la page
  // l'affiche après « This letter will wait. » (18/10).
  assert.match(avis.message, /^Ambiguous lineage \(2 chairs in service, none designated\): /);
  assert.match(avis.message, /designation/, "l'avis dit au posteur QUOI attendre, pas juste un code");
  assert.match(avis.message, /valxos-chaise moissonner/, "I-3 : l'avis nomme aussi le second remède, la moisson");
  // Renversement du 20/08 : la vague B avait exclu l'inconnu (« un autre motif,
  // débattable »). Le débat s'est tranché le jour même — une lettre vers
  // une variante du nom d'un pair, jamais registrée, a reçu un sent:true sec et a attendu en
  // silence, même famille exacte que la seq 81. L'inconnu attend AUSSI désormais.
  const avisInconnu = attenteDeLaLettre(db, "personne-de-ce-nom");
  assert.equal(avisInconnu.motif, "destinataire-inconnu");
  assert.match(avisInconnu.message, /^No peer in service answers to this name: /);
  assert.match(avisInconnu.message, /waits until/);
  assert.equal(attenteDeLaLettre(null, "peu-importe"), null, "un avis qui jette casserait le send : il se tait");
});

test("le send MCP porte l'attente — et sent:true reste sent:true", async () => {
  const root = maisonJetable();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  ligneeAmbigue(db, "alice-attente");
  db.close();
  const client = new Client({ name: "cc2cc-attente-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(repo, "src/mcp-server/server.js")],
    env: { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_SELF: "posteur-mcp" }
  });
  await client.connect(transport);
  try {
    const reponse = await client.callTool({
      name: "send",
      arguments: { to: "alice-attente", body: "la lettre qui refuse les dés" }
    });
    const contenu = JSON.parse(reponse.content[0].text);
    assert.equal(contenu.sent, true, "l'avis ne casse JAMAIS la prise en charge (A9)");
    assert.equal(contenu.attente.motif, "lignee-ambigue");
    assert.equal(contenu.attente.candidats, 2);
    // R1 (remède de la revue adverse, trouvaille #2) : « posteur-mcp » est une
    // fiche PLATE (ensureSelf — aucune lignée, aucune session), la MÊME forme
    // que « alice-heritee ».
    // Un envoi vers soi-même n'y échappe pas : la lettre attend elle aussi.
    const versSoiMeme = await client.callTool({
      name: "send",
      arguments: { to: "posteur-mcp", body: "à moi-même" }
    });
    const contenuSoiMeme = JSON.parse(versSoiMeme.content[0].text);
    assert.equal(contenuSoiMeme.sent, true, "l'avis ne casse JAMAIS la prise en charge (A9)");
    assert.equal(contenuSoiMeme.attente.motif, "chaise-sans-session");
  } finally {
    await client.close();
  }
});

test("le send MCP vers un inconnu porte destinataire-inconnu — et sent:true reste sent:true", async () => {
  const root = maisonJetable();
  // Une VRAIE chaise (registerInstance : lignée + session) pour la contre-
  // épreuve du calme — depuis R1, une fiche plate (ensureSelf/register) ne
  // l'est plus jamais (voir le send vers soi-même, test précédent).
  const db = openDatabase({ file: path.join(root, "broker.db") });
  registerInstance(db, { lineage: "pair-vivant", sessionId: "eeee5555-0000-4000-8000-000000000005", house: "/h/work", pid: 555 });
  db.close();
  const client = new Client({ name: "cc2cc-attente-inconnu-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(repo, "src/mcp-server/server.js")],
    env: { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_SELF: "posteur-mcp" }
  });
  await client.connect(transport);
  try {
    const reponse = await client.callTool({
      name: "send",
      arguments: { to: "personne-de-ce-nom", body: "vers un nom jamais registré" }
    });
    const contenu = JSON.parse(reponse.content[0].text);
    assert.equal(contenu.sent, true, "l'avis ne casse JAMAIS la prise en charge (A9)");
    assert.equal(contenu.attente.motif, "destinataire-inconnu");
    // C1 (remède de la revue adverse #3) : « pair-vivant » a une session vivante mais une
    // maison (/h/work) qu'AUCUN scan réel ne connaît — avant C1, ça se lisait
    // comme calme (attenteDeLaLettre ne regardait pas les maisons) ; depuis,
    // c'est exactement le motif maison-inconnue que la tournée aurait rendu.
    // Le silence des cas VRAIMENT sains (session ET maison ET boîte réelles)
    // est prouvé ailleurs (test dédié, avec un vrai scan de maison).
    const pasCalme = await client.callTool({
      name: "send",
      arguments: { to: "pair-vivant", body: "vers une chaise à la maison inconnue" }
    });
    const contenuPasCalme = JSON.parse(pasCalme.content[0].text);
    assert.equal(contenuPasCalme.sent, true, "l'avis ne casse JAMAIS la prise en charge (A9)");
    assert.equal(contenuPasCalme.attente.motif, "maison-inconnue");
  } finally {
    await client.close();
  }
});

test("le send CLI porte la même attente — un seul texte, jamais des jumeaux", (t) => {
  const root = maisonJetable();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  t.after(() => db.close());
  ligneeAmbigue(db, "alice-attente");
  const sortie = execFileSync(
    "node",
    [path.join(repo, "src/bin/valxos-send.js"), "--self", "posteur-cli", "--to", "alice-attente", "--body", "x"],
    { encoding: "utf8", env: { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_SELF: "posteur-cli" } }
  );
  const contenu = JSON.parse(sortie);
  assert.equal(contenu.sent, true);
  assert.equal(contenu.attente.motif, "lignee-ambigue");
  assert.equal(contenu.attente.candidats, 2);
});

// R1 (remède de la revue adverse, trouvaille #2, la troisième porte) — une
// fiche HÉRITÉE (ce qu'écrit `ensureSelf` à CHAQUE appel MCP : un id, un
// status, AUCUNE lignée, AUCUNE session) résout en `kind:"instance"`
// (marche 3 de `resoudreNomVivant`, registry.js) mais ne mène à AUCUNE
// session livrable — le Facteur la refusera par le même mot
// (`trouverLaBoite`, round.js:443 : motif
// chaise-sans-session). Avant ce remède l'avis était `null` : le posteur
// recevait un sent:true sec sur une lettre qui n'arrivera jamais.
function ficheHeritee(db, id) {
  registerPeer(db, { id, status: "active" });
}

test("attenteDeLaLettre : fiche héritée sans session → chaise-sans-session, et dit la VRAIE limite (pas de push, pas « illisible »)", (t) => {
  const root = maisonJetable();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  t.after(() => db.close());
  ficheHeritee(db, "alice-heritee");
  const avis = attenteDeLaLettre(db, "alice-heritee");
  assert.equal(avis.motif, "chaise-sans-session");
  assert.match(avis.message, /^Card without a live session /, "un avis est une phrase, majuscule comprise");
  // listInbox (database.js) ne filtre QUE sur `recipient`, jamais sur une
  // session : le destinataire relève sa boîte à tout moment, sans annonce.
  // L'avis doit dire CETTE limite (pas de sonnette pour la tournée du
  // Facteur), jamais « personne ne pourra jamais la lire » — la première
  // formulation le disait mal ; ce test garde le mot juste.
  assert.match(avis.message, /inbox/, "l'avis dit au posteur COMMENT la lettre reste lisible, pas juste un code");
  assert.doesNotMatch(
    avis.message,
    /announces itself under this name/,
    "régression : l'avis ne doit plus prétendre qu'une annonce de session est la SEULE issue"
  );
  // Round 2 du même remède : « la lettre n'arrive pas d'elle-même » était
  // FAUX aussi — porteDeReveil retombe sur cible.id pour cette même fiche,
  // et un auditeur sur run/<nom>.sock reçoit le réveil DIRECT de l'envoi
  // (wake) malgré ce motif (voir le test MCP juste après, qui le prouve en
  // direct). L'avis doit nommer SPÉCIFIQUEMENT la tournée périodique.
  assert.match(avis.message, /periodic round/, "l'avis nomme la tournée du Facteur, pas « aucune porte »");
  assert.doesNotMatch(
    avis.message,
    /(will not|does not|never) arrive (by|on) itself|no door is open/i,
    "régression : l'avis ne doit plus prétendre qu'AUCUN réveil ne peut arriver — le wake direct le peut"
  );
});

test("le send MCP vers une fiche héritée porte chaise-sans-session — et sent:true reste sent:true", async () => {
  const root = maisonJetable();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  ficheHeritee(db, "alice-heritee");
  db.close();
  const client = new Client({ name: "cc2cc-attente-heritee-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(repo, "src/mcp-server/server.js")],
    env: { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_SELF: "posteur-mcp-heritee" }
  });
  await client.connect(transport);
  try {
    const reponse = await client.callTool({
      name: "send",
      arguments: { to: "alice-heritee", body: "vers une fiche héritée sans session" }
    });
    const contenu = JSON.parse(reponse.content[0].text);
    assert.equal(contenu.sent, true, "l'avis ne casse JAMAIS la prise en charge (A9)");
    assert.equal(contenu.attente.motif, "chaise-sans-session");
  } finally {
    await client.close();
  }
});

// LE PARADOXE PROUVÉ EN DIRECT (round 3 du même remède) : `porteDeReveil`
// retombe sur `cible.id` pour une fiche sans lignée — EXACTEMENT la fiche que
// ce motif décrit — et `pokeAgentSocket` poke ce nom-là au moment de l'envoi,
// indépendamment de `instance_session_id`. Un auditeur qui écoute déjà sur
// `run/<nom>.sock` reçoit donc le réveil DIRECT et le msg_id, dans la MÊME
// réponse qui porte `attente.motif:"chaise-sans-session"`. Les deux champs ne
// se contredisent plus depuis que le message nomme la tournée PÉRIODIQUE et
// non « aucune porte » — ce test fige la preuve pour que ça ne se reperde pas.
// sun_path plafonne à 104 octets sur macOS/BSD (108 Linux) — un socket Unix
// RÉEL, pas une base SQLite (aucune limite comparable). `maisonJetable()`
// (préfixe cc2cc-attente-, 14) + un nom de pair long donnait 87/104 : 17
// octets de marge, un TMPDIR plus long (CI, utilisateur au nom long) le
// dépasserait avec un EINVAL opaque plutôt qu'un message clair. Racine ET
// nom de pair courts ici, délibérément, PLUS un garde-fou qui saute
// proprement (au lieu d'échouer opaquement) si un système donné dépasse
// quand même.
function racineCourte() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc2-w-"));
}

// Le chemin que racineCourte() rendra, mesuré AVANT le test (mkdtemp ajoute
// six caractères) : trop long pour sun_path, le test se met en quarantaine
// nommée au lieu de se sauter en silence dans son corps (Run 6, RUN6-Q2).
const SOCKET_TROP_LONG = Buffer.byteLength(path.join(os.tmpdir(), "cc2-w-XXXXXX", "run", "e.sock"), "utf8") > 104;

test("chaise-sans-session ET wake.ok:true peuvent coexister dans la MÊME réponse — l'avis ne prétend plus le contraire", quarantaine("RUN6-Q2", "exige un dossier temporaire assez court pour un socket unix (sun_path, 104 octets)", SOCKET_TROP_LONG), async () => {
  const root = racineCourte();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  ficheHeritee(db, "e");
  db.close();

  fs.mkdirSync(path.join(root, "run"), { recursive: true });
  const socketPath = path.join(root, "run", "e.sock");
  const longueurOctets = Buffer.byteLength(socketPath, "utf8");
  // TROIS ISSUES : la quarantaine a mesuré le chemin d'avance ; s'il dépasse
  // quand même, la sonde est impossible et le dit — jamais un vert par absence.
  assert.ok(longueurOctets <= 104, `SONDE IMPOSSIBLE : chemin de socket trop long pour sun_path (${longueurOctets} octets, plafond 104) : ${socketPath}`);

  let signalerRecu;
  const recuPromise = new Promise((resolve) => { signalerRecu = resolve; });
  const auditeur = net.createServer((conn) => {
    conn.on("data", (chunk) => signalerRecu(chunk.toString().trim()));
  });
  await new Promise((resolve) => auditeur.listen(socketPath, resolve));

  const client = new Client({ name: "cc2cc-wake-paradoxe-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(repo, "src/mcp-server/server.js")],
    env: { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_SELF: "posteur-paradoxe" }
  });
  await client.connect(transport);
  try {
    const reponse = await client.callTool({
      name: "send",
      arguments: { to: "e", body: "la lettre qui teste le paradoxe" }
    });
    const contenu = JSON.parse(reponse.content[0].text);
    assert.equal(contenu.attente.motif, "chaise-sans-session", "la tournée périodique ne trouve toujours personne");
    assert.equal(contenu.wake.ok, true, "mais LE RÉVEIL DIRECT de cet envoi a réussi — un auditeur écoutait");
    // pokeAgentSocket résout au CONNECT (client.end() met l'écriture en
    // FILE, il ne la garantit pas reçue) : attendre un délai fixe fait
    // courir l'assertion contre le flush au lieu de l'attendre. On attend
    // l'événement RÉEL, avec un filet de temps qui ne sert qu'en cas
    // d'échec véritable.
    const recu = await Promise.race([
      recuPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("l'auditeur n'a rien reçu sous 2s")), 2000))
    ]);
    assert.equal(recu, contenu.msg_id, "et le msg_id est vraiment arrivé chez l'auditeur, pas juste ok:true déclaratif");
  } finally {
    await client.close();
    auditeur.close();
  }
});

// Le fait s'installe AVANT la mort : on désigne une chaise vivante, puis on
// constate sa mort (le geste de la moisson, rejoué à la main sur base jetable).
function ligneeVeuveDeSaDesignee(db, lignee) {
  ligneeAmbigue(db, lignee);
  registerInstance(db, { lineage: lignee, sessionId: "cccc3333-0000-4000-8000-000000000003", house: "/h/work", pid: 333 });
  designatePrimary(db, lignee, "cccc3333-0000-4000-8000-000000000003");
  db.prepare("UPDATE peers SET status = 'dead', dead_at = '2026-08-18T12:00:00Z' WHERE instance_session_id = 'cccc3333-0000-4000-8000-000000000003'").run();
}

test("l'ambiguïté RACONTE la désignée morte — le fait naît dans la résolution, jamais dans une surface", (t) => {
  const root = maisonJetable();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  t.after(() => db.close());
  ligneeVeuveDeSaDesignee(db, "alice-veuve");
  const res = resolveRecipient(db, "alice-veuve");
  assert.equal(res.kind, "ambigu", "la lignée reste AMBIGUË — le récit ne change pas le routage");
  assert.equal(res.designee_morte.session, "cccc3333-0000-4000-8000-000000000003");
  assert.equal(res.designee_morte.statut, "dead");
  assert.equal(res.designee_morte.depuis, "2026-08-18T12:00:00Z");
  // Et une ambiguïté SANS veuvage ne porte pas le champ : le silence des cas sains.
  ligneeAmbigue(db, "alice-jamais-designee");
  assert.equal(resolveRecipient(db, "alice-jamais-designee").designee_morte, undefined);
});

test("le posteur entend le remède : RE-désigner, pas seulement « ambiguë »", (t) => {
  const root = maisonJetable();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  t.after(() => db.close());
  ligneeVeuveDeSaDesignee(db, "alice-veuve");
  const avis = attenteDeLaLettre(db, "alice-veuve");
  assert.equal(avis.motif, "lignee-ambigue", "le motif ne bouge pas — même famille d'attente que le Facteur");
  assert.equal(avis.designee_morte.session, "cccc3333-0000-4000-8000-000000000003");
  assert.match(avis.message, /^Ambiguous lineage: the designated chair /, "un avis est une phrase, majuscule comprise");
  assert.match(avis.message, /RE-designation/);
  assert.match(avis.message, /\bdead\b/);
  assert.match(avis.message, /valxos-chaise moissonner/, "I-3 : la moisson est le second remède, et l'avis la nomme");
});

// Une chaise RETIRÉE À LA MAIN (`offline`, sans dead_at — le geste humain, pas
// le constat de la moisson) porte le même récit, avec un autre mot : « retirée
// du service », jamais « morte ». C'est ce que libelleStatut existe pour dire
// une seule fois — sinon deux surfaces divergent en silence.
function ligneeVeuveOffline(db, lignee) {
  ligneeAmbigue(db, lignee);
  registerInstance(db, { lineage: lignee, sessionId: "dddd4444-0000-4000-8000-000000000004", house: "/h/work", pid: 444 });
  designatePrimary(db, lignee, "dddd4444-0000-4000-8000-000000000004");
  db.prepare("UPDATE peers SET status = 'offline' WHERE instance_session_id = 'dddd4444-0000-4000-8000-000000000004'").run();
}

test("libelleStatut distingue « retirée du service » (offline) de « morte » (dead), et l'avis suit le même mot", (t) => {
  assert.equal(libelleStatut("offline"), "retired from service");
  assert.equal(libelleStatut("dead"), "dead");

  const root = maisonJetable();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  t.after(() => db.close());
  ligneeVeuveOffline(db, "alice-offline");
  const avis = attenteDeLaLettre(db, "alice-offline");
  assert.match(avis.message, /retired from service/);
  assert.doesNotMatch(avis.message, /\bdead\b/, "une chaise retirée à la main n'est pas « morte »");
});

// R3 (remède vague D) — la loi actée : « toute lettre qui ATTENDRA prévient
// son posteur ». Le handler broadcast poussait {to, msg_id, seq, wake} sans
// jamais consulter l'attente — un posteur qui diffuse vers une lignée
// ambiguë n'apprenait rien de plus qu'un send calme.
test("le broadcast prévient aussi : la lignée ambiguë, la fiche plate ET la chaise à maison inconnue portent toutes l'attente", async (t) => {
  const root = maisonJetable();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  ligneeAmbigue(db, "alice-broadcast-ambigue");
  // C1 (remède de la revue adverse #3) : session vivante, mais maison (/h/work) qu'AUCUN scan
  // réel ne connaît — avant C1 ça se lisait comme calme, depuis c'est
  // maison-inconnue (voir le test MCP jumeau, même raison, même correction).
  registerInstance(db, { lineage: "pair-vivant-broadcast", sessionId: "ffff6666-0000-4000-8000-000000000006", house: "/h/work", pid: 666 });
  db.close();

  const client = new Client({ name: "cc2cc-broadcast-attente-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(repo, "src/mcp-server/server.js")],
    env: { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_SELF: "posteur-broadcast" }
  });
  await client.connect(transport);
  try {
    // R1 : un pair enregistré À PLAT (register — aucune lignée, aucune
    // session) est la MÊME forme que « alice-heritee ». Il attend désormais lui aussi.
    await client.callTool({ name: "register", arguments: { id: "pair-plat" } });

    const diffusion = await client.callTool({ name: "broadcast", arguments: { body: "appel général" } });
    const contenu = JSON.parse(diffusion.content[0].text);
    assert.equal(contenu.count, 3, "la lignée ambiguë, la fiche plate ET la chaise reçoivent chacune une lettre");

    const versLaLigneeAmbigue = contenu.results.find((r) => r.to === "alice-broadcast-ambigue");
    assert.ok(versLaLigneeAmbigue, "la lignée ambiguë est bien une cible du broadcast");
    assert.equal(versLaLigneeAmbigue.attente.motif, "lignee-ambigue");

    const versLaFichePlate = contenu.results.find((r) => r.to === "pair-plat");
    assert.ok(versLaFichePlate, "la fiche plate est bien une cible du broadcast");
    assert.equal(versLaFichePlate.attente.motif, "chaise-sans-session");

    const versLaChaiseAMaisonInconnue = contenu.results.find((r) => r.to === "pair-vivant-broadcast");
    assert.ok(versLaChaiseAMaisonInconnue, "la chaise à maison inconnue est bien une cible du broadcast");
    assert.equal(versLaChaiseAMaisonInconnue.attente.motif, "maison-inconnue");
  } finally {
    await client.close();
  }
});

// UNE SEULE RÉSOLUTION (remède de la revue adverse #3, C2) — `send`/`broadcast` posaient DEUX
// résolutions par lettre : une pour `porteDeReveil` (le réveil), une pour
// `attenteDeLaLettre` (l'avis), avec un `await pokeAgentSocket` entre les
// deux (jusqu'à 500 ms). Le registre pouvait bouger dans cet écart — la
// revue adverse a rejoué la course et obtenu 4 divergences sur 12 lettres. La preuve
// STRUCTURELLE (le remède suggéré quand la course elle-même n'est pas
// rendue déterministe) : geler une résolution à l'instant T1, faire bouger
// le registre vers un état DIFFÉRENT (T2), puis vérifier que les deux
// fonctions lisent TOUJOURS T1 quand on la leur passe — la preuve qu'aucune
// des deux ne re-interroge le registre en silence dès qu'on leur en fournit
// une.
test("porteDeReveil et attenteDeLaLettre restent gelés sur une résolution fournie, même si le registre a bougé depuis", (t) => {
  const root = maisonJetable();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  t.after(() => db.close());

  // T1 : une seule chaise vivante, adressée par un ANCIEN NOM — le nom écrit
  // (« ancien-c2 ») et le nom résolu (« alice-c2 ») DIFFÈRENT exprès : c'est
  // ce qui rend le gel OBSERVABLE sur porteDeReveil (qui rend sinon le même
  // nom qu'on lui a tendu dans les deux états, une coïncidence qui ne
  // prouverait rien).
  registerInstance(db, { lineage: "alice-c2", sessionId: "c2c2c2c2-0000-4000-8000-000000000001", house: "/h/work", pid: 21 });
  deposerAncienNom(db, "ancien-c2", "alice-c2");
  const resolutionGelee = resolveRecipient(db, "ancien-c2");
  assert.equal(resolutionGelee.kind, "lineage", "T1 : une seule chaise, pas d'ambiguïté — l'état qu'on va geler");
  assert.equal(resolutionGelee.targets[0].lineage, "alice-c2");

  // T2 : le registre bouge — une SECONDE chaise apparaît, la lignée devient
  // ambiguë. Le direct (sans résolution fournie) DOIT le voir ; le gelé NON.
  registerInstance(db, { lineage: "alice-c2", sessionId: "c2c2c2c2-0000-4000-8000-000000000002", house: "/h/work", pid: 22 });

  const enDirect = attenteDeLaLettre(db, "ancien-c2");
  assert.equal(enDirect.motif, "lignee-ambigue", "sans résolution fournie : le direct voit bien T2 (l'ambiguïté toute neuve)");

  const gele = attenteDeLaLettre(db, "ancien-c2", resolutionGelee);
  assert.equal(gele, null, "avec la résolution de T1 fournie : AUCUNE re-interrogation — l'état sain de T1 reste sain");

  // Le réveil : en T2, une lignée ambiguë ne désigne aucune cible unique —
  // porteDeReveil retombe sur le nom ÉCRIT (« ancien-c2 »). En T1 gelé, une
  // seule cible existait — il rend la lignée RÉSOLUE (« alice-c2 »). Deux
  // valeurs DIFFÉRENTES : exactement la divergence que la revue adverse a prouvée entre
  // wake et attente quand chacun résolvait la sienne.
  const porteEnDirect = porteDeReveil(db, "ancien-c2");
  assert.equal(porteEnDirect, "ancien-c2", "sans résolution fournie : lignée ambiguë en T2 → le nom écrit, pas une chaise précise");

  const porteGelee = porteDeReveil(db, "ancien-c2", resolutionGelee);
  assert.equal(porteGelee, "alice-c2", "avec T1 gelé : une seule cible → la lignée résolue, cohérente avec T1 — PAS le T2 ambigu");
});

// LE SILENCE DES CAS VRAIMENT SAINS, PAR LE VRAI GUICHET (remède de la revue adverse #3, C1).
// Les fixtures « pair-vivant »/« pair-vivant-broadcast » plus haut avaient une
// maison FICTIVE (/h/work) qu'aucun scan réel ne connaît — depuis C1 elles
// montrent donc maison-inconnue, ce qui est vrai, mais ça laisse un trou : le
// guichet MCP RÉEL (send, avec un VRAI scannerLesMaisons()) sait-il encore se
// taire pour une chaise VRAIMENT joignable (session + maison + boîte) ? Ce
// test construit une fiche réelle sur disque, dans une maison que
// CC2CC_MAISONS pointe explicitement (isolation : jamais le $HOME réel de la
// machine), avec le VRAI procStart du process courant — la voie « registre »
// de verdictDeVivacite, pas la sonde socket (plus simple, pas de contrainte
// sun_path).
test("le send MCP RÉEL (scan de maison compris) reste silencieux pour une chaise vraiment joignable", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc2-h-"));
  const maison = fs.mkdtempSync(path.join(os.tmpdir(), "cc2-m-"));
  const sessions = path.join(maison, "sessions");
  fs.mkdirSync(sessions, { recursive: true });

  const db = openDatabase({ file: path.join(root, "broker.db") });
  const sessionId = "d0d0d0d0-0000-4000-8000-000000000001";
  registerInstance(db, { lineage: "vraiment-vivante", sessionId, house: maison, pid: process.pid });
  db.close();

  const monProcStart = procStartOf(process.pid);
  assert.ok(monProcStart, "sonde impossible : sans lstart lisible pour ce process, ce test ne prouve RIEN");
  fs.writeFileSync(
    path.join(sessions, `${process.pid}.json`),
    JSON.stringify({
      messagingSocketPath: path.join(maison, "n.sock"),
      pid: process.pid,
      sessionId,
      procStart: monProcStart
    })
  );

  const client = new Client({ name: "cc2cc-vraie-maison-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(repo, "src/mcp-server/server.js")],
    env: { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_MAISONS: maison, CC2CC_SELF: "posteur-vraie-maison" }
  });
  await client.connect(transport);
  try {
    const reponse = await client.callTool({
      name: "send",
      arguments: { to: "vraiment-vivante", body: "vers une chaise vraiment joignable" }
    });
    const contenu = JSON.parse(reponse.content[0].text);
    assert.equal(contenu.sent, true);
    assert.equal(
      contenu.attente,
      undefined,
      "pas d'attente = pas de champ — silence des cas VRAIMENT sains, prouvé par le vrai guichet MCP avec un vrai scan"
    );
  } finally {
    await client.close();
  }
});
