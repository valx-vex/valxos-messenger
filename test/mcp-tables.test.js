// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LES TABLES AU GUICHET MCP (1.1.0) : un envoi à `table:<nom>`, l'enclos, la
// liste des tables, leur gestion depuis une session, l'état d'un envoi, et
// l'en-tête de table sur chaque lettre relevée.
//
// ⚠️ Toutes les bases de ce fichier sont JETABLES (mkdtemp + CC2CC_V2_HOME),
// garde du bureau vivant posée pour le runner et pour chaque serveur enfant.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { insertMessage, markDelivered, openDatabase, registerPeer } from "../src/lib/database.js";
import { ajouterMembre, creerTable, obtenirTable, poserEnclos, retirerMembre } from "../src/lib/tables.js";
import { registerInstance } from "../src/lib/registry.js";
import { procStartOf } from "../src/lib/postbox.js";
import { spawn } from "node:child_process";
import { envPropre, poserLeBureau } from "./aide-env.js";

const BUREAU_INITIAL = process.env.CC2CC_V2_HOME;
const GARDE_INITIALE = process.env.CC2CC_GARDE_BUREAU;
poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "valxos-mcp-tables-plancher-")));
process.env.CC2CC_GARDE_BUREAU = "1";
after(() => {
  if (BUREAU_INITIAL === undefined) delete process.env.CC2CC_V2_HOME;
  else process.env.CC2CC_V2_HOME = BUREAU_INITIAL;
  if (GARDE_INITIALE === undefined) delete process.env.CC2CC_GARDE_BUREAU;
  else process.env.CC2CC_GARDE_BUREAU = GARDE_INITIALE;
});

const repo = path.resolve(new URL("..", import.meta.url).pathname);

// Un serveur par IDENTITÉ : le nom vient de l'environnement qui le lance.
async function connecter(root, self, envEnPlus = {}) {
  const client = new Client({ name: `valxos-tables-test-${self}`, version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(repo, "src/mcp-server/server.js")],
    env: { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_GARDE_BUREAU: "1", CC2CC_SELF: self, ...envEnPlus }
  });
  await client.connect(transport);
  return client;
}

// Une erreur d'outil n'est pas du JSON : on la rend telle quelle, pour qu'une
// régression (un outil absent, un schéma refusé) se lise dans le message du test.
const outil = async (c, name, args = {}) => {
  const r = await c.callTool({ name, arguments: args });
  return r.isError ? { erreur: r.content[0].text } : JSON.parse(r.content[0].text);
};

// Le bureau de ce fichier : une table ouverte « famille-test » (alice, bob,
// carol) et une table fermée « office-test » (alice, hal-test). Les membres
// d'une table fermée se posent ici par le carnet (le geste de la CLI), jamais
// par l'outil MCP — c'est ce que les tests prouvent ensuite.
function bureauAvecTables(prefixe) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefixe));
  const db = openDatabase({ file: path.join(root, "broker.db") });
  creerTable(db, { nom: "famille-test", creeePar: "alice" });
  for (const membre of ["alice", "bob", "carol"]) ajouterMembre(db, "famille-test", membre, { ajoutePar: "alice" });
  creerTable(db, { nom: "office-test", fermee: true, creeePar: "alice" });
  for (const membre of ["alice", "hal-test"]) ajouterMembre(db, "office-test", membre, { ajoutePar: "alice" });
  db.close();
  return { root, ouvrir: () => openDatabase({ file: path.join(root, "broker.db") }) };
}

function lignes(ouvrir, sql, ...params) {
  const db = ouvrir();
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

// ── A. L'ENVOI À UNE TABLE ───────────────────────────────────────────────────
test("send à table:<nom> — une lettre par membre hors expéditeur, liées par envoi_id, le réveil décidé par la table", async () => {
  const { root, ouvrir } = bureauAvecTables("valxos-mcp-tables-send-");
  const alice = await connecter(root, "alice");
  try {
    const envoi = await outil(alice, "send", { to: "table:famille-test", subject: "Beat 7", body: "the beat" });
    assert.equal(envoi.sent, true, JSON.stringify(envoi));
    assert.equal(envoi.table.nom, "famille-test");
    assert.equal(envoi.table.mode, "normal");
    assert.equal(envoi.count, 2, "une lettre par membre, jamais une à l'expéditeur");
    assert.match(envoi.envoi_id, /^envoi-/);
    assert.deepEqual(envoi.results.map((r) => r.to).sort(), ["bob", "carol"]);
    for (const r of envoi.results) {
      assert.ok(r.msg_id && r.seq, "chaque lettre a sa clef et son seq");
      assert.ok("wake" in r, "chaque lettre dit si la sonnette a répondu");
      assert.equal(r.sans_reveil, false);
      assert.equal(r.motif_reveil, "table");
      assert.equal(r.attente?.motif, "destinataire-inconnu", "personne n'est inscrit : la lettre attend, et le dit");
    }
    const enBase = lignes(ouvrir, "SELECT recipient, envoi_id, table_nom, sender, sender_chaise, thread_id FROM messages ORDER BY seq");
    assert.deepEqual(enBase.map((l) => [l.recipient, l.table_nom, l.sender, l.sender_chaise]),
      [["bob", "famille-test", "alice", null], ["carol", "famille-test", "alice", null]]);
    assert.ok(enBase.every((l) => l.envoi_id === envoi.envoi_id), "les deux lettres portent le même envoi_id");
    assert.ok(enBase.every((l) => l.thread_id === envoi.envoi_id), "le fil par défaut est l'envoi_id du premier envoi");

    // Un envoi ordinaire ne change pas de forme — et ne porte pas de table.
    const direct = await outil(alice, "send", { to: "bob", body: "just you" });
    assert.equal(direct.sent, true);
    assert.equal(direct.recipient, "bob");
    assert.equal(direct.envoi_id, undefined, "un envoi à un pair n'est pas un envoi de table");
  } finally {
    await alice.close();
  }
});

// ── B. LES REFUS SE RENDENT, ILS NE SE LÈVENT JAMAIS VERS LE CLIENT ───────────
test("send à une table inconnue, à une table dont on n'est pas membre, ou à un nom invalide : un refus en JSON, rien d'écrit", async () => {
  const { root, ouvrir } = bureauAvecTables("valxos-mcp-tables-refus-");
  const bob = await connecter(root, "bob");
  try {
    const inconnue = await outil(bob, "send", { to: "table:nulle-part", body: "x" });
    assert.equal(inconnue.sent, false, JSON.stringify(inconnue));
    assert.equal(inconnue.refus, "table-inconnue");
    assert.equal(inconnue.table, "nulle-part");

    const pasMembre = await outil(bob, "send", { to: "table:office-test", body: "x" });
    assert.equal(pasMembre.sent, false, JSON.stringify(pasMembre));
    assert.equal(pasMembre.refus, "pas-membre");

    const invalide = await outil(bob, "send", { to: "table:Pas Un Nom", body: "x" });
    assert.equal(invalide.sent, false, JSON.stringify(invalide));
    assert.equal(invalide.refus, "nom-de-table-invalide");

    assert.equal(lignes(ouvrir, "SELECT count(*) AS n FROM messages")[0].n, 0, "aucun refus n'écrit de lettre");
  } finally {
    await bob.close();
  }
});

// ── C et D. L'ENCLOS : rien ne part hors de la table fermée, rien n'est écrit ─
test("un expéditeur sous enclos : send hors de sa table fermée refusé avant toute écriture, hors_enclos: true le laisse sortir", async () => {
  const { root, ouvrir } = bureauAvecTables("valxos-mcp-tables-enclos-");
  const prepare = ouvrir();
  poserEnclos(prepare, "hal-test", "office-test", { posePar: "operator" });
  prepare.close();
  const hal = await connecter(root, "hal-test");
  try {
    const refuse = await outil(hal, "send", { to: "bob", body: "out of the enclosure" });
    assert.equal(refuse.sent, false, JSON.stringify(refuse));
    assert.equal(refuse.refus, "hors-enclos");
    assert.equal(refuse.enclos, "office-test");
    assert.deepEqual(refuse.destinataires_refuses, ["bob"]);
    assert.equal(lignes(ouvrir, "SELECT count(*) AS n FROM messages")[0].n, 0, "un refus d'enclos n'écrit rien");

    const dedans = await outil(hal, "send", { to: "alice", body: "inside" });
    assert.equal(dedans.sent, true, "un membre de la table fermée reçoit");
    const laTable = await outil(hal, "send", { to: "table:office-test", body: "to the table" });
    assert.equal(laTable.sent, true, JSON.stringify(laTable));
    assert.deepEqual(laTable.results.map((r) => r.to), ["alice"]);

    const sortie = await outil(hal, "send", { to: "bob", body: "stepping out", hors_enclos: true });
    assert.equal(sortie.sent, true, "hors_enclos: true est la clef, et elle reste dans la main de l'expéditeur");
    assert.equal(sortie.recipient, "bob");
    assert.equal(lignes(ouvrir, "SELECT count(*) AS n FROM messages")[0].n, 3);
  } finally {
    await hal.close();
  }
});

test("broadcast sous enclos : refus entier avant la première lettre, destinataires_refuses nomme les pairs hors de la table", async () => {
  const { root, ouvrir } = bureauAvecTables("valxos-mcp-tables-enclos-broadcast-");
  const prepare = ouvrir();
  poserEnclos(prepare, "hal-test", "office-test", { posePar: "operator" });
  prepare.close();
  const hal = await connecter(root, "hal-test");
  const alice = await connecter(root, "alice");
  const bob = await connecter(root, "bob");
  try {
    // Deux pairs en service : alice (membre de la table fermée) et bob (hors).
    await outil(alice, "register", { id: "alice" });
    await outil(bob, "register", { id: "bob" });
    const refuse = await outil(hal, "broadcast", { body: "to everyone" });
    assert.equal(refuse.broadcast, false, JSON.stringify(refuse));
    assert.equal(refuse.refus, "hors-enclos");
    assert.equal(refuse.enclos, "office-test");
    assert.deepEqual(refuse.destinataires_refuses, ["bob"]);
    assert.equal(refuse.count, 0);
    assert.equal(lignes(ouvrir, "SELECT count(*) AS n FROM messages")[0].n, 0, "la lettre à alice n'est pas partie non plus : le refus est entier");

    const sortie = await outil(hal, "broadcast", { body: "to everyone, on purpose", hors_enclos: true });
    assert.equal(sortie.broadcast, true, JSON.stringify(sortie));
    assert.deepEqual(sortie.results.map((r) => r.to).sort(), ["alice", "bob"]);
    assert.deepEqual(lignes(ouvrir, "SELECT sender_chaise FROM messages").map((l) => l.sender_chaise), [null, null], "un client sans fiche n'a pas de chaise à afficher");
  } finally {
    await hal.close();
    await alice.close();
    await bob.close();
  }
});

// ── E. LA LISTE DES TABLES : les ouvertes pour tous, les fermées pour leurs membres ─
test("tables : les tables ouvertes et celles dont on est membre, avec membres, réglages, position et mon_reveil", async () => {
  const { root, ouvrir } = bureauAvecTables("valxos-mcp-tables-liste-");
  const prepare = ouvrir();
  ajouterMembre(prepare, "famille-test", "carol", { reveil: "prochain-tour", ajoutePar: "alice" });
  prepare.close();
  const alice = await connecter(root, "alice");
  const bob = await connecter(root, "bob");
  const carol = await connecter(root, "carol");
  try {
    const pourAlice = await outil(alice, "tables");
    assert.equal(pourAlice.self, "alice");
    assert.deepEqual(pourAlice.tables.map((t) => t.nom), ["famille-test", "office-test"], "alice voit sa table fermée");
    const office = pourAlice.tables.find((t) => t.nom === "office-test");
    assert.equal(office.fermee, true);
    assert.equal(office.reveil, "reveil");
    assert.equal(office.mode, "normal");
    assert.equal(office.position, null);
    assert.deepEqual(office.membres, [{ adresse: "alice", reveil: null }, { adresse: "hal-test", reveil: null }]);
    assert.equal(office.mon_reveil, "reveil", "sans réglage propre, le réveil du membre est celui de la table");
    const famille = pourAlice.tables.find((t) => t.nom === "famille-test");
    assert.deepEqual(famille.membres.map((m) => m.adresse), ["alice", "bob", "carol"]);
    for (const champ of ["position", "position_par", "position_le"]) assert.equal(famille[champ], null, `${champ} vide tant que personne n'a posé de position`);

    const pourBob = await outil(bob, "tables");
    assert.deepEqual(pourBob.tables.map((t) => t.nom), ["famille-test"], "une table fermée est invisible à qui n'en est pas membre");

    const pourCarol = await outil(carol, "tables");
    assert.equal(pourCarol.tables.find((t) => t.nom === "famille-test").mon_reveil, "prochain-tour", "le réglage propre d'un membre prime sur celui de la table");
  } finally {
    await alice.close();
    await bob.close();
    await carol.close();
  }
});

// ── F. LA GESTION DEPUIS UNE SESSION : les tables ouvertes ; les fermées restent un geste humain ─
test("table_manage : create / add / remove / reveil / mode / position sur une table ouverte ; table-fermee pour add, remove et create fermée", async () => {
  const { root, ouvrir } = bureauAvecTables("valxos-mcp-tables-manage-");
  const alice = await connecter(root, "alice");
  const bob = await connecter(root, "bob");
  const carol = await connecter(root, "carol");
  const hal = await connecter(root, "hal-test");
  try {
    // create : l'appelant devient le premier membre de sa table.
    const creee = await outil(alice, "table_manage", { action: "create", nom: "film-test", mode: "direct" });
    assert.equal(creee.ok, true, JSON.stringify(creee));
    assert.equal(creee.table.nom, "film-test");
    assert.equal(creee.table.mode, "direct");
    assert.equal(creee.table.fermee, false);
    assert.deepEqual(creee.table.membres, [{ adresse: "alice", reveil: null }]);
    assert.equal(creee.table.mon_reveil, "reveil");
    assert.equal((await outil(alice, "table_manage", { action: "create", nom: "film-test" })).refus, "table-existe");
    assert.equal((await outil(alice, "table_manage", { action: "create", nom: "Pas Un Nom" })).refus, "nom-de-table-invalide");
    const fermeeRefusee = await outil(alice, "table_manage", { action: "create", nom: "fermee-test", fermee: true });
    assert.equal(fermeeRefusee.ok, false);
    assert.equal(fermeeRefusee.refus, "table-fermee", "une table fermée se crée à la CLI, jamais d'ici");
    assert.equal(lignes(ouvrir, "SELECT count(*) AS n FROM tables WHERE nom = 'fermee-test'")[0].n, 0, "rien n'a été créé");

    // add / remove : sur une table ouverte ; refusé sur une table fermée.
    const ajout = await outil(alice, "table_manage", { action: "add", nom: "film-test", adresse: "bob" });
    assert.deepEqual(ajout.table.membres.map((m) => m.adresse), ["alice", "bob"]);
    assert.equal((await outil(alice, "table_manage", { action: "add", nom: "office-test", adresse: "bob" })).refus, "table-fermee");
    assert.equal((await outil(alice, "table_manage", { action: "add", nom: "nulle-part", adresse: "bob" })).refus, "table-inconnue");
    assert.equal((await outil(hal, "table_manage", { action: "remove", nom: "office-test", adresse: "alice" })).refus, "table-fermee");

    // reveil : sans adresse, soi-même — toujours permis à un membre, table fermée comprise.
    const monReveil = await outil(bob, "table_manage", { action: "reveil", nom: "film-test", reveil: "prochain-tour" });
    assert.equal(monReveil.ok, true, JSON.stringify(monReveil));
    assert.equal(monReveil.table.mon_reveil, "prochain-tour");
    assert.deepEqual(monReveil.table.membres, [{ adresse: "alice", reveil: null }, { adresse: "bob", reveil: "prochain-tour" }]);
    assert.equal((await outil(hal, "table_manage", { action: "reveil", nom: "office-test", reveil: "prochain-tour" })).table.mon_reveil, "prochain-tour", "sur soi-même, une table fermée aussi");
    assert.equal((await outil(bob, "table_manage", { action: "reveil", nom: "office-test", reveil: "reveil" })).refus, "pas-membre");
    // reveil d'un AUTRE membre : table ouverte seulement.
    const reveilDeBob = await outil(alice, "table_manage", { action: "reveil", nom: "film-test", adresse: "bob", reveil: "reveil" });
    assert.deepEqual(reveilDeBob.table.membres.find((m) => m.adresse === "bob"), { adresse: "bob", reveil: "reveil" });
    assert.equal((await outil(hal, "table_manage", { action: "reveil", nom: "office-test", adresse: "alice", reveil: "prochain-tour" })).refus, "table-fermee");
    assert.equal((await outil(alice, "table_manage", { action: "reveil", nom: "film-test", adresse: "carol", reveil: "reveil" })).refus, "pas-membre", "carol n'est pas membre de film-test");

    // mode et position : aux membres, tables fermées comprises ; refusés aux autres.
    assert.equal((await outil(bob, "table_manage", { action: "mode", nom: "film-test", mode: "normal" })).table.mode, "normal");
    assert.equal((await outil(carol, "table_manage", { action: "mode", nom: "film-test", mode: "direct" })).refus, "pas-membre");
    const position = await outil(hal, "table_manage", { action: "position", nom: "office-test", position: "seen up to 1:25:00" });
    assert.equal(position.ok, true, JSON.stringify(position));
    assert.equal(position.table.position, "seen up to 1:25:00");
    assert.equal(position.table.position_par, "hal-test");
    assert.ok(position.table.position_le, "la position est datée");
    const tropLongue = await outil(hal, "table_manage", { action: "position", nom: "office-test", position: "x".repeat(121) });
    assert.ok(tropLongue.erreur, "121 caractères : le schéma refuse avant le gestionnaire");

    // remove : la table reste, le membre est marqué retiré, jamais effacé (Camp B).
    const retrait = await outil(alice, "table_manage", { action: "remove", nom: "film-test", adresse: "bob" });
    assert.deepEqual(retrait.table.membres.map((m) => m.adresse), ["alice"]);
    assert.equal(lignes(ouvrir, "SELECT count(*) AS n FROM table_membres WHERE nom_table = 'film-test'")[0].n, 2, "la ligne de bob survit, marquée");
  } finally {
    await alice.close();
    await bob.close();
    await carol.close();
    await hal.close();
  }
});

// ── G. L'ÉTAT D'UN ENVOI, MEMBRE PAR MEMBRE — servi à l'expéditeur seul ──────
test("envoi_status : créé / sonné / montré / accusé par lettre, la cible résolue, l'attente ; pas-expediteur pour les autres", async () => {
  const { root } = bureauAvecTables("valxos-mcp-tables-status-");
  const alice = await connecter(root, "alice");
  const bob = await connecter(root, "bob");
  try {
    const envoi = await outil(alice, "send", { to: "table:famille-test", subject: "status", body: "who saw it" });
    assert.equal(envoi.sent, true, JSON.stringify(envoi));

    const avant = await outil(alice, "envoi_status", { envoi_id: envoi.envoi_id });
    assert.equal(avant.envoi_id, envoi.envoi_id);
    assert.equal(avant.table, "famille-test");
    assert.equal(avant.count, 2);
    assert.deepEqual(avant.lettres.map((l) => l.recipient), ["bob", "carol"]);
    for (const lettre of avant.lettres) {
      assert.ok(lettre.msg_id);
      assert.ok(lettre.etats.cree, "créée dès l'envoi");
      assert.equal(lettre.etats.sonne, null, "personne n'écoute : pas sonnée");
      assert.equal(lettre.etats.montre, null);
      assert.equal(lettre.etats.accuse, null);
      assert.equal(lettre.cible, null, "personne n'est inscrit : aucune chaise résolue");
      assert.equal(lettre.resolution, "unknown");
      assert.equal(lettre.attente?.motif, "destinataire-inconnu");
      assert.equal(lettre.sans_reveil, false);
    }

    // bob relève (montré) puis accuse (accusé) — carol ne bouge pas.
    const boite = await outil(bob, "inbox");
    assert.equal(boite.count, 1);
    assert.equal((await outil(bob, "ack", { msg_id: boite.messages[0].msg_id })).acked, true);
    const apres = await outil(alice, "envoi_status", { envoi_id: envoi.envoi_id });
    const pourBob = apres.lettres.find((l) => l.recipient === "bob");
    const pourCarol = apres.lettres.find((l) => l.recipient === "carol");
    assert.ok(pourBob.etats.montre, "la relève a posé delivered_at");
    assert.ok(pourBob.etats.accuse, "l'accusé est le seul « vu et traité »");
    assert.equal(pourBob.cible, "bob", "bob s'est inscrit en passant : sa carte est la cible");
    assert.equal(pourCarol.etats.montre, null);
    assert.equal(pourCarol.etats.accuse, null);

    // Servi à l'expéditeur seul ; un envoi inconnu se dit.
    const intrus = await outil(bob, "envoi_status", { envoi_id: envoi.envoi_id });
    assert.equal(intrus.refus, "pas-expediteur");
    assert.equal(intrus.lettres, undefined, "rien n'est montré à qui n'a pas envoyé");
    assert.equal((await outil(alice, "envoi_status", { envoi_id: "envoi-nulle-part" })).refus, "envoi-inconnu");
  } finally {
    await alice.close();
    await bob.close();
  }
});

// ── H. L'EN-TÊTE DE TABLE SUR CHAQUE LETTRE RELEVÉE OU RELUE ─────────────────
test("inbox et history : chaque lettre porte table, envoi_id, reponse_a, position et rappel — et une lettre ordinaire les porte vides", async () => {
  const { root } = bureauAvecTables("valxos-mcp-tables-entete-");
  const alice = await connecter(root, "alice");
  const bob = await connecter(root, "bob");
  try {
    await outil(alice, "table_manage", { action: "position", nom: "famille-test", position: "seen up to 1:25:00" });
    const envoi = await outil(alice, "send", { to: "table:famille-test", subject: "Beat 8", body: "the beat" });
    const direct = await outil(alice, "send", { to: "bob", body: "just you" });

    const boite = await outil(bob, "inbox", { mark_delivered: false });
    assert.equal(boite.count, 2);
    const deTable = boite.messages.find((m) => m.envoi_id === envoi.envoi_id);
    assert.ok(deTable, "la lettre de table est dans la boîte de bob");
    assert.equal(deTable.etat, "en attente", "la forme d'avant reste : etat en tête");
    assert.equal(deTable.table, "famille-test");
    assert.equal(deTable.reponse_a, null);
    assert.equal(deTable.position, "seen up to 1:25:00", "la position de la table, lue au moment de la relève");
    assert.equal(deTable.rappel, 0, "jamais re-servie : rappel 0");
    const ordinaire = boite.messages.find((m) => m.msg_id === direct.msg_id);
    assert.equal(ordinaire.table, null);
    assert.equal(ordinaire.envoi_id, null);
    assert.equal(ordinaire.reponse_a, null);
    assert.equal(ordinaire.position, null);
    assert.equal(ordinaire.rappel, 0);

    const fil = await outil(bob, "history", { thread_id: envoi.envoi_id });
    assert.equal(fil.messages.length, 1);
    assert.equal(fil.messages[0].table, "famille-test");
    assert.equal(fil.messages[0].position, "seen up to 1:25:00");
    assert.equal(fil.messages[0].rappel, 0);
  } finally {
    await alice.close();
    await bob.close();
  }
});

// ── I. CE QUE LES TÂCHES 1 ET 2 ONT DÉCIDÉ, VU DU CLIENT ─────────────────────
test("un envoi de table qui casse en chemin : la réponse rend les lettres parties, l'envoi_id, la table et le membre fautif — jamais « rien d'écrit »", async () => {
  const { root, ouvrir } = bureauAvecTables("valxos-mcp-tables-panne-");
  const prepare = ouvrir();
  // La base refuse la lettre de carol : bob (avant elle, par ordre d'adresse) est déjà parti.
  prepare.exec("CREATE TRIGGER panne_carol BEFORE INSERT ON messages WHEN NEW.recipient = 'carol' BEGIN SELECT RAISE(ABORT, 'disk on fire'); END;");
  prepare.close();
  const alice = await connecter(root, "alice");
  try {
    const envoi = await outil(alice, "send", { to: "table:famille-test", body: "midway" });
    assert.equal(envoi.sent, false, JSON.stringify(envoi));
    assert.equal(envoi.interrompu, true);
    assert.equal(envoi.refus, "envoi-interrompu", "un code à nous, jamais celui de SQLite");
    assert.match(envoi.cause, /^SQLITE_CONSTRAINT/, "le code d'origine part dans cause");
    assert.equal(envoi.table, "famille-test");
    assert.equal(envoi.adresse, "carol", "le membre où l'envoi a cassé");
    assert.match(envoi.envoi_id, /^envoi-/);
    assert.deepEqual(envoi.lettres_ecrites.map((l) => l.to), ["bob"]);
    assert.ok(envoi.lettres_ecrites[0].msg_id && envoi.lettres_ecrites[0].seq, "la lettre partie a sa clef et son seq");
    assert.equal(envoi.lettres_ecrites[0].body, undefined, "jamais la ligne entière");
    assert.match(envoi.motif, /after 1 letter\(s\) were written/, "la phrase dit combien sont parties");
    const enBase = lignes(ouvrir, "SELECT recipient, envoi_id FROM messages ORDER BY seq");
    assert.deepEqual(enBase.map((l) => [l.recipient, l.envoi_id]), [["bob", envoi.envoi_id]]);
  } finally {
    await alice.close();
  }
});

test("ce qu'un refus recopie de l'entrée est borné à 64 caractères, les contrôles aplatis", async () => {
  const { root } = bureauAvecTables("valxos-mcp-tables-borne-");
  const bob = await connecter(root, "bob");
  try {
    const long = `${"x".repeat(100)}\n${"y".repeat(100)}`;
    const parSend = await outil(bob, "send", { to: `table:${long}`, body: "x" });
    assert.equal(parSend.refus, "nom-de-table-invalide", JSON.stringify(parSend));
    assert.equal([...parSend.table].length, 65, "64 points de code et « … »");
    const parGestion = await outil(bob, "table_manage", { action: "add", nom: long, adresse: "carol" });
    assert.equal(parGestion.refus, "nom-de-table-invalide");
    assert.equal([...parGestion.nom].length, 65);
    const court = await outil(bob, "send", { to: "table:a\nb", body: "x" });
    assert.equal(court.table, "a b", "un retour à la ligne recopié devient une espace");
    const parStatut = await outil(bob, "envoi_status", { envoi_id: `envoi-${"z".repeat(100)}` });
    assert.equal(parStatut.refus, "envoi-inconnu");
    assert.equal([...parStatut.envoi_id].length, 65);
    const parAdresse = await outil(bob, "table_manage", { action: "reveil", nom: "famille-test", adresse: "q".repeat(100), reveil: "reveil" });
    assert.equal(parAdresse.refus, "pas-membre");
    assert.equal([...parAdresse.adresse].length, 65);
    assert.ok(parAdresse.motif.startsWith(`"${"q".repeat(64)}…"`), "dans la phrase, l'adresse est entre guillemets JSON");
  } finally {
    await bob.close();
  }
});

test("send à table: rejoué sous la même clef : chaque résultat porte rejeu, ecarte, motif_reveil « rejeu » et l'envoi_id de sa ligne", async () => {
  const { root } = bureauAvecTables("valxos-mcp-tables-rejeu-");
  const alice = await connecter(root, "alice");
  try {
    const premier = await outil(alice, "send", { to: "table:famille-test", body: "once", msg_id: "clef-rejeu" });
    assert.equal(premier.sent, true, JSON.stringify(premier));
    for (const r of premier.results) {
      for (const champ of ["rejeu", "ecarte", "clef_ecartee", "envoi_id", "interrompue"]) {
        assert.equal(r[champ], undefined, `${champ} absent sur un envoi neuf`);
      }
    }
    const second = await outil(alice, "send", { to: "table:famille-test", body: "twice", msg_id: "clef-rejeu" });
    assert.equal(second.sent, true, JSON.stringify(second));
    assert.deepEqual(second.results.map((r) => r.msg_id), premier.results.map((r) => r.msg_id), "les mêmes lettres, membre par membre");
    for (const r of second.results) {
      assert.equal(r.motif_reveil, "rejeu");
      assert.equal(r.rejeu?.motif, "msg_id-deja-connu");
      assert.deepEqual(r.ecarte, { body: "twice" }, "le corps tapé n'est parti nulle part, et la réponse le dit");
      assert.equal(r.envoi_id, premier.envoi_id, "la lettre appartient à l'envoi qui l'a fait naître");
    }
    assert.equal((await outil(alice, "envoi_status", { envoi_id: premier.envoi_id })).count, 2, "l'envoi_id de la ligne est celui qu'envoi_status connaît");

    // R2 : une clef de membre déjà prise par une lettre d'alice vers ailleurs —
    // la ligne gagne, et le résultat annonce SON destinataire, pas l'adresse du membre.
    const ailleurs = await outil(alice, "send", { to: "carol", body: "direct", msg_id: "clef-r2#bob" });
    const r2 = await outil(alice, "send", { to: "table:famille-test", body: "to the table", msg_id: "clef-r2" });
    const pourLaClefPrise = r2.results.find((r) => r.msg_id === ailleurs.msg_id);
    assert.ok(pourLaClefPrise, JSON.stringify(r2));
    assert.equal(pourLaClefPrise.to, "carol", "la lettre est partie à carol : c'est elle qu'on annonce");
    assert.equal(pourLaClefPrise.rejeu?.demande, "bob", "l'adresse du membre reste lisible dans rejeu.demande");
  } finally {
    await alice.close();
  }
});

test("hors-enclos sur une grande table : 20 destinataires refusés au plus, `autres` compte le reste, rien d'écrit", async () => {
  const { root, ouvrir } = bureauAvecTables("valxos-mcp-tables-autres-");
  const prepare = ouvrir();
  creerTable(prepare, { nom: "grande-test", creeePar: "alice" });
  const pairs = Array.from({ length: 24 }, (_, i) => `pair-${String(i + 1).padStart(2, "0")}`);
  for (const membre of ["alice", "hal-test", ...pairs]) ajouterMembre(prepare, "grande-test", membre, { ajoutePar: "alice" });
  poserEnclos(prepare, "hal-test", "office-test", { posePar: "operator" });
  prepare.close();
  const hal = await connecter(root, "hal-test");
  try {
    const refuse = await outil(hal, "send", { to: "table:grande-test", body: "too many" });
    assert.equal(refuse.sent, false, JSON.stringify(refuse));
    assert.equal(refuse.refus, "hors-enclos");
    assert.equal(refuse.table, "grande-test");
    assert.deepEqual(refuse.destinataires_refuses, pairs.slice(0, 20), "alice est dans l'enclos : seuls les pairs sont refusés");
    assert.equal(refuse.autres, 4);
    assert.equal(lignes(ouvrir, "SELECT count(*) AS n FROM messages")[0].n, 0);
  } finally {
    await hal.close();
  }
});

test("table_manage : une adresse qui ne peut pas être membre est un refus (adresse-invalide) ; ré-ajouter un membre ne touche pas son réveil", async () => {
  const { root } = bureauAvecTables("valxos-mcp-tables-adresse-");
  const alice = await connecter(root, "alice");
  const carol = await connecter(root, "carol");
  try {
    for (const adresse of ["table:office-test", "two words"]) {
      const refuse = await outil(alice, "table_manage", { action: "add", nom: "famille-test", adresse });
      assert.equal(refuse.ok, false, JSON.stringify(refuse));
      assert.equal(refuse.refus, "adresse-invalide");
    }
    assert.equal((await outil(carol, "table_manage", { action: "reveil", nom: "famille-test", reveil: "prochain-tour" })).table.mon_reveil, "prochain-tour");
    const reajout = await outil(alice, "table_manage", { action: "add", nom: "famille-test", adresse: "carol" });
    assert.deepEqual(reajout.table.membres.find((m) => m.adresse === "carol"), { adresse: "carol", reveil: "prochain-tour" }, "le réglage de carol reste le sien");
  } finally {
    await alice.close();
    await carol.close();
  }
});

test("TABLE:<Nom> en majuscules est une table, jamais un pair nommé « TABLE:… »", async () => {
  const { root, ouvrir } = bureauAvecTables("valxos-mcp-tables-casse-");
  const alice = await connecter(root, "alice");
  try {
    const envoi = await outil(alice, "send", { to: "TABLE:Famille-Test", body: "loud" });
    assert.equal(envoi.sent, true, JSON.stringify(envoi));
    assert.equal(envoi.table.nom, "famille-test");
    assert.deepEqual(lignes(ouvrir, "SELECT recipient FROM messages ORDER BY seq").map((l) => l.recipient), ["bob", "carol"]);
  } finally {
    await alice.close();
  }
});

test("la sonnette qui répond laisse une trace : envoi_status dit « sonné » pour bob, pas pour carol", async () => {
  const { root } = bureauAvecTables("valxos-mcp-tables-sonne-");
  fs.mkdirSync(path.join(root, "run"), { recursive: true });
  const reveils = [];
  const porte = net.createServer((socket) => socket.on("data", (d) => reveils.push(String(d))));
  await new Promise((resolve) => porte.listen(path.join(root, "run", "bob.sock"), resolve));
  const alice = await connecter(root, "alice");
  try {
    const envoi = await outil(alice, "send", { to: "table:famille-test", body: "ring" });
    assert.equal(envoi.results.find((r) => r.to === "bob").wake.ok, true, JSON.stringify(envoi));
    const etat = await outil(alice, "envoi_status", { envoi_id: envoi.envoi_id });
    assert.ok(etat.lettres.find((l) => l.recipient === "bob").etats.sonne, "le réveil direct réussi se voit");
    assert.equal(etat.lettres.find((l) => l.recipient === "carol").etats.sonne, null);
  } finally {
    await alice.close();
    await new Promise((resolve) => porte.close(resolve));
  }
});

test("la position d'une table fermée ne se lit que par ses membres : un membre retiré relit sa lettre sans elle", async () => {
  const { root, ouvrir } = bureauAvecTables("valxos-mcp-tables-position-");
  const hal = await connecter(root, "hal-test");
  const alice = await connecter(root, "alice");
  try {
    await outil(hal, "table_manage", { action: "position", nom: "office-test", position: "quarter close" });
    const envoi = await outil(hal, "send", { to: "table:office-test", body: "numbers" });
    assert.equal(envoi.sent, true, JSON.stringify(envoi));
    const avant = await outil(alice, "inbox", { mark_delivered: false });
    assert.equal(avant.messages[0].position, "quarter close");
    const prepare = ouvrir();
    retirerMembre(prepare, "office-test", "alice", { retirePar: "operator" });
    prepare.close();
    const apres = await outil(alice, "inbox", { mark_delivered: false });
    assert.equal(apres.messages[0].table, "office-test", "la lettre reste la sienne");
    assert.equal(apres.messages[0].position, null, "la position d'aujourd'hui n'est plus à elle");
    assert.equal((await outil(alice, "history", { thread_id: envoi.envoi_id })).messages[0].position, null);
  } finally {
    await hal.close();
    await alice.close();
  }
});

test("une chaise poste à une table sous sa chaise (sender_chaise) et crée une table sous sa lignée", async () => {
  const { root, ouvrir } = bureauAvecTables("valxos-mcp-tables-chaise-");
  const maison = path.join(root, "maison");
  fs.mkdirSync(path.join(maison, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(maison, "sessions", `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: "ALPHA", messagingSocketPath: path.join(maison, "r.sock"), name: "runner" }));
  const prepare = ouvrir();
  registerInstance(prepare, { lineage: "alice", sessionId: "ALPHA", pid: process.pid, house: maison, sessionName: "runner" });
  prepare.close();
  const alice = await connecter(root, "alice", { CLAUDE_CONFIG_DIR: maison });
  try {
    assert.equal((await outil(alice, "whoami")).id, "alice#ALPHA");
    const envoi = await outil(alice, "send", { to: "table:famille-test", body: "from a chair" });
    assert.equal(envoi.sent, true, JSON.stringify(envoi));
    assert.deepEqual(envoi.results.map((r) => r.to), ["bob", "carol"], "la lignée de la chaise est membre : elle ne s'écrit pas");
    assert.deepEqual(lignes(ouvrir, "SELECT DISTINCT sender, sender_chaise FROM messages"), [{ sender: "alice#ALPHA", sender_chaise: "alice#ALPHA" }]);
    const creee = await outil(alice, "table_manage", { action: "create", nom: "chaise-test" });
    assert.equal(creee.ok, true, JSON.stringify(creee));
    assert.deepEqual(creee.table.membres, [{ adresse: "alice", reveil: null }], "une table dure plus qu'une session : la lignée y entre");
    assert.equal(creee.table.mon_reveil, "reveil");
    const verif = ouvrir();
    try {
      assert.equal(obtenirTable(verif, "chaise-test").creee_par, "alice#ALPHA", "le geste reste signé par la chaise");
    } finally {
      verif.close();
    }
    // Rejoindre sans adresse : sous la lignée, comme create ; quitter sans
    // adresse retire toutes les formes sous lesquelles la chaise est membre.
    const rejointe = await outil(alice, "table_manage", { action: "add", nom: "chaise-test", adresse: "alice#ALPHA" });
    assert.deepEqual(rejointe.table.membres.map((m) => m.adresse), ["alice", "alice#ALPHA"], "sous sa chaise, si elle la nomme");
    const partie = await outil(alice, "table_manage", { action: "remove", nom: "chaise-test" });
    assert.equal(partie.retire, true, JSON.stringify(partie));
    assert.deepEqual(partie.table.membres, [], "les deux formes sont parties");
    const revenue = await outil(alice, "table_manage", { action: "add", nom: "chaise-test" });
    assert.deepEqual(revenue.table.membres.map((m) => m.adresse), ["alice"], "sans adresse, la chaise rejoint sous sa lignée");

    // Le send ordinaire et reply d'une chaise signent aussi leur chaise.
    const direct = await outil(alice, "send", { to: "bob", body: "direct from a chair" });
    const reponse = await outil(alice, "reply", { msg_id: envoi.results[0].msg_id, body: "a note to self" });
    assert.equal(reponse.sent, true, JSON.stringify(reponse));
    for (const msgId of [direct.msg_id, reponse.msg_id]) {
      assert.deepEqual(lignes(ouvrir, "SELECT sender, sender_chaise FROM messages WHERE msg_id = ?", msgId), [{ sender: "alice#ALPHA", sender_chaise: "alice#ALPHA" }]);
    }
  } finally {
    await alice.close();
  }
});

// ── J. ROUND 1 DE LA REVUE ──────────────────────────────────────────────────
// (a) une seule forme de clef_ecartee, partout.
test("clef de membre prise par le courrier d'un tiers : la lettre part sous une clef neuve, clef_ecartee a la forme du send ordinaire", async () => {
  const { root, ouvrir } = bureauAvecTables("valxos-mcp-tables-clef-tiers-");
  const prepare = ouvrir();
  insertMessage(prepare, { msg_id: "clef-tiers#bob", sender: "carol", recipient: "dave", body: "between carol and dave" });
  prepare.close();
  const alice = await connecter(root, "alice");
  try {
    const envoi = await outil(alice, "send", { to: "table:famille-test", body: "to the table", msg_id: "clef-tiers" });
    assert.equal(envoi.sent, true, JSON.stringify(envoi));
    const pourBob = envoi.results.find((r) => r.to === "bob");
    assert.ok(pourBob, JSON.stringify(envoi));
    assert.deepEqual(pourBob.clef_ecartee, { demandee: "clef-tiers#bob", motif: "clef-deja-prise" });
    assert.notEqual(pourBob.msg_id, "clef-tiers#bob", "jamais sous la clef d'un tiers");
    assert.equal(envoi.results.find((r) => r.to === "carol").clef_ecartee, undefined, "la clef de carol était libre");
    const direct = await outil(alice, "send", { to: "bob", body: "x", msg_id: "clef-tiers#bob" });
    assert.deepEqual(Object.keys(direct.clef_ecartee).sort(), Object.keys(pourBob.clef_ecartee).sort(), "même forme qu'un send ordinaire");
  } finally {
    await alice.close();
  }
});

// (d) rejoindre et quitter soi-même ; toucher aux autres exige d'être membre.
test("table_manage sur une table ouverte : un non-membre ne touche ni aux membres ni à leur réveil (pas-membre) ; il peut se rejoindre, et un membre peut se retirer", async () => {
  const { root, ouvrir } = bureauAvecTables("valxos-mcp-tables-rejoindre-");
  const prepare = ouvrir();
  creerTable(prepare, { nom: "solo-test", creeePar: "alice" });
  for (const membre of ["alice", "bob"]) ajouterMembre(prepare, "solo-test", membre, { ajoutePar: "alice" });
  prepare.close();
  const carol = await connecter(root, "carol");
  const bob = await connecter(root, "bob");
  const membres = () => lignes(ouvrir, "SELECT adresse, reveil FROM table_membres WHERE nom_table = 'solo-test' AND retire_le IS NULL ORDER BY adresse");
  try {
    const ajout = await outil(carol, "table_manage", { action: "add", nom: "solo-test", adresse: "dave" });
    assert.equal(ajout.refus, "pas-membre", JSON.stringify(ajout));
    const retrait = await outil(carol, "table_manage", { action: "remove", nom: "solo-test", adresse: "bob" });
    assert.equal(retrait.refus, "pas-membre", JSON.stringify(retrait));
    const reveil = await outil(carol, "table_manage", { action: "reveil", nom: "solo-test", adresse: "alice", reveil: "prochain-tour" });
    assert.equal(reveil.refus, "pas-membre", JSON.stringify(reveil));
    assert.deepEqual(membres(), [{ adresse: "alice", reveil: null }, { adresse: "bob", reveil: null }], "rien n'a bougé");

    // Se rejoindre : sans adresse, ou sous une de ses formes.
    const rejoint = await outil(carol, "table_manage", { action: "add", nom: "solo-test" });
    assert.equal(rejoint.ok, true, JSON.stringify(rejoint));
    assert.equal(rejoint.table.mon_reveil, "reveil");
    assert.deepEqual(membres().map((m) => m.adresse), ["alice", "bob", "carol"]);
    assert.equal((await outil(carol, "table_manage", { action: "add", nom: "solo-test", adresse: "carol" })).ok, true, "sous son propre nom aussi");

    // Quitter : sans adresse ; un second départ ne retire rien et le dit.
    const quitte = await outil(carol, "table_manage", { action: "remove", nom: "solo-test" });
    assert.equal(quitte.ok, true, JSON.stringify(quitte));
    assert.equal(quitte.retire, true);
    assert.equal(quitte.table.mon_reveil, null);
    assert.equal((await outil(carol, "table_manage", { action: "remove", nom: "solo-test" })).retire, false);

    // Un membre retire un autre ; une adresse qui n'est pas membre : retire false.
    assert.equal((await outil(bob, "table_manage", { action: "remove", nom: "solo-test", adresse: "personne" })).retire, false);
    assert.equal((await outil(bob, "table_manage", { action: "remove", nom: "solo-test", adresse: "alice" })).retire, true);
    assert.deepEqual(membres().map((m) => m.adresse), ["bob"]);
  } finally {
    await carol.close();
    await bob.close();
  }
});

// (e) `tables` : membre ou non, et la table ouverte qu'on peut rejoindre.
test("tables : les tables dont on est membre (membre: true) et les tables ouvertes à rejoindre (membre: false) — on ne poste qu'où l'on est membre", async () => {
  const { root, ouvrir } = bureauAvecTables("valxos-mcp-tables-decouvrir-");
  const prepare = ouvrir();
  creerTable(prepare, { nom: "solo-test", creeePar: "alice" });
  ajouterMembre(prepare, "solo-test", "alice", { ajoutePar: "alice" });
  prepare.close();
  const bob = await connecter(root, "bob");
  try {
    const liste = await outil(bob, "tables");
    assert.deepEqual(liste.tables.map((t) => [t.nom, t.membre]), [["famille-test", true], ["solo-test", false]], "office-test (fermée) n'apparaît pas");
    assert.equal(liste.tables.find((t) => t.nom === "solo-test").mon_reveil, null);
    assert.equal((await outil(bob, "send", { to: "table:solo-test", body: "x" })).refus, "pas-membre", "membre: false veut dire : pas encore");
    await outil(bob, "table_manage", { action: "add", nom: "solo-test" });
    assert.equal((await outil(bob, "tables")).tables.find((t) => t.nom === "solo-test").membre, true);
    assert.equal((await outil(bob, "send", { to: "table:solo-test", body: "joined" })).sent, true);
  } finally {
    await bob.close();
  }
});

// Mineurs : la position en points de code ; `enclos` est un geste humain.
test("table_manage : la position se borne en points de code (70 emoji passent), et l'action enclos répond table-fermee", async () => {
  const { root } = bureauAvecTables("valxos-mcp-tables-emoji-");
  const alice = await connecter(root, "alice");
  try {
    const emoji = "🎬".repeat(70);
    const pose = await outil(alice, "table_manage", { action: "position", nom: "famille-test", position: emoji });
    assert.equal(pose.ok, true, JSON.stringify(pose));
    assert.equal(pose.table.position, emoji);
    assert.ok((await outil(alice, "table_manage", { action: "position", nom: "famille-test", position: "🎬".repeat(121) })).erreur, "121 points de code : refusé");
    const enclos = await outil(alice, "table_manage", { action: "enclos", nom: "office-test" });
    assert.equal(enclos.refus, "table-fermee", JSON.stringify(enclos));
  } finally {
    await alice.close();
  }
});

// Mineurs : le jumeau, la chaise qui signe sa lettre, `autres` au broadcast.
test("une chaise refusée (jumeau) : reply, tables, table_manage et envoi_status répondent chaise-refusee, rien d'écrit", async (t) => {
  const { root, ouvrir } = bureauAvecTables("valxos-mcp-tables-jumeau-");
  const maison = path.join(root, "maison");
  fs.mkdirSync(path.join(maison, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(maison, "sessions", `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: "ALPHA", messagingSocketPath: path.join(maison, "r.sock"), name: "runner" }));
  const autre = spawn("sleep", ["60"], { stdio: "ignore" });
  t.after(() => { try { autre.kill("SIGKILL"); } catch { /* déjà parti */ } });
  const naissance = procStartOf(autre.pid);
  assert.ok(naissance, "sonde impossible : ps n'a pas rendu d'heure de naissance");
  const prepare = ouvrir();
  registerInstance(prepare, { lineage: "alice", sessionId: "ALPHA", pid: autre.pid, procStart: naissance, house: maison });
  const lettre = insertMessage(prepare, { sender: "bob", recipient: "alice", body: "for alice" });
  prepare.close();
  const jumeau = await connecter(root, "alice", { CLAUDE_CONFIG_DIR: maison });
  try {
    assert.equal((await outil(jumeau, "whoami")).refus, "chaise-refusee", "sonde impossible sinon : pas de jumeau");
    for (const [nom, args] of [
      ["reply", { msg_id: lettre.msg_id, body: "x" }],
      ["tables", {}],
      ["table_manage", { action: "add", nom: "famille-test", adresse: "dave" }],
      ["envoi_status", { envoi_id: "envoi-x" }]
    ]) {
      const r = await outil(jumeau, nom, args);
      assert.equal(r.refus, "chaise-refusee", `${nom} : ${JSON.stringify(r)}`);
    }
    assert.equal(lignes(ouvrir, "SELECT count(*) AS n FROM messages")[0].n, 1, "la seule lettre est celle de bob");
    assert.equal(lignes(ouvrir, "SELECT count(*) AS n FROM table_membres WHERE adresse = 'dave'")[0].n, 0);
  } finally {
    await jumeau.close();
  }
});

test("broadcast sous enclos vers plus de vingt pairs : 20 refusés au plus, autres compte le reste", async () => {
  const { root, ouvrir } = bureauAvecTables("valxos-mcp-tables-broadcast-autres-");
  const prepare = ouvrir();
  poserEnclos(prepare, "hal-test", "office-test", { posePar: "operator" });
  for (let i = 1; i <= 22; i += 1) registerPeer(prepare, { id: `pair-${String(i).padStart(2, "0")}`, status: "active" });
  prepare.close();
  const hal = await connecter(root, "hal-test");
  try {
    const refuse = await outil(hal, "broadcast", { body: "to everyone" });
    assert.equal(refuse.refus, "hors-enclos", JSON.stringify(refuse));
    assert.equal(refuse.destinataires_refuses.length, 20);
    assert.equal(refuse.autres, 2);
    assert.equal(lignes(ouvrir, "SELECT count(*) AS n FROM messages")[0].n, 0);
  } finally {
    await hal.close();
  }
});

// B1 (passe adverse) — UN PARAMÈTRE QUE L'ACTION EXIGE ET QUI MANQUE EST UN REFUS EN JSON. `reveil`,
// `mode` et `position` sont optionnels au schéma (une seule entrée pour sept actions) ; l'action qui
// les exige rendait une phrase nue, sans `refus`. Une `adresse` donnée mais blanche (pour ajouter,
// retirer ou régler un AUTRE) est un paramètre manquant aussi : jamais lue comme « moi ».
test("B1 — table_manage : reveil, mode, position, ou une adresse blanche qui manquent → { ok: false, refus: parametre-manquant, parametre }, jamais une erreur ni une phrase nue ; rien ne bouge", async () => {
  const { root, ouvrir } = bureauAvecTables("valxos-mcp-tables-parametre-");
  const alice = await connecter(root, "alice");
  try {
    const avant = JSON.stringify(lignes(ouvrir, "SELECT * FROM table_membres ORDER BY nom_table, adresse"))
      + JSON.stringify(lignes(ouvrir, "SELECT nom, mode, position FROM tables ORDER BY nom"));
    for (const [args, parametre] of [
      [{ action: "reveil", nom: "famille-test" }, "reveil"],
      [{ action: "mode", nom: "famille-test" }, "mode"],
      [{ action: "position", nom: "famille-test" }, "position"],
      [{ action: "add", nom: "famille-test", adresse: "   " }, "adresse"],
      [{ action: "remove", nom: "famille-test", adresse: "" }, "adresse"],
      [{ action: "reveil", nom: "famille-test", adresse: " ", reveil: "prochain-tour" }, "adresse"]
    ]) {
      const r = await alice.callTool({ name: "table_manage", arguments: args });
      assert.equal(r.isError, undefined, `${JSON.stringify(args)} : jamais une erreur d'outil`);
      const corps = JSON.parse(r.content[0].text);
      assert.deepEqual(
        [corps.ok, corps.refus, corps.parametre, corps.action, corps.nom],
        [false, "parametre-manquant", parametre, args.action, "famille-test"],
        JSON.stringify(args)
      );
      assert.match(corps.motif, new RegExp(parametre));
    }
    const apres = JSON.stringify(lignes(ouvrir, "SELECT * FROM table_membres ORDER BY nom_table, adresse"))
      + JSON.stringify(lignes(ouvrir, "SELECT nom, mode, position FROM tables ORDER BY nom"));
    assert.equal(apres, avant, "aucun refus n'a rien écrit");
    // Le contrôle : les mêmes actions avec leur paramètre passent.
    assert.equal((await outil(alice, "table_manage", { action: "mode", nom: "famille-test", mode: "direct" })).ok, true);
    assert.equal((await outil(alice, "table_manage", { action: "reveil", nom: "famille-test", reveil: "prochain-tour" })).ok, true);
  } finally {
    await alice.close();
  }
});

// B10, vu du guichet MCP : `send` à un destinataire blanc est un refus en JSON, jamais une lettre.
test("B10 — send à un destinataire blanc : { sent: false, refus: adresse-invalide }, rien d'écrit", async () => {
  const { root, ouvrir } = bureauAvecTables("valxos-mcp-sans-destinataire-");
  const alice = await connecter(root, "alice");
  try {
    for (const to of ["", "   ", "\n"]) {
      const r = await outil(alice, "send", { to, body: "nobody" });
      assert.equal(r.erreur, undefined, `jamais une erreur d'outil : ${r.erreur}`);
      assert.deepEqual([r.sent, r.refus], [false, "adresse-invalide"], JSON.stringify(to));
    }
    assert.equal(lignes(ouvrir, "SELECT count(*) AS n FROM messages")[0].n, 0);
  } finally {
    await alice.close();
  }
});

// B17 (marche Codex) — `montre` EST LA PREMIÈRE PRÉSENTATION. Il se lisait sur `delivered_at`, que
// chaque service réécrit : une lettre injectée à 08:50 et relue par `inbox` à 09:00 disait 09:00.
// Il se lit maintenant sur le PREMIER événement de livraison (le journal ne s'efface pas) ; une copie
// vue par une chaise sœur (`cc_vu`) n'est pas une présentation au destinataire.
test("B17 — envoi_status : montre est la PREMIÈRE présentation de la lettre, pas la dernière ; une copie vue ne compte pas", async () => {
  const { root, ouvrir } = bureauAvecTables("valxos-mcp-tables-montre-");
  const alice = await connecter(root, "alice");
  try {
    const envoi = await outil(alice, "send", { to: "table:famille-test", subject: "status", body: "first sight" });
    const pourBob = envoi.results.find((r) => r.to === "bob");
    const pourCarol = envoi.results.find((r) => r.to === "carol");
    const db = ouvrir();
    try {
      const ligne = (id) => db.prepare("SELECT * FROM messages WHERE msg_id = ?").get(id);
      markDelivered(db, [ligne(pourBob.msg_id)], "bob", "codex_user_prompt_delivered", { at: "2026-10-22T08:50:05.669Z" });
      markDelivered(db, [ligne(pourBob.msg_id)], "bob", "mcp_inbox_delivered", { at: "2026-10-22T09:00:04.872Z" });
      // Le journal est daté par la base (`recordEvent`) : on lui rend les heures de la marche.
      const dater = db.prepare("UPDATE delivery_events SET event_at = ? WHERE msg_id = ? AND event_type = ?");
      dater.run("2026-10-22T08:50:05.669Z", pourBob.msg_id, "codex_user_prompt_delivered");
      dater.run("2026-10-22T09:00:04.872Z", pourBob.msg_id, "mcp_inbox_delivered");
      db.prepare("INSERT INTO delivery_events (msg_id, agent_id, event_type, event_at, detail_json) VALUES (?, 'carol#s2', 'cc_vu', '2026-10-22T08:00:00.000Z', '{}')").run(pourCarol.msg_id);
      assert.equal(ligne(pourBob.msg_id).delivered_at, "2026-10-22T09:00:04.872Z", "sonde : delivered_at dit la dernière");
    } finally {
      db.close();
    }
    const statut = await outil(alice, "envoi_status", { envoi_id: envoi.envoi_id });
    const parDestinataire = Object.fromEntries(statut.lettres.map((l) => [l.recipient, l.etats.montre]));
    assert.deepEqual(parDestinataire, { bob: "2026-10-22T08:50:05.669Z", carol: null });
  } finally {
    await alice.close();
  }
});

// m6 (re-revue du round FINAL), vu du MCP : `reveiller` au-delà de 50 mentions ou de 200 caractères
// est un refus en JSON (`parametre-invalide`, `parametre: "reveiller"`), jamais une erreur d'outil.
test("m6 — send à une table : reveiller de 51 mentions ou d'une mention de 201 caractères, refus parametre-invalide, rien d'écrit", async () => {
  const { root, ouvrir } = bureauAvecTables("valxos-tables-reveiller-");
  const alice = await connecter(root, "alice");
  try {
    const avant = lignes(ouvrir, "SELECT count(*) AS n FROM messages")[0].n;
    for (const reveiller of [Array.from({ length: 51 }, (_, n) => `m${n}`), ["x".repeat(201)]]) {
      const r = await outil(alice, "send", { to: "table:famille-test", body: "beat", reveiller });
      assert.deepEqual([r.sent, r.refus, r.parametre], [false, "parametre-invalide", "reveiller"], JSON.stringify(r));
      assert.match(r.motif, /at most 50 names of at most 200 characters/);
    }
    assert.equal(lignes(ouvrir, "SELECT count(*) AS n FROM messages")[0].n, avant, "rien d'écrit");
    const envoi = await outil(alice, "send", { to: "table:famille-test", body: "beat", reveiller: ["bob"] });
    assert.equal(envoi.sent, true, JSON.stringify(envoi));
  } finally {
    await alice.close();
  }
});
