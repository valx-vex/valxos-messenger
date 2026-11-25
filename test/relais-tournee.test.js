// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LA TOURNÉE DU RELAIS : un échange par Mac, le transport ssh, la veille.
//
// B = Studio, où tourne le relais (dans ce processus, son bureau posé par
// `poserLeBureau`) ; A = MacBook, joint par `transportLocal` (test/aide-relais.js) :
// la vraie commande `echanger`, lancée sur un second bureau jetable, par la
// ligne exacte que ssh ferait lancer là-bas. Aucun ssh, aucun réseau ; le
// bureau vivant n'est jamais ouvert. Le scan des maisons est vide ; le réveil
// est le vrai (il frappe dans le dossier `run` du bureau jetable de B).
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { runtimePaths } from "../src/lib/config.js";
import { ackMessage, getMessageById, getPendingForContext, insertMessage, markDelivered, openDatabase } from "../src/lib/database.js";
import { adressesDuRepli } from "../src/lib/identity.js";
import { posterUneLettre } from "../src/lib/guichet.js";
import { broadcastRecipients, designatePrimary, porteDeReveil, registerInstance, resolveRecipient } from "../src/lib/registry.js";
import { lireLaConfigDuRelais } from "../src/lib/relais/config.js";
import { faireUneTourneeDuRelais, rendreCeQuiEstDu } from "../src/lib/relais/tournee.js";
import { transportSsh, transportsSsh } from "../src/lib/relais/transport-ssh.js";
import { DEPOT, coupure, transportLocal } from "./aide-relais.js";
import { envPropre, poserLeBureau } from "./aide-env.js";

const MACBOOK = "MacBook";
const STUDIO = "Studio";
const BIN = path.join(DEPOT, "src/bin/relais.js");
const MAC_DE_L_EXEMPLE = { ssh: "m3", node: "/opt/homebrew/bin/node", depot: "/opt/valxos/cc2cc-v2", bureau: "/opt/valxos/bureau" };
const SANS_MAISONS = { scanner: () => ({ houses: [], parSession: new Map() }) };

function bureau(t, prefixe, config) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefixe));
  fs.writeFileSync(path.join(root, "relais.json"), JSON.stringify(config));
  poserLeBureau(root);
  const db = openDatabase({ file: path.join(root, "broker.db") });
  t.after(() => {
    try { db.close(); } catch { /* base jetable */ }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, db };
}

// A d'abord, B ensuite : le processus du test reste sur le bureau de B, où la
// tournée tourne (et où le guichet frappe ses réveils).
function deuxMacs(t) {
  const a = bureau(t, "rt-a-", { moi: MACBOOK });
  const b = bureau(t, "rt-b-", { moi: STUDIO, macs: { [MACBOOK]: MAC_DE_L_EXEMPLE } });
  return {
    a,
    b,
    config: lireLaConfigDuRelais(b.root),
    transport: transportLocal({ racines: { [MACBOOK]: a.root }, moi: STUDIO }),
    enAttente: new Map()
  };
}

function tourner(m, transport = m.transport, deps = SANS_MAISONS) {
  return faireUneTourneeDuRelais({ db: m.b.db, config: m.config, transport, enAttente: m.enAttente, deps, racine: m.b.root });
}

// Une chaise de CE bureau. `designeAt` : absent = non désignée.
function chaise(db, lignee, session, { pid = process.pid, designeAt } = {}) {
  registerInstance(db, { lineage: lignee, sessionId: session, pid, house: "/maison/carton" });
  const id = `${lignee}#${session}`;
  if (designeAt !== undefined) {
    designatePrimary(db, lignee, session);
    db.prepare("UPDATE peers SET designe_at = ? WHERE id = ?").run(designeAt, id);
  }
  return id;
}

// alice#s-9 vit sur B (le Studio), carol#s-1 sur A (le MacBook) ; la première
// tournée échange les chaises.
async function deuxChaises(t) {
  const m = deuxMacs(t);
  const alice = chaise(m.b.db, "alice", "s-9", { pid: process.pid });
  const carol = chaise(m.a.db, "carol", "s-1", { pid: process.ppid });
  const [r] = await tourner(m);
  assert.equal(r.erreur, null, `SONDE : la première tournée échange les chaises (${r.detail})`);
  assert.equal(resolveRecipient(m.a.db, alice).kind, "distant", "SONDE : A porte vers B");
  assert.equal(resolveRecipient(m.b.db, carol).kind, "distant", "SONDE : B porte vers A");
  return { ...m, alice, carol };
}

const compter = (db, msgId) => db.prepare("SELECT COUNT(*) AS n FROM messages WHERE msg_id = ?").get(msgId).n;
const evenementsDe = (db, msgId, type) =>
  db.prepare("SELECT detail_json FROM delivery_events WHERE msg_id = ? AND event_type = ?").all(msgId, type);
const parSeq = (db, where = "1 = 1") =>
  db.prepare(`SELECT msg_id FROM messages WHERE ${where} ORDER BY seq ASC`).all().map((l) => l.msg_id);
const lireLeStatut = (root) => JSON.parse(fs.readFileSync(path.join(root, "status", "relais.json"), "utf8"));

// `valxos-relais etat` sur un bureau, lu.
function etatDe(root) {
  const sortie = spawnSync(process.execPath, [BIN, "etat"], {
    cwd: DEPOT, encoding: "utf8", env: envPropre({ CC2CC_GARDE_BUREAU: "1", CC2CC_V2_HOME: root })
  });
  assert.equal(sortie.status, 0, sortie.stderr);
  return JSON.parse(sortie.stdout);
}

// `valxos-relais oublier <mac>` sur un bureau.
function oublierSur(root, mac) {
  const sortie = spawnSync(process.execPath, [BIN, "oublier", mac], {
    cwd: DEPOT, encoding: "utf8", env: envPropre({ CC2CC_GARDE_BUREAU: "1", CC2CC_V2_HOME: root })
  });
  assert.equal(sortie.status, 0, sortie.stderr);
  return JSON.parse(sortie.stdout);
}

// La chaise `<lignee>#<session>` de ce bureau se ferait-elle servir la lettre ?
// Le canal des crochets : ses adresses (`adressesDuRepli`), puis le courrier en
// attente pour elles (`getPendingForContext`).
const servieA = (db, lignee, session, msgId) =>
  getPendingForContext(db, adressesDuRepli(db, lignee, { session_id: session })).some((l) => l.msg_id === msgId);

async function attendre(condition, { ms = 10_000, pas = 25 } = {}) {
  const fin = Date.now() + ms;
  while (Date.now() < fin) {
    if (condition()) return true;
    await new Promise((r) => setTimeout(r, pas));
  }
  return condition();
}

// ── L'ALLER-RETOUR ──────────────────────────────────────────────────────────

test("un aller-retour complet, accusé des deux côtés, une seule fois chacune", async (t) => {
  const m = await deuxChaises(t);
  const T1 = "2026-11-16T12:01:00.000Z";
  const T2 = "2026-11-16T12:02:00.000Z";

  // Une lettre de A pour la chaise de B : après une tournée, elle est sur B, avec les deux marques.
  insertMessage(m.a.db, { msg_id: "L-aller", sender: m.carol, recipient: m.alice, body: "bonjour" });
  let [r] = await tourner(m);
  assert.equal(r.erreur, null, r.detail);
  assert.equal(r.apportees, 1);
  const arrivee = getMessageById(m.b.db, "L-aller");
  assert.ok(arrivee, "la lettre est sur B");
  assert.equal(arrivee.via, "relais");
  assert.equal(arrivee.mac_origine, MACBOOK);
  assert.deepEqual(m.enAttente.get(MACBOOK), { portees: ["L-aller"], rendus: [], refusees: [] }, "l'accusé de réception attend la tournée suivante");
  assert.equal(getMessageById(m.a.db, "L-aller").porte_at, null, "SONDE : A n'a pas encore la confirmation");

  // B la remet, l'accuse, et répond. Deux tournées.
  markDelivered(m.b.db, [arrivee], m.alice, "delivered", { at: T1 });
  ackMessage(m.b.db, "L-aller", m.alice, { at: T2 });
  insertMessage(m.b.db, { msg_id: "L-retour", sender: m.alice, recipient: m.carol, body: "merci", reponse_a: "L-aller" });
  for (let i = 0; i < 2; i += 1) {
    [r] = await tourner(m);
    assert.equal(r.erreur, null, r.detail);
  }

  // A voit sa lettre remise, puis accusée ; la réponse est sur A.
  const origine = getMessageById(m.a.db, "L-aller");
  assert.ok(origine.porte_at, "A a la confirmation de l'aller");
  assert.equal(origine.delivered_at, T1);
  assert.equal(origine.acked_at, T2);
  const reponse = getMessageById(m.a.db, "L-retour");
  assert.ok(reponse, "la réponse est sur A");
  assert.equal(reponse.via, "relais");
  assert.equal(reponse.mac_origine, STUDIO);
  assert.ok(getMessageById(m.b.db, "L-retour").porte_at, "B a la confirmation de la réponse");
  const copie = getMessageById(m.b.db, "L-aller");
  assert.ok(copie.remise_rendue_at && copie.accuse_rendu_at, "B sait que A a appris la remise et l'accusé");

  // Une seule fois chacune, des deux côtés.
  for (const [cote, db] of [["A", m.a.db], ["B", m.b.db]]) {
    for (const id of ["L-aller", "L-retour"]) assert.equal(compter(db, id), 1, `${id} sur ${cote}`);
  }
  assert.equal(evenementsDe(m.a.db, "L-aller", "relais_porte").length, 1);
  assert.equal(evenementsDe(m.a.db, "L-aller", "relais_remise").length, 1);
  assert.equal(evenementsDe(m.a.db, "L-aller", "relais_accuse").length, 1);
  assert.equal(evenementsDe(m.b.db, "L-retour", "relais_porte").length, 1);
  assert.deepEqual(m.enAttente.get(MACBOOK), { portees: [], rendus: [], refusees: [] }, "plus rien à rendre");
});

// ── LA LETTRE ATTEND, ELLE NE SE PERD PAS ───────────────────────────────────

test("un Mac qui dort : les lettres attendent, puis arrivent toutes, dans l'ordre", async (t) => {
  const m = await deuxChaises(t);
  let dort = true;
  const transport = {
    async echanger(mac, entree) {
      if (dort) throw new Error("ssh: connect to host m3 port 22: Operation timed out");
      return m.transport.echanger(mac, entree);
    }
  };
  // L'ordre des seq n'est pas celui des noms : l'ordre vient bien des seq.
  const ids = ["L-e", "L-c", "L-a", "L-d", "L-b"];
  for (const id of ids) insertMessage(m.b.db, { msg_id: id, sender: m.alice, recipient: m.carol, body: `lettre ${id}` });

  for (let i = 0; i < 3; i += 1) {
    const [r] = await tourner(m, transport);
    assert.equal(r.erreur, "mac-injoignable");
    assert.equal(r.pas, "echanger");
    assert.equal(r.emportees, 0);
    for (const id of ids) {
      assert.equal(getMessageById(m.b.db, id).porte_at, null, `${id} attend (tournée ${i + 1})`);
      assert.equal(compter(m.a.db, id), 0);
    }
    assert.equal(lireLeStatut(m.b.root).erreur, "mac-injoignable", "le statut dit la panne");
  }

  dort = false;
  const [r] = await tourner(m, transport);
  assert.equal(r.erreur, null, r.detail);
  assert.equal(r.emportees, 5);
  assert.deepEqual(parSeq(m.a.db, "mac_origine = 'Studio'"), ids, "toutes, dans l'ordre de leurs seq sur B");
  assert.deepEqual(parSeq(m.b.db, "via IS NULL AND msg_id LIKE 'L-%'"), ids, "SONDE : l'ordre des seq sur B");
  for (const id of ids) {
    assert.equal(compter(m.a.db, id), 1, `${id} une fois`);
    assert.ok(getMessageById(m.b.db, id).porte_at, `${id} portée`);
  }
});

test("une coupure après la pose : rien de perdu, rien de doublé", async (t) => {
  const m = await deuxChaises(t);
  insertMessage(m.b.db, { msg_id: "L-coupe", sender: m.alice, recipient: m.carol, body: "pendant la coupure" });
  insertMessage(m.a.db, { msg_id: "L-coupe-a", sender: m.carol, recipient: m.alice, body: "dans l'autre sens" });

  let [r] = await tourner(m, coupure(m.transport));
  assert.equal(r.erreur, "coupure-simulee");
  assert.ok(getMessageById(m.a.db, "L-coupe"), "l'autre Mac a importé la lettre");
  assert.equal(getMessageById(m.b.db, "L-coupe").porte_at, null, "la réponse perdue ne marque rien");
  assert.equal(compter(m.b.db, "L-coupe-a"), 0, "la réponse perdue n'importe rien");

  [r] = await tourner(m);
  assert.equal(r.erreur, null, r.detail);
  assert.equal(compter(m.a.db, "L-coupe"), 1, "le rejeu ne double rien");
  assert.ok(getMessageById(m.b.db, "L-coupe").porte_at, "la confirmation est posée");
  assert.equal(compter(m.b.db, "L-coupe-a"), 1, "l'autre sens arrive, une fois");
});

test("250 lettres en deux tournées, dans l'ordre, sans double", async (t) => {
  const m = await deuxChaises(t);
  const ids = Array.from({ length: 250 }, (_, i) => `L-${String((i * 37) % 250).padStart(3, "0")}`);
  assert.equal(new Set(ids).size, 250, "SONDE : 250 identifiants distincts");
  const ecrire = m.a.db.transaction(() => {
    for (const id of ids) insertMessage(m.a.db, { msg_id: id, sender: m.carol, recipient: m.alice, body: `lettre ${id}` });
  });
  ecrire();

  let [r] = await tourner(m);
  assert.equal(r.erreur, null, r.detail);
  assert.equal(r.apportees, 200, "un paquet porte au plus 200 lettres");
  [r] = await tourner(m);
  assert.equal(r.erreur, null, r.detail);
  assert.equal(r.apportees, 50, "le reste à la tournée suivante");

  assert.deepEqual(parSeq(m.b.db, "mac_origine = 'MacBook'"), ids, "dans l'ordre des seq de A, d'une tournée à l'autre");
  assert.deepEqual(m.b.db.prepare("SELECT COUNT(DISTINCT msg_id) AS n, COUNT(*) AS t FROM messages WHERE mac_origine = 'MacBook'").get(),
    { n: 250, t: 250 }, "250 lettres, aucune en double");
  [r] = await tourner(m);
  assert.equal(r.apportees, 0, "rien ne revient");
  assert.equal(m.a.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE porte_at IS NULL").get().n, 0, "A a toutes les confirmations");
});

// ── QUI REÇOIT ──────────────────────────────────────────────────────────────

test("le nom nu sur deux Macs : une seule chaise le reçoit", async (t) => {
  const m = deuxMacs(t);
  // lignee-a a une chaise sur chaque Mac ; celle de B est désignée en dernier.
  chaise(m.a.db, "lignee-a", "s-a", { pid: process.pid, designeAt: "2026-11-16T10:00:00.000Z" });
  chaise(m.b.db, "lignee-a", "s-b", { pid: process.ppid, designeAt: "2026-11-16T11:00:00.000Z" });
  let [r] = await tourner(m);
  assert.equal(r.erreur, null, r.detail);
  assert.equal(resolveRecipient(m.a.db, "lignee-a").kind, "distant", "A porte la lignée vers B");
  assert.equal(resolveRecipient(m.b.db, "lignee-a").kind, "lineage", "B la tient");

  insertMessage(m.a.db, { msg_id: "L-nu", sender: "bob", recipient: "lignee-a", body: "pour la lignée" });
  [r] = await tourner(m);
  assert.equal(r.erreur, null, r.detail);
  const arrivee = getMessageById(m.b.db, "L-nu");
  assert.ok(arrivee, "la lettre part vers B au tour suivant");
  assert.equal(arrivee.via, "relais");
  assert.ok(!adressesDuRepli(m.a.db, "lignee-a", { session_id: "s-a" }).includes("lignee-a"),
    "la sœur de A ne relève pas le nom nu");
  assert.ok(adressesDuRepli(m.b.db, "lignee-a", { session_id: "s-b" }).includes("lignee-a"),
    "la chaise de B, et elle seule, le relève");
  assert.equal(compter(m.a.db, "L-nu"), 1, "SONDE : la lettre de A reste chez A, en route");
});

test("le broadcast traverse une fois", async (t) => {
  const m = deuxMacs(t);
  chaise(m.a.db, "carol", "s-1", { pid: process.pid });
  chaise(m.a.db, "dave", "s-2", { pid: process.pid });
  chaise(m.b.db, "lignee-b", "s-1", { pid: process.ppid });
  let [r] = await tourner(m);
  assert.equal(r.erreur, null, r.detail);

  // Le broadcast de A, comme le guichet MCP l'écrit : une lettre par lignée.
  const cibles = broadcastRecipients(m.a.db, "carol");
  assert.deepEqual(cibles, ["dave", "lignee-b"], "SONDE : la lignée de B est une cible, une fois");
  const sansReveil = { ...SANS_MAISONS, reveiller: async () => ({ ok: false, skipped: "test" }) };
  for (const to of cibles) {
    await posterUneLettre(m.a.db, { sender: "carol", recipient: to, body: "à tous", msg_type: "broadcast" }, sansReveil);
  }
  for (let i = 0; i < 2; i += 1) {
    [r] = await tourner(m);
    assert.equal(r.erreur, null, r.detail);
  }
  const surB = m.b.db.prepare("SELECT recipient, msg_type, via FROM messages").all();
  assert.deepEqual(surB, [{ recipient: "lignee-b", msg_type: "broadcast", via: "relais" }],
    "exactement une lettre pour lignee-b sur B, et rien n'est rediffusé");
  assert.equal(m.a.db.prepare("SELECT COUNT(*) AS n FROM messages").get().n, 2, "rien ne revient sur A");
});

// ── LES REFUS ET LES PANNES ─────────────────────────────────────────────────

test("un refus de l'autre Mac : la lettre reste en route, les autres partent, et le rapport le montre", async (t) => {
  const m = await deuxChaises(t);
  insertMessage(m.a.db, { msg_id: "L-double", sender: "bob", recipient: "dave", body: "le corps du MacBook" });
  insertMessage(m.b.db, { msg_id: "L-double", sender: m.alice, recipient: m.carol, body: "le corps du Studio" });
  insertMessage(m.b.db, { msg_id: "L-suivante", sender: m.alice, recipient: m.carol, body: "la suivante" });

  for (let i = 0; i < 2; i += 1) {
    const [r] = await tourner(m);
    assert.equal(r.erreur, null, r.detail);
    assert.equal(r.conflits, 1, `le conflit se compte à chaque tournée (${i + 1})`);
    assert.deepEqual(r.refus_la_bas, [{ msg_id: "L-double", raison: "conflit" }]);
  }
  assert.equal(getMessageById(m.b.db, "L-double").porte_at, null, "la lettre refusée reste en route");
  assert.ok(getMessageById(m.b.db, "L-suivante").porte_at, "la suivante est portée");
  assert.equal(getMessageById(m.a.db, "L-double").body, "le corps du MacBook", "la lettre de là-bas reste intacte");
  assert.equal(compter(m.a.db, "L-suivante"), 1);
});

// R29 : la sonde « conflit » de la relecture finale. Deux chaises, une sur
// chaque Mac, prennent le même msg_id choisi (`valxos-send --msg-id`) pour deux
// lettres différentes, dans les deux sens. Le refus ne restait qu'au journal du
// bureau qui reçoit ; l'expéditeur ne voyait qu'une lettre « à porter ». Il
// revient maintenant sur la lettre d'origine (`relais_refus`), une fois par
// lettre et par raison, et `etat` la montre.
//   · A → B : refusée par l'import de B (pas 4) ; le refus part vers A dans le
//     `marquer` de la tournée suivante (`refusees`), et `echanger` l'écrit là-bas ;
//   · B → A : refusée par l'import de A (`echanger`) ; la réponse le dit
//     (`resume.refus`), et la tournée l'écrit ici au pas 3.
test("R29 : un refus revient à la lettre d'origine, une fois en quatre tournées, dans les deux sens, et etat le montre", async (t) => {
  const m = await deuxChaises(t);
  insertMessage(m.b.db, { msg_id: "bilan-2026-11-20", sender: "dave", recipient: "dave", body: "la lettre du Studio" });
  insertMessage(m.a.db, { msg_id: "bilan-2026-11-20", sender: m.carol, recipient: m.alice, body: "la lettre du MacBook pour alice" });
  insertMessage(m.a.db, { msg_id: "bilan-2026-11-21", sender: "erin", recipient: "erin", body: "la lettre du MacBook" });
  insertMessage(m.b.db, { msg_id: "bilan-2026-11-21", sender: m.alice, recipient: m.carol, body: "la lettre du Studio pour carol" });

  for (let i = 0; i < 4; i += 1) {
    const [r] = await tourner(m);
    assert.equal(r.erreur, null, r.detail);
    assert.deepEqual(r.refus_ici, [{ msg_id: "bilan-2026-11-20", raison: "conflit" }], `tournée ${i + 1}`);
    assert.deepEqual(r.refus_la_bas, [{ msg_id: "bilan-2026-11-21", raison: "conflit" }], `tournée ${i + 1}`);
  }

  const refusSur = (db, id) => evenementsDe(db, id, "relais_refus").map((e) => JSON.parse(e.detail_json));
  assert.deepEqual(refusSur(m.a.db, "bilan-2026-11-20"), [{ mac: STUDIO, raison: "conflit" }],
    "A → B : le MacBook sait que le Studio a refusé sa lettre, une fois");
  assert.deepEqual(refusSur(m.b.db, "bilan-2026-11-21"), [{ mac: MACBOOK, raison: "conflit" }],
    "B → A : le Studio sait que le MacBook a refusé sa lettre, une fois");
  assert.deepEqual(refusSur(m.b.db, "bilan-2026-11-20"), [], "la lettre homonyme du Studio ne reçoit pas le refus");
  assert.deepEqual(refusSur(m.a.db, "bilan-2026-11-21"), [], "ni celle du MacBook");
  for (const [db, id] of [[m.a.db, "bilan-2026-11-20"], [m.b.db, "bilan-2026-11-21"]]) {
    const l = getMessageById(db, id);
    assert.equal(l.porte_at, null, `${id} reste en route (R18)`);
    assert.equal(l.acked_at, null);
  }
  assert.equal(m.enAttente.get(MACBOOK).refusees.length, 1, "SONDE : le refus d'ici repart à chaque tournée ; c'est l'écriture qui ne double pas");

  const etat = (root) => {
    const sortie = spawnSync(process.execPath, [BIN, "etat"], {
      cwd: DEPOT, encoding: "utf8", env: envPropre({ CC2CC_GARDE_BUREAU: "1", CC2CC_V2_HOME: root })
    });
    assert.equal(sortie.status, 0, sortie.stderr);
    return JSON.parse(sortie.stdout).refusees;
  };
  const surA = etat(m.a.root);
  assert.equal(surA.nombre, 1);
  assert.deepEqual(surA.lettres.map(({ msg_id, mac, raison }) => ({ msg_id, mac, raison })),
    [{ msg_id: "bilan-2026-11-20", mac: STUDIO, raison: "conflit" }]);
  assert.match(surA.lettres[0].at, /^\d{4}-\d\d-\d\dT/);
  const surB = etat(m.b.root);
  assert.equal(surB.nombre, 1);
  assert.deepEqual(surB.lettres.map(({ msg_id, mac, raison }) => ({ msg_id, mac, raison })),
    [{ msg_id: "bilan-2026-11-21", mac: MACBOOK, raison: "conflit" }]);
});

test("une panne à l'import : l'entrée des accusés se vide, la lettre revient en rejeu, rien de doublé", async (t) => {
  const m = await deuxChaises(t);
  insertMessage(m.a.db, { msg_id: "L-panne", sender: m.carol, recipient: m.alice, body: "pendant la panne" });
  const panne = {
    ...SANS_MAISONS,
    reveiller: async () => {
      const erreur = new Error("simulated failure while waking the chair");
      erreur.code = "panne-simulee";
      throw erreur;
    }
  };
  let [r] = await tourner(m, m.transport, panne);
  assert.equal(r.erreur, "panne-simulee");
  assert.equal(r.pas, "importer");
  assert.equal(m.enAttente.has(MACBOOK), false, "rien n'est promis à l'autre Mac");
  assert.equal(getMessageById(m.a.db, "L-panne").porte_at, null);

  for (let i = 0; i < 2; i += 1) {
    [r] = await tourner(m);
    assert.equal(r.erreur, null, r.detail);
  }
  assert.equal(compter(m.b.db, "L-panne"), 1, "le rejeu ne double rien");
  assert.ok(getMessageById(m.a.db, "L-panne").porte_at, "la confirmation finit par partir");
});

// R31 : le rapport ne dit « emportées » que ce que la transaction des marques a
// vraiment posé. Ici `marquerRendus` lève APRÈS `marquerPortees`, dans la même
// transaction (un déclencheur SQLite sur le bureau de B : la vraie fonction lève,
// comme sur un disque plein) ; tout revient en arrière, et le rapport aussi.
test("une marque qui lève au pas 3 : rien n'est marqué, et le rapport ne compte aucune lettre emportée", async (t) => {
  const m = await deuxChaises(t);
  insertMessage(m.a.db, { msg_id: "L-de-a", sender: m.carol, recipient: m.alice, body: "pour B" });
  let [r] = await tourner(m);
  assert.equal(r.erreur, null, r.detail);
  ackMessage(m.b.db, "L-de-a", m.alice);
  insertMessage(m.b.db, { msg_id: "L-de-b", sender: m.alice, recipient: m.carol, body: "pour A" });

  m.b.db.exec(`CREATE TRIGGER panne_des_rendus BEFORE UPDATE OF accuse_rendu_at ON messages
    BEGIN SELECT RAISE(ABORT, 'simulated failure while marking the events'); END`);
  [r] = await tourner(m);
  assert.equal(r.pas, "marquer");
  assert.match(r.detail, /simulated failure while marking the events/);
  assert.equal(r.emportees, 0, "la transaction est revenue en arrière : aucune lettre emportée");
  assert.equal(r.evenements_emportes, 0);
  assert.equal(getMessageById(m.b.db, "L-de-b").porte_at, null, "SONDE : marquerPortees avait posé porte_at, et il est revenu en arrière");
  assert.equal(compter(m.a.db, "L-de-b"), 1, "SONDE : l'autre Mac l'a bien importée (pas 2)");
  assert.equal(lireLeStatut(m.b.root).emportees, 0, "le statut dit la même chose");

  m.b.db.exec("DROP TRIGGER panne_des_rendus");
  [r] = await tourner(m);
  assert.equal(r.erreur, null, r.detail);
  assert.equal(r.emportees, 1, "la tournée suivante confirme la lettre, une fois");
  assert.ok(getMessageById(m.b.db, "L-de-b").porte_at);
  assert.equal(compter(m.a.db, "L-de-b"), 1, "un rejeu, sans double");
});

test("un Mac resté à l'ancienne version : la tournée échoue proprement et ne marque rien", async (t) => {
  const m = await deuxChaises(t);
  insertMessage(m.b.db, { msg_id: "L-1", sender: m.alice, recipient: m.carol, body: "pour A" });
  const avant = structuredClone(m.enAttente.get(MACBOOK));
  const racines = { [MACBOOK]: m.a.root };
  const rienDeMarque = (quand) => {
    assert.equal(m.b.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE porte_at IS NOT NULL").get().n, 0, `${quand} : aucune porte_at`);
    assert.equal(compter(m.b.db, "L-a"), 0, `${quand} : rien d'importé`);
    assert.deepEqual(m.enAttente.get(MACBOOK), avant, `${quand} : les accusés à rendre attendent`);
  };

  // Code 127 : la commande de l'autre Mac n'existe pas (un vrai `env` sur un node absent).
  let [r] = await tourner(m, transportLocal({ racines, moi: STUDIO, node: "/opt/valxos/absent/node" }));
  assert.equal(r.erreur, "relais-absent-de-l-autre-mac", r.detail);
  rienDeMarque("127");
  // Un dépôt d'avant le relais : node ne trouve pas src/bin/relais.js.
  const ancien = fs.mkdtempSync(path.join(os.tmpdir(), "rt-ancien-"));
  t.after(() => fs.rmSync(ancien, { recursive: true, force: true }));
  [r] = await tourner(m, transportLocal({ racines, moi: STUDIO, depot: ancien }));
  assert.equal(r.erreur, "relais-absent-de-l-autre-mac", r.detail);
  rienDeMarque("dépôt ancien");

  // Une réponse en schéma 7, ou sans `refus` : l'autre Mac a tout appliqué, mais
  // sa réponse ne se lit pas ; rien n'est marqué ni importé ici.
  insertMessage(m.a.db, { msg_id: "L-a", sender: m.carol, recipient: m.alice, body: "pour B" });
  const enSept = {
    async echanger(mac, entree) {
      const reponse = await m.transport.echanger(mac, entree);
      return { ...reponse, paquet: { ...reponse.paquet, schema: 7 } };
    }
  };
  [r] = await tourner(m, enSept);
  assert.equal(r.erreur, "paquet-schema", r.detail);
  rienDeMarque("schéma 7");
  const sansRefus = {
    async echanger(mac, entree) {
      const reponse = await m.transport.echanger(mac, entree);
      const { refus, ...resume } = reponse.resume;
      assert.ok(Array.isArray(refus), "SONDE : la vraie réponse porte refus");
      return { ...reponse, resume };
    }
  };
  [r] = await tourner(m, sansRefus);
  assert.equal(r.erreur, "paquet-invalide", r.detail);
  rienDeMarque("sans refus");

  // Le Mac à jour : tout passe, une fois.
  [r] = await tourner(m);
  assert.equal(r.erreur, null, r.detail);
  assert.equal(r.emportees, 1);
  assert.equal(r.apportees, 1);
  assert.equal(compter(m.a.db, "L-1"), 1);
  assert.equal(compter(m.b.db, "L-a"), 1);
  assert.ok(getMessageById(m.b.db, "L-1").porte_at);
});

// ── LE RETRAIT (R28) ────────────────────────────────────────────────────────

// La sonde « retrait » de la relecture finale : alice a une chaise sur chaque
// Mac, celle du Studio désignée en dernier ; on retire le relais (relais.json
// enlevé des deux côtés, plus aucun échange). Sans `oublier`, le carnet du
// MacBook gardait le Studio pour toujours : la lettre au nom nu attendait un
// porteur qui n'existe plus, que la chaise d'ici ne relevait ni n'accusait.
test("le retrait : après « oublier Studio », sans relais.json, le nom nu revient à la chaise d'ici", async (t) => {
  const m = deuxMacs(t);
  const locale = chaise(m.a.db, "alice", "s-1", { pid: process.ppid, designeAt: "2026-11-16T10:00:00.000Z" });
  chaise(m.b.db, "alice", "s-9", { pid: process.pid, designeAt: "2026-11-16T11:00:00.000Z" });
  const [r] = await tourner(m);
  assert.equal(r.erreur, null, r.detail);
  assert.equal(resolveRecipient(m.a.db, "alice").kind, "distant", "SONDE : le Studio tient la lignée");

  // Le retrait : relais.json enlevé des deux côtés (la veille est arrêtée).
  fs.rmSync(path.join(m.a.root, "relais.json"));
  fs.rmSync(path.join(m.b.root, "relais.json"));
  insertMessage(m.a.db, { msg_id: "L-apres-retrait", sender: "bob", recipient: "alice", body: "pour alice, sur le MacBook seul" });
  assert.equal(resolveRecipient(m.a.db, "alice").kind, "distant", "SONDE : sans oublier, le carnet porte encore vers le Studio");
  const fiches = m.a.db.prepare("SELECT COUNT(*) AS n FROM carnet").get().n;

  const oubli = spawnSync(process.execPath, [BIN, "oublier", STUDIO], {
    cwd: DEPOT, encoding: "utf8", env: envPropre({ CC2CC_GARDE_BUREAU: "1", CC2CC_V2_HOME: m.a.root })
  });
  assert.equal(oubli.status, 0, oubli.stderr);
  assert.deepEqual(JSON.parse(oubli.stdout), { mac: STUDIO, parties: 1 });

  const apres = resolveRecipient(m.a.db, "alice");
  assert.equal(apres.kind, "lineage", "le nom nu se résout de nouveau ici");
  assert.equal(apres.targets[0].id, locale);
  assert.ok(adressesDuRepli(m.a.db, "alice", { session_id: "s-1" }).includes("alice"), "les crochets de la chaise d'ici le relèvent");
  ackMessage(m.a.db, "L-apres-retrait", locale);
  assert.notEqual(getMessageById(m.a.db, "L-apres-retrait").acked_at, null, "et elle l'accuse");
  // Camp B : rien ne s'efface, la fiche du Studio porte parti_at.
  assert.equal(m.a.db.prepare("SELECT COUNT(*) AS n FROM carnet").get().n, fiches);
  assert.notEqual(m.a.db.prepare("SELECT parti_at FROM carnet WHERE chaise_id = 'alice#s-9'").get().parti_at, null);
});

// ── L'ARRÊT DE LA VEILLE (R37) ──────────────────────────────────────────────

// La lignée de la sonde R34 : une chaise sur chaque Mac, désignées toutes les
// deux, celle du Studio en dernier (elle tient la lignée). La première tournée
// échange les carnets.
async function laLigneeSurLesDeuxMacs(t, m = deuxMacs(t)) {
  const surA = chaise(m.a.db, "lignee-r34", "s-a", { pid: process.ppid, designeAt: "2026-11-17T15:47:47.634Z" });
  const surB = chaise(m.b.db, "lignee-r34", "s-b", { pid: process.pid, designeAt: "2026-11-17T15:47:49.574Z" });
  const [r] = await tourner(m);
  assert.equal(r.erreur, null, r.detail);
  assert.equal(resolveRecipient(m.a.db, "lignee-r34").kind, "distant", "SONDE : le Studio tient la lignée");
  assert.equal(resolveRecipient(m.b.db, "lignee-r34").kind, "lineage", "SONDE : le Studio la sert");
  return { ...m, surA, surB };
}

const rendre = (m, transport = m.transport) =>
  rendreCeQuiEstDu({ db: m.b.db, config: m.config, transport, enAttente: m.enAttente });

// La sonde R34 de la tâche 7, rejouée : une lettre au nom nu, portée au TOUT
// DERNIER tour avant l'arrêt. Avant R37, la veille sortait sans rendre la
// confirmation : la lettre d'origine gardait `porte_at` nul, et `etat` du Mac
// visité ne comptait rien (il ne regardait que `macs`, vide là-bas).
test("R37 : la lettre au nom nu portée au tout dernier tour est confirmée par le dernier échange ; etat du Mac visité la voyait en route", async (t) => {
  const m = await laLigneeSurLesDeuxMacs(t);
  insertMessage(m.a.db, { msg_id: "L-r34", sender: "bob", recipient: "lignee-r34", body: "le tout dernier tour" });
  const aPorter = etatDe(m.a.root);
  assert.deepEqual(aPorter.en_route, { [STUDIO]: 1 }, "le Mac visité compte la lettre à porter vers le Mac de son carnet");
  assert.deepEqual(aPorter.offertes, { [STUDIO]: 0 });

  // Le tout dernier tour : il porte la lettre.
  const [r] = await tourner(m);
  assert.equal(r.erreur, null, r.detail);
  assert.equal(r.apportees, 1);
  assert.equal(getMessageById(m.b.db, "L-r34").via, "relais");
  assert.equal(getMessageById(m.a.db, "L-r34").porte_vers, STUDIO);
  assert.equal(getMessageById(m.a.db, "L-r34").porte_at, null, "SONDE : la confirmation attend la tournée suivante");
  const enVol = etatDe(m.a.root);
  assert.deepEqual(enVol.offertes, { [STUDIO]: 1 }, "etat du Mac visité voit la lettre offerte et pas confirmée");
  assert.deepEqual(enVol.en_route, { [STUDIO]: 1 });

  // L'arrêt : la veille rend ce qu'elle doit, en un dernier échange.
  const derniers = await rendre(m);
  assert.equal(derniers.length, 1);
  assert.equal(derniers[0].mac, MACBOOK);
  assert.equal(derniers[0].erreur, null, derniers[0].detail);
  assert.equal(derniers[0].confirmees, 1);
  assert.ok(getMessageById(m.a.db, "L-r34").porte_at, "après l'arrêt, la lettre d'origine est confirmée portée");
  assert.equal(m.enAttente.has(MACBOOK), false, "plus rien n'est dû");
  assert.deepEqual(etatDe(m.a.root).offertes, { [STUDIO]: 0 });
  assert.deepEqual(etatDe(m.a.root).en_route, { [STUDIO]: 0 });
  const auStudio = etatDe(m.b.root);
  assert.deepEqual(auStudio.en_route, { [MACBOOK]: 0 });
  assert.deepEqual(auStudio.offertes, { [MACBOOK]: 0 });
  assert.equal(compter(m.b.db, "L-r34"), 1);
  assert.equal(compter(m.a.db, "L-r34"), 1);
  assert.equal(m.a.db.prepare("SELECT parti_at FROM carnet WHERE chaise_id = ?").get(m.surB).parti_at, null,
    "le dernier échange ne fait partir aucune fiche du carnet du Mac visité");
  // La veille arrêtée, les carnets intacts : un seul Mac sert la lettre.
  assert.equal(servieA(m.b.db, "lignee-r34", "s-b", "L-r34"), true, "le Studio sert sa copie");
  assert.equal(servieA(m.a.db, "lignee-r34", "s-a", "L-r34"), false, "le MacBook ne la sert pas");
});

// LIMITE CONNUE, que R37 ne ferme pas (le constat de la vague R36-R38). La
// livraison suit la résolution, jamais `porte_at` (R16 : une lettre portée puis
// tenue ici de nouveau doit être servie ici). Après `oublier` des deux côtés,
// chaque Mac résout le nom nu chez lui : la lettre d'origine, confirmée portée
// mais pas accusée, est servie au MacBook, et sa copie au Studio. Le dernier
// échange ne la protège que si elle a été accusée avant l'arrêt (le test
// suivant). docs/RELAIS.md le dit, dans « Remove the relay ».
test("R37, limite connue : après le retrait, une lettre au nom nu portée et pas encore accusée est servie sur les deux Macs", async (t) => {
  const m = await laLigneeSurLesDeuxMacs(t);
  insertMessage(m.a.db, { msg_id: "L-r34-double", sender: "bob", recipient: "lignee-r34", body: "portée, pas accusée" });
  const [r] = await tourner(m);
  assert.equal(r.apportees, 1);
  const [d] = await rendre(m);
  assert.equal(d.erreur, null, d.detail);
  assert.ok(getMessageById(m.a.db, "L-r34-double").porte_at, "SONDE : la confirmation est rendue");
  assert.equal(getMessageById(m.a.db, "L-r34-double").acked_at, null, "SONDE : personne ne l'a accusée");
  // R39 : etat du Mac où elle est née la montre avant le retrait (la doc dit de
  // la laisser accuser d'abord).
  const avantLeRetrait = etatDe(m.a.root);
  assert.deepEqual(avantLeRetrait.portees_non_accusees, { [STUDIO]: 1 });
  assert.deepEqual(avantLeRetrait.offertes, { [STUDIO]: 0 }, "SONDE : offertes ne la voit pas, elle est confirmée");

  oublierSur(m.a.root, STUDIO);
  oublierSur(m.b.root, MACBOOK);
  assert.equal(servieA(m.b.db, "lignee-r34", "s-b", "L-r34-double"), true, "le Studio sert sa copie");
  assert.equal(servieA(m.a.db, "lignee-r34", "s-a", "L-r34-double"), true,
    "et le MacBook sert l'originale : porte_at ne compte pas dans la livraison (R16)");
});

test("R37 : le dernier échange n'offre aucune lettre, garde le carnet de l'autre Mac, et ce que l'autre Mac y offre n'est ni perdu ni doublé", async (t) => {
  const m = await deuxChaises(t);
  insertMessage(m.a.db, { msg_id: "L-de-a", sender: m.carol, recipient: m.alice, body: "portée au dernier tour" });
  let [r] = await tourner(m);
  assert.equal(r.apportees, 1);
  // Entre le dernier tour et l'arrêt, une lettre de chaque côté.
  insertMessage(m.b.db, { msg_id: "L-de-b-tard", sender: m.alice, recipient: m.carol, body: "écrite au Studio après le dernier tour" });
  insertMessage(m.a.db, { msg_id: "L-de-a-tard", sender: m.carol, recipient: m.alice, body: "écrite au MacBook après le dernier tour" });
  const presentes = (db) => db.prepare("SELECT chaise_id FROM carnet WHERE parti_at IS NULL ORDER BY chaise_id").all().map((f) => f.chaise_id);
  const carnetDeA = presentes(m.a.db);
  assert.deepEqual(carnetDeA, [m.alice], "SONDE : le MacBook connaît la chaise du Studio");

  const [d] = await rendre(m);
  assert.equal(d.erreur, null, d.detail);
  assert.ok(getMessageById(m.a.db, "L-de-a").porte_at, "la confirmation due est rendue");
  assert.equal(getMessageById(m.b.db, "L-de-b-tard").porte_vers, null, "le dernier échange n'offre aucune lettre d'ici");
  assert.equal(compter(m.a.db, "L-de-b-tard"), 0);
  assert.deepEqual(presentes(m.a.db), carnetDeA, "aucune fiche du carnet de l'autre Mac ne part");
  assert.equal(compter(m.b.db, "L-de-a-tard"), 0, "la réponse du dernier échange n'est pas importée");
  const tard = getMessageById(m.a.db, "L-de-a-tard");
  assert.equal(tard.porte_vers, STUDIO, "SONDE : l'autre Mac l'a offerte en répondant");
  assert.equal(tard.porte_at, null, "et rien ne la confirme : elle reste en route chez lui");
  assert.deepEqual(etatDe(m.a.root).offertes, { [STUDIO]: 1 }, "etat du MacBook la montre offerte");

  // La veille repart : chaque lettre tardive passe une fois, et se confirme.
  for (let i = 0; i < 2; i += 1) {
    [r] = await tourner(m);
    assert.equal(r.erreur, null, r.detail);
  }
  for (const id of ["L-de-a-tard", "L-de-b-tard"]) {
    assert.equal(compter(m.a.db, id), 1, `${id} une fois au MacBook`);
    assert.equal(compter(m.b.db, id), 1, `${id} une fois au Studio`);
  }
  assert.ok(getMessageById(m.a.db, "L-de-a-tard").porte_at);
  assert.ok(getMessageById(m.b.db, "L-de-b-tard").porte_at);
});

test("R37 : un accusé posé au Studio après le dernier tour part avec le dernier échange ; après le retrait, un seul Mac a servi la lettre", async (t) => {
  const m = await laLigneeSurLesDeuxMacs(t);
  insertMessage(m.a.db, { msg_id: "L-lue", sender: "bob", recipient: "lignee-r34", body: "lue au Studio avant l'arrêt" });
  const [r] = await tourner(m);
  assert.equal(r.apportees, 1);
  assert.equal(servieA(m.b.db, "lignee-r34", "s-b", "L-lue"), true, "SONDE : la chaise du Studio la reçoit");
  ackMessage(m.b.db, "L-lue", m.surB, { at: "2026-11-17T16:00:00.000Z" });

  const [d] = await rendre(m);
  assert.equal(d.erreur, null, d.detail);
  assert.equal(d.confirmees, 1);
  assert.equal(d.evenements_emportes, 1, "l'accusé est marqué rendu au Studio");
  const origine = getMessageById(m.a.db, "L-lue");
  assert.ok(origine.porte_at);
  assert.equal(origine.acked_at, "2026-11-17T16:00:00.000Z", "le MacBook a appris l'accusé");
  assert.ok(getMessageById(m.b.db, "L-lue").accuse_rendu_at);
  assert.deepEqual(etatDe(m.a.root).portees_non_accusees, { [STUDIO]: 0 }, "R39 : accusée, etat ne la compte plus");

  oublierSur(m.a.root, STUDIO);
  oublierSur(m.b.root, MACBOOK);
  assert.equal(servieA(m.a.db, "lignee-r34", "s-a", "L-lue"), false, "après le retrait, le MacBook ne la sert pas");
  assert.equal(servieA(m.b.db, "lignee-r34", "s-b", "L-lue"), false, "ni le Studio de nouveau : elle est accusée");
});

test("R37 : un dernier échange qui échoue ne marque rien ; un Mac à qui rien n'est dû n'est pas visité", async (t) => {
  const m = await deuxChaises(t);
  insertMessage(m.a.db, { msg_id: "L-de-a", sender: m.carol, recipient: m.alice, body: "portée au dernier tour" });
  const [r] = await tourner(m);
  assert.equal(r.apportees, 1);
  ackMessage(m.b.db, "L-de-a", m.alice);
  const du = structuredClone(m.enAttente.get(MACBOOK));
  const injoignable = {
    async echanger() {
      const erreur = new Error("ssh could not reach m3: ssh: connect to host m3 port 22: Host is down");
      erreur.code = "mac-injoignable";
      throw erreur;
    }
  };
  const [d] = await rendre(m, injoignable);
  assert.equal(d.erreur, "mac-injoignable");
  assert.equal(d.pas, "echanger");
  assert.match(d.detail, /Host is down/);
  assert.equal(d.confirmees, 0);
  assert.equal(d.evenements_emportes, 0);
  assert.equal(getMessageById(m.a.db, "L-de-a").porte_at, null, "rien n'est marqué là-bas");
  assert.equal(getMessageById(m.b.db, "L-de-a").accuse_rendu_at, null, "rien n'est marqué ici");
  assert.deepEqual(m.enAttente.get(MACBOOK), du, "ce qui est dû reste dû");

  // Une réponse d'une autre version : l'autre Mac a posé les marques, mais rien
  // ne se marque ici.
  const enSept = {
    async echanger(mac, entree) {
      const reponse = await m.transport.echanger(mac, entree);
      return { ...reponse, paquet: { ...reponse.paquet, schema: 7 } };
    }
  };
  const [v] = await rendre(m, enSept);
  assert.equal(v.erreur, "paquet-schema", v.detail);
  assert.equal(v.pas, "marquer");
  assert.equal(getMessageById(m.b.db, "L-de-a").accuse_rendu_at, null, "l'accusé n'est pas marqué rendu ici");
  assert.ok(getMessageById(m.a.db, "L-de-a").porte_at, "SONDE : l'autre Mac a posé la confirmation (un fait vrai)");

  // Tout rendu : la suivante ne visite personne.
  const [ok] = await rendre(m);
  assert.equal(ok.erreur, null, ok.detail);
  assert.equal(m.enAttente.has(MACBOOK), false);
  const personne = { async echanger() { assert.fail("aucun échange : rien n'est dû"); } };
  assert.deepEqual(await rendre(m, personne), []);
});

// ── LE RÉVEIL ───────────────────────────────────────────────────────────────

test("la chaise du Studio est réveillée par son propre bureau", async (t) => {
  const m = await deuxChaises(t);
  const socket = runtimePaths(porteDeReveil(m.b.db, m.alice)).socket;
  assert.ok(socket.startsWith(path.join(m.b.root, "run") + path.sep), `SONDE : la porte est dans le bureau de B (${socket})`);
  const coups = [];
  const serveur = net.createServer((client) => {
    let recu = "";
    client.on("data", (morceau) => { recu += morceau; });
    client.on("end", () => coups.push(recu));
  });
  await new Promise((resolve) => serveur.listen(socket, resolve));
  t.after(() => new Promise((resolve) => serveur.close(resolve)));

  const [vide] = await tourner(m);
  assert.equal(vide.erreur, null);
  assert.equal(await attendre(() => coups.length > 0, { ms: 300 }), false, "SONDE : une tournée sans lettre ne réveille personne");

  insertMessage(m.a.db, { msg_id: "L-reveil", sender: m.carol, recipient: m.alice, body: "réveille-toi" });
  const [r] = await tourner(m);
  assert.equal(r.erreur, null, r.detail);
  assert.equal(r.apportees, 1);
  assert.ok(await attendre(() => coups.length > 0), "la porte de la chaise a reçu une connexion");
  assert.deepEqual(coups, ["L-reveil\n"]);
});

// ── LE TRANSPORT SSH ────────────────────────────────────────────────────────

// Un enfant factice : il lit l'entrée, puis rend `stdout`, `stderr` et `code`
// (ou ne finit jamais, `jamais`).
function enfantFaux({ code = 0, stdout = "", stderr = "", jamais = false } = {}) {
  const enfant = new EventEmitter();
  enfant.stdin = new PassThrough();
  enfant.stdout = new PassThrough();
  enfant.stderr = new PassThrough();
  enfant.recu = "";
  enfant.tue = null;
  enfant.kill = (signal = "SIGTERM") => {
    enfant.tue = signal;
    setImmediate(() => enfant.emit("close", null, signal));
    return true;
  };
  let fins = 0;
  const fin = () => {
    fins += 1;
    if (fins === 2) enfant.emit("close", code, null);
  };
  enfant.stdout.on("end", fin);
  enfant.stderr.on("end", fin);
  enfant.stdin.on("data", (morceau) => { enfant.recu += morceau; });
  enfant.stdin.on("end", () => {
    if (jamais) return;
    enfant.stdout.end(stdout);
    enfant.stderr.end(stderr);
  });
  return enfant;
}

function spawnFaux(reponses) {
  const appels = [];
  const lancer = (commande, args, options) => {
    const enfant = enfantFaux(reponses[Math.min(appels.length, reponses.length - 1)]);
    appels.push({ commande, args, options, enfant });
    return enfant;
  };
  return { appels, lancer };
}

test("le transport ssh lance la commande exacte", async () => {
  const reponse = { resume: { neuves: 0, refus: [] }, paquet: { version: 1, de: MACBOOK } };
  const { appels, lancer } = spawnFaux([
    { stdout: `${JSON.stringify(reponse)}\n` },
    { code: 1, stderr: "paquet-schema: packet schema 7 is not 8: update the Messenger on both Macs\n" },
    { code: 127, stderr: "env: /opt/homebrew/bin/node: No such file or directory\n" },
    { stdout: "{ pas du json" },
    { code: 255, stderr: "ssh: connect to host m3 port 22: Operation timed out\n" },
    { jamais: true }
  ]);
  const transport = transportSsh(MAC_DE_L_EXEMPLE, { moi: STUDIO, spawn: lancer });
  const entree = { marquer: { portees: ["L-1"], rendus: [] }, paquet: { version: 1, de: STUDIO, pour: MACBOOK } };

  assert.deepEqual(await transport.echanger(MACBOOK, entree), reponse, "la sortie est la réponse");
  assert.equal(appels[0].commande, "ssh");
  // R36 : aucune connexion partagée (ControlMaster=no), ni ControlPath ni
  // ControlPersist. Mesuré entre deux vrais Macs par Tailscale SSH : avec le
  // partage, ssh sortait parfois en 255 alors que la commande de là-bas avait
  // fini (16 sur 270) ; sans, 0 sur 210.
  assert.deepEqual(appels[0].args, [
    "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "ControlMaster=no",
    "m3", "env", "VALXOS_MESSENGER_HOME=/opt/valxos/bureau", "/opt/homebrew/bin/node",
    "/opt/valxos/cc2cc-v2/src/bin/relais.js", "echanger", "--de", "Studio"
  ]);
  assert.ok(!appels[0].args.some((a) => /^Control(Path|Persist)=/.test(a)), "aucun socket de maître, aucune persistance");
  assert.deepEqual(JSON.parse(appels[0].enfant.recu), entree, "le JSON passe par l'entrée");

  await assert.rejects(transport.echanger(MACBOOK, entree), (e) =>
    e.code === "relais-distant-echanger" && /paquet-schema: packet schema 7/.test(e.message));
  await assert.rejects(transport.echanger(MACBOOK, entree), (e) => e.code === "relais-absent-de-l-autre-mac");
  await assert.rejects(transport.echanger(MACBOOK, entree), (e) => e.code === "paquet-illisible");
  await assert.rejects(transport.echanger(MACBOOK, entree), (e) =>
    e.code === "mac-injoignable" && /Operation timed out/.test(e.message), "R22 : ssh n'atteint pas l'autre Mac (255)");

  const lent = transportSsh(MAC_DE_L_EXEMPLE, { moi: STUDIO, spawn: lancer, timeoutMs: 50 });
  await assert.rejects(lent.echanger(MACBOOK, entree), (e) => e.code === "relais-delai-depasse");
  assert.equal(appels.at(-1).enfant.tue, "SIGTERM", "un échange trop long est arrêté");

  // ssh absent de ce Mac : l'erreur du lancement, telle quelle.
  const sansSsh = transportSsh(MAC_DE_L_EXEMPLE, {
    moi: STUDIO,
    spawn: () => {
      const enfant = enfantFaux({ jamais: true });
      setImmediate(() => enfant.emit("error", Object.assign(new Error("spawn ssh ENOENT"), { code: "ENOENT" })));
      return enfant;
    }
  });
  await assert.rejects(sansSsh.echanger(MACBOOK, entree), (e) => e.code === "ENOENT");
});

test("R22 : ssh n'atteint pas l'autre Mac (sortie 255) — mac-injoignable, rien de marqué, puis tout passe", async (t) => {
  const m = await deuxChaises(t);
  insertMessage(m.b.db, { msg_id: "L-dort", sender: m.alice, recipient: m.carol, body: "pour un Mac endormi" });
  const avant = structuredClone(m.enAttente.get(MACBOOK));
  const { appels, lancer } = spawnFaux([{ code: 255, stderr: "ssh: connect to host m3 port 22: Host is down\n" }]);
  const endormi = transportSsh(MAC_DE_L_EXEMPLE, { moi: STUDIO, spawn: lancer });
  const [r] = await tourner(m, endormi);
  assert.equal(appels.length, 1, "SONDE : l'échange a été tenté");
  assert.equal(r.erreur, "mac-injoignable");
  assert.equal(r.pas, "echanger");
  assert.match(r.detail, /Host is down/);
  assert.equal(getMessageById(m.b.db, "L-dort").porte_at, null, "rien de marqué");
  assert.deepEqual(m.enAttente.get(MACBOOK), avant, "les accusés à rendre attendent");
  assert.equal(lireLeStatut(m.b.root).erreur, "mac-injoignable");

  const [apres] = await tourner(m);
  assert.equal(apres.erreur, null, apres.detail);
  assert.equal(compter(m.a.db, "L-dort"), 1, "la lettre a attendu, puis elle arrive une fois");
  assert.ok(getMessageById(m.b.db, "L-dort").porte_at);
});

test("le transport ssh refuse une configuration que le shell de l'autre Mac couperait", () => {
  const options = { moi: STUDIO, spawn: () => assert.fail("rien ne se lance") };
  for (const [nom, mac] of [
    ["un hôte qui serait une option", { ...MAC_DE_L_EXEMPLE, ssh: "-oProxyCommand=true" }],
    ["un bureau avec une espace", { ...MAC_DE_L_EXEMPLE, bureau: "/opt/valxos/mon bureau" }],
    ["un dépôt avec un $", { ...MAC_DE_L_EXEMPLE, depot: "/opt/$HOME/cc2cc-v2" }],
    ["un chemin relatif", { ...MAC_DE_L_EXEMPLE, node: "node" }]
  ]) {
    assert.throws(() => transportSsh(mac, options), (e) => e.code === "config-relais-invalide", nom);
  }
  assert.throws(() => transportSsh(MAC_DE_L_EXEMPLE, { ...options, moi: "Mac Studio" }), (e) => e.code === "config-relais-invalide");
  // R36 : le bureau d'ici n'entre plus dans la ligne de ssh (plus de ControlPath) ;
  // le transport ne le demande plus, et rien d'autre ne se vérifie à sa place.
  assert.doesNotThrow(() => transportSsh(MAC_DE_L_EXEMPLE, options));
  assert.doesNotThrow(() => transportsSsh({ moi: STUDIO, macs: { [MACBOOK]: MAC_DE_L_EXEMPLE } }, { spawn: options.spawn }));
});

test("les transports ssh du relais : un par Mac de relais.json", async () => {
  const reponse = { resume: { refus: [] }, paquet: {} };
  const { appels, lancer } = spawnFaux([{ stdout: JSON.stringify(reponse) }]);
  const config = { moi: STUDIO, macs: { [MACBOOK]: MAC_DE_L_EXEMPLE }, intervalle_ms: 2000 };
  const transport = transportsSsh(config, { spawn: lancer });
  assert.deepEqual(await transport.echanger(MACBOOK, { marquer: { portees: [], rendus: [] }, paquet: {} }), reponse);
  assert.equal(appels[0].args[6], "m3");
  assert.deepEqual(appels[0].args.slice(-3), ["echanger", "--de", "Studio"]);
  await assert.rejects(transport.echanger("Autre", {}), (e) => e.code === "config-relais-invalide");
  assert.equal(appels.length, 1, "un Mac inconnu ne lance rien");
});

// ── LA VEILLE ───────────────────────────────────────────────────────────────

test("une seconde veille refuse de démarrer", async (t) => {
  // Un Studio sans autre Mac : la veille tourne, sans rien porter (aucun ssh).
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rt-veille-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "relais.json"), JSON.stringify({ moi: STUDIO, macs: {}, intervalle_ms: 200 }));
  const env = envPropre({ CC2CC_GARDE_BUREAU: "1", CC2CC_V2_HOME: root });
  const verrou = path.join(root, "run", "relais.verrou");

  const premiere = spawn(process.execPath, [BIN, "tournee"], { cwd: DEPOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let journal = "";
  premiere.stderr.on("data", (m) => { journal += m; });
  premiere.stdout.resume();
  const sortie = new Promise((resolve) => premiere.on("exit", (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    if (premiere.exitCode === null && premiere.signalCode === null) {
      process.kill(premiere.pid, "SIGKILL");
      await sortie;
    }
  });
  assert.ok(await attendre(() => fs.existsSync(verrou), { ms: 20_000 }), `la première veille prend le verrou (${journal})`);
  assert.equal(JSON.parse(fs.readFileSync(verrou, "utf8")).pid, premiere.pid);

  for (const args of [["tournee"], ["tournee", "--une"]]) {
    const seconde = spawnSync(process.execPath, [BIN, ...args], { cwd: DEPOT, env, encoding: "utf8", timeout: 20_000 });
    assert.equal(seconde.status, 3, `${args.join(" ")} : ${seconde.stderr}`);
    assert.match(seconde.stderr, /relais\.verrou/);
  }
  assert.equal(premiere.exitCode, null, "la première veille tourne toujours");

  process.kill(premiere.pid, "SIGTERM");
  assert.deepEqual(await sortie, { code: 0, signal: null }, journal);
  assert.equal(fs.existsSync(verrou), false, "l'arrêt rend le verrou");
  assert.match(journal, /relais_en_service/);
  assert.match(journal, /relais_hors_service/);

  const une = spawnSync(process.execPath, [BIN, "tournee", "--une"], { cwd: DEPOT, env, encoding: "utf8", timeout: 20_000 });
  assert.equal(une.status, 0, une.stderr);
  assert.deepEqual(JSON.parse(une.stdout), { rapports: [], derniers_echanges: [] });
  assert.equal(fs.existsSync(verrou), false, "la tournée unique rend le verrou");
});

// UN `ssh` DE CARTON, en tête du PATH de la veille lancée : il saute les options
// et l'hôte, et lance ICI la ligne que le vrai ssh ferait lancer sur l'autre Mac
// (comme `transportLocal`, mais pour un processus à part). Le vrai ssh ne tourne
// jamais. Quand le fichier `panne` existe, il sort en 255 sans rien lancer,
// comme un Mac injoignable.
function sshDeCarton(t) {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), "rt-ssh-"));
  t.after(() => fs.rmSync(dossier, { recursive: true, force: true }));
  const panne = path.join(dossier, "panne");
  fs.writeFileSync(path.join(dossier, "ssh"), [
    "#!/bin/sh",
    `if [ -e '${panne}' ]; then echo 'ssh: connect to host autre-mac port 22: Host is down' >&2; exit 255; fi`,
    "while [ \"$1\" = \"-o\" ]; do shift 2; done",
    "shift",
    "unset CC2CC_V2_HOME VALXOS_MESSENGER_HOME",
    "SSH_CONNECTION='10.0.0.1 50000 10.0.0.2 22'",
    "export SSH_CONNECTION",
    "exec \"$@\"",
    ""
  ].join("\n"), { mode: 0o755 });
  return { dossier, panne };
}

// Le Studio lancé pour de vrai : son relais.json vise le bureau du MacBook par
// le `ssh` de carton.
function veilleDuStudio(t, m, { intervalle_ms = 60_000 } = {}) {
  const ssh = sshDeCarton(t);
  fs.writeFileSync(path.join(m.b.root, "relais.json"), JSON.stringify({
    moi: STUDIO,
    macs: { [MACBOOK]: { ssh: "autre-mac", node: process.execPath, depot: DEPOT, bureau: m.a.root } },
    intervalle_ms
  }));
  const env = envPropre({ CC2CC_GARDE_BUREAU: "1", CC2CC_V2_HOME: m.b.root, PATH: `${ssh.dossier}${path.delimiter}${process.env.PATH}` });
  return { ssh, env };
}

function lancerLaVeille(t, env) {
  const veille = spawn(process.execPath, [BIN, "tournee"], { cwd: DEPOT, env, stdio: ["ignore", "pipe", "pipe"] });
  const lignes = [];
  let reste = "";
  veille.stderr.on("data", (morceau) => {
    const texte = reste + morceau;
    const coupees = texte.split("\n");
    reste = coupees.pop();
    for (const ligne of coupees) {
      try { lignes.push(JSON.parse(ligne)); } catch { lignes.push({ brut: ligne }); }
    }
  });
  veille.stdout.resume();
  const sortie = new Promise((resolve) => veille.on("exit", (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    if (veille.exitCode === null && veille.signalCode === null) {
      process.kill(veille.pid, "SIGKILL");
      await sortie;
    }
  });
  return { veille, lignes, sortie };
}

test("R37 : la vraie veille, arrêtée par SIGTERM, rend la confirmation due avant de sortir, et rend le verrou", async (t) => {
  const m = await laLigneeSurLesDeuxMacs(t);
  const { env } = veilleDuStudio(t, m);
  insertMessage(m.a.db, { msg_id: "L-r34-veille", sender: "bob", recipient: "lignee-r34", body: "portée par la vraie veille" });

  const { veille, lignes, sortie } = lancerLaVeille(t, env);
  assert.ok(await attendre(() => getMessageById(m.b.db, "L-r34-veille") !== null, { ms: 30_000 }),
    `la veille porte la lettre à son premier tour (${JSON.stringify(lignes)})`);
  assert.ok(await attendre(() => lignes.some((l) => l.evenement === "relais_tournee"), { ms: 30_000 }), "SONDE : le premier tour est fini");
  // La veille dort 60 s : la confirmation n'est pas rendue, et le Mac visité le voit.
  assert.equal(getMessageById(m.a.db, "L-r34-veille").porte_at, null, "SONDE : la confirmation est due");
  assert.deepEqual(etatDe(m.a.root).offertes, { [STUDIO]: 1 }, "etat du Mac visité voit la lettre offerte et pas confirmée");

  process.kill(veille.pid, "SIGTERM");
  assert.deepEqual(await sortie, { code: 0, signal: null }, JSON.stringify(lignes));
  assert.ok(getMessageById(m.a.db, "L-r34-veille").porte_at, "la veille a rendu la confirmation avant de sortir");
  assert.deepEqual(etatDe(m.a.root).offertes, { [STUDIO]: 0 });
  assert.equal(fs.existsSync(path.join(m.b.root, "run", "relais.verrou")), false, "le verrou est rendu");
  const evenements = lignes.map((l) => l.evenement);
  assert.ok(evenements.indexOf("relais_rappele") < evenements.indexOf("relais_dernier_echange"), evenements.join(" "));
  assert.ok(evenements.indexOf("relais_dernier_echange") < evenements.indexOf("relais_hors_service"), evenements.join(" "));
  const dernier = lignes.find((l) => l.evenement === "relais_dernier_echange");
  assert.equal(dernier.mac, MACBOOK);
  assert.equal(dernier.erreur, null, dernier.detail);
  assert.equal(dernier.confirmees, 1);
});

test("R37 : la vraie veille dont le dernier échange échoue sort quand même, le dit au journal, et ne marque rien", async (t) => {
  const m = await laLigneeSurLesDeuxMacs(t);
  const { ssh, env } = veilleDuStudio(t, m);
  insertMessage(m.a.db, { msg_id: "L-r34-panne", sender: "bob", recipient: "lignee-r34", body: "portée, puis le Mac s'endort" });

  const { veille, lignes, sortie } = lancerLaVeille(t, env);
  assert.ok(await attendre(() => lignes.some((l) => l.evenement === "relais_tournee"), { ms: 30_000 }), JSON.stringify(lignes));
  assert.ok(getMessageById(m.b.db, "L-r34-panne"), "SONDE : la lettre est portée");
  fs.writeFileSync(ssh.panne, "");

  process.kill(veille.pid, "SIGTERM");
  assert.deepEqual(await sortie, { code: 0, signal: null }, JSON.stringify(lignes));
  const dernier = lignes.find((l) => l.evenement === "relais_dernier_echange");
  assert.ok(dernier, JSON.stringify(lignes));
  assert.equal(dernier.erreur, "mac-injoignable");
  assert.match(dernier.detail, /Host is down/);
  assert.equal(getMessageById(m.a.db, "L-r34-panne").porte_at, null, "rien n'est marqué");
  assert.deepEqual(etatDe(m.a.root).offertes, { [STUDIO]: 1 }, "etat du Mac visité le montre : la lettre est en vol");
  assert.equal(fs.existsSync(path.join(m.b.root, "run", "relais.verrou")), false, "le verrou est rendu");
  assert.ok(lignes.some((l) => l.evenement === "relais_hors_service"));
});

test("R37 : tournee --une fait le même dernier échange à sa fin", async (t) => {
  const m = await laLigneeSurLesDeuxMacs(t);
  const { env } = veilleDuStudio(t, m);
  insertMessage(m.a.db, { msg_id: "L-une", sender: "bob", recipient: "lignee-r34", body: "une seule tournée" });
  const une = spawnSync(process.execPath, [BIN, "tournee", "--une"], { cwd: DEPOT, env, encoding: "utf8", timeout: 60_000 });
  assert.equal(une.status, 0, une.stderr);
  const sortie = JSON.parse(une.stdout);
  assert.equal(sortie.rapports.length, 1);
  assert.equal(sortie.rapports[0].apportees, 1);
  assert.equal(sortie.derniers_echanges.length, 1);
  assert.equal(sortie.derniers_echanges[0].erreur, null, sortie.derniers_echanges[0].detail);
  assert.equal(sortie.derniers_echanges[0].confirmees, 1);
  assert.equal(compter(m.b.db, "L-une"), 1);
  assert.ok(getMessageById(m.a.db, "L-une").porte_at, "--une ne laisse plus la confirmation due");
  assert.deepEqual(etatDe(m.a.root).offertes, { [STUDIO]: 0 });

  // Rien de dû : une seule tournée, aucun dernier échange.
  const vide = spawnSync(process.execPath, [BIN, "tournee", "--une"], { cwd: DEPOT, env, encoding: "utf8", timeout: 60_000 });
  assert.equal(vide.status, 0, vide.stderr);
  assert.deepEqual(JSON.parse(vide.stdout).derniers_echanges, []);
});

test("la ligne de commande de la tournée refuse ce qu'elle ne lit pas", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rt-ligne-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "relais.json"), JSON.stringify({ moi: STUDIO, macs: {} }));
  const env = envPropre({ CC2CC_GARDE_BUREAU: "1", CC2CC_V2_HOME: root });
  for (const args of [["tournee", "--de", MACBOOK], ["etat", "--une"], ["echanger", "--de", MACBOOK, "--une"]]) {
    const r = spawnSync(process.execPath, [BIN, ...args], { cwd: DEPOT, env, encoding: "utf8", input: "", timeout: 20_000 });
    assert.equal(r.status, 2, `${args.join(" ")} : ${r.stderr}`);
  }
  assert.equal(fs.existsSync(path.join(root, "run", "relais.verrou")), false);
});

// ── LE RAPPORT ──────────────────────────────────────────────────────────────

test("le rapport de tournée est écrit", async (t) => {
  const m = await deuxChaises(t);
  const statut = lireLeStatut(m.b.root);
  assert.equal(statut.mac, MACBOOK);
  assert.equal(statut.erreur, null);
  assert.match(statut.at, /^\d{4}-\d\d-\d\dT/);
  for (const champ of ["apportees", "emportees", "conflits", "evenements_apportes", "evenements_emportes", "duree_ms"]) {
    assert.equal(typeof statut[champ], "number", champ);
  }
  // `etat` le lit.
  const etat = spawnSync(process.execPath, [BIN, "etat"], {
    cwd: DEPOT, encoding: "utf8", env: envPropre({ CC2CC_GARDE_BUREAU: "1", CC2CC_V2_HOME: m.b.root })
  });
  assert.equal(etat.status, 0, etat.stderr);
  assert.deepEqual(JSON.parse(etat.stdout).derniere_tournee, statut);
});
