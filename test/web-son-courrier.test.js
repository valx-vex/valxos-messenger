// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// GARDE N°2 — LA PORTE NE LIT QUE SON COURRIER.
//
// Une porte ouverte sur le bureau de poste voit TOUTE la table `messages` si
// personne ne l'en empêche : le corps des lettres de Bob à Alice y est,
// entier, à une requête près. La garde est donc posée là où la donnée SORT —
// les trois surfaces qui rendent du courrier : `/api/fil`, le flux SSE, et
// `/api/accuser` (qui, lui, ne rend rien mais TERMINE une lettre, ce qui est
// pire).
//
// Le décor pose du courrier entre deux TIERS, dans les DEUX sens : un filtre
// écrit sur le seul destinataire laisserait passer la moitié du fil.
//
// ⚠️ Plancher jetable (CC2CC_V2_HOME) posé AVANT le premier test — voir
// aide-porte.js (remède de la revue adverse F2).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BUREAU_INITIAL = process.env.CC2CC_V2_HOME;
poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-porte-courrier-plancher-")));
after(() => {
  if (BUREAU_INITIAL === undefined) delete process.env.CC2CC_V2_HOME;
  else process.env.CC2CC_V2_HOME = BUREAU_INITIAL;
});

import { getMessageById, insertMessage } from "../src/lib/database.js";
import { registerInstance } from "../src/lib/registry.js";
import { MOI, attendre, bureauJetable, cookieDePremiereVisite, fluxSSE, porteDeTest, requete } from "./aide-porte.js";
import { poserLeBureau } from "./aide-env.js";

// Le corps des lettres des autres : une chaîne qu'on peut CHERCHER dans la
// réponse brute. Comparer des listes d'objets laisserait passer une fuite par
// un champ auquel personne n'a pensé.
const SECRET_A = "SECRET-BOB-VERS-ALICE";
const SECRET_B = "SECRET-ALICE-VERS-BOB";

function decor(db) {
  registerInstance(db, { lineage: "bob-eternal", sessionId: "s-bob", house: "/maison/claude", pid: 4242 });
  registerInstance(db, { lineage: "claude-alice", sessionId: "s-alice", house: "/maison/work", pid: 4243 });
  const desAutres = [
    insertMessage(db, {
      msg_id: "m-tiers-aller",
      sender: "bob-eternal",
      recipient: "claude-alice",
      subject: "entre eux",
      body: SECRET_A
    }),
    insertMessage(db, {
      msg_id: "m-tiers-retour",
      sender: "claude-alice",
      recipient: "bob-eternal",
      subject: "entre eux, dans l'autre sens",
      body: SECRET_B
    })
  ];
  // Les contrôles POSITIFS : sans eux, « absent » ne prouverait rien — une
  // porte qui ne rend jamais rien passerait la garde n°2 haut la main.
  const miennes = [
    insertMessage(db, {
      msg_id: "m-pour-moi",
      sender: "bob-eternal",
      recipient: MOI,
      subject: "la nuit s'est bien passée",
      body: "POUR-OPERATEUR"
    }),
    insertMessage(db, {
      msg_id: "m-de-moi",
      sender: MOI,
      recipient: "bob-eternal",
      subject: "bonjour",
      body: "DE-OPERATEUR"
    })
  ];
  return { desAutres, miennes };
}

test("/api/fil ne rend QUE le courrier de l'opérateur — pas un octet de celui des autres", async (t) => {
  const db = bureauJetable(t);
  decor(db);
  const { base } = await porteDeTest(t, { db });
  const { cookie } = await cookieDePremiereVisite(base);

  const fil = await requete(base, "/api/fil", { cookie });
  assert.equal(fil.statut, 200);

  // Contrôle positif D'ABORD : le fil vit.
  const ids = fil.json.lettres.map((lettre) => lettre.msg_id);
  assert.deepEqual(ids.sort(), ["m-de-moi", "m-pour-moi"], "les deux lettres de l'opérateur, et elles seules");
  assert.equal(fil.json.moi, MOI);

  // Puis l'absence, sur la réponse BRUTE : ni l'identifiant, ni l'objet, ni le
  // corps, ni le nom des tiers en position d'interlocuteur.
  for (const trace of [SECRET_A, SECRET_B, "m-tiers-aller", "m-tiers-retour", "entre eux"]) {
    assert.ok(!fil.texte.includes(trace), `le fil laisse fuir « ${trace} » — c'est le courrier des autres`);
  }
});

test("le flux SSE ne porte QUE le courrier de l'opérateur — une lettre entre tiers n'y apparaît jamais", async (t) => {
  const db = bureauJetable(t);
  decor(db);
  const { base } = await porteDeTest(t, { db, periodeMs: 20 });
  const { cookie } = await cookieDePremiereVisite(base);

  const flux = fluxSSE(base, { cookie });
  await flux.pret;
  await flux.attendre((evenement) => evenement.type === "pairs");

  // Une lettre entre tiers ET une lettre pour l'opérateur, posées APRÈS la
  // connexion : l'ordre importe, c'est sa lettre qui prouve que le
  // flux a bien tourné pendant que celle des tiers passait.
  insertMessage(db, {
    msg_id: "m-tiers-pendant",
    sender: "bob-eternal",
    recipient: "claude-alice",
    subject: "pendant le flux",
    body: "SECRET-PENDANT-LE-FLUX"
  });
  insertMessage(db, {
    msg_id: "m-pour-moi-pendant",
    sender: "bob-eternal",
    recipient: MOI,
    subject: "pour toi",
    body: "POUR-OPERATEUR-PENDANT"
  });

  await flux.attendre(
    (evenement) => evenement.type === "lettre" && evenement.donnees.msg_id === "m-pour-moi-pendant"
  );
  // Deux tours de scrutation de plus : si la lettre des tiers devait sortir,
  // elle est sortie.
  await attendre(80);
  flux.fermer();

  const tout = flux.evenements.map((evenement) => evenement.brut).join("\n");
  for (const trace of ["SECRET-PENDANT-LE-FLUX", "m-tiers-pendant", "SECRET-BOB", "m-tiers-aller"]) {
    assert.ok(!tout.includes(trace), `le flux laisse fuir « ${trace} » — c'est le courrier des autres`);
  }
  assert.ok(tout.includes("m-pour-moi-pendant"), "contrôle positif : le flux portait bien du courrier");
});

test("/api/accuser refuse une lettre qui n'est pas la sienne — et ne l'ouvre même pas", async (t) => {
  const db = bureauJetable(t);
  const { desAutres } = decor(db);
  const { base } = await porteDeTest(t, { db });
  const { cookie } = await cookieDePremiereVisite(base);

  for (const lettre of desAutres) {
    const refus = await requete(base, "/api/accuser", { methode: "POST", cookie, corps: { msg_id: lettre.msg_id } });
    assert.equal(refus.statut, 403, "un accusé sur le courrier d'un autre se refuse, il ne se rate pas");
    assert.equal(refus.json.acke, false);
    // LE MOTIF EST LA PREUVE QUE C'EST *CETTE* GARDE QUI A MORDU. Sans le
    // filtre de la porte, `ackMessage` refuserait aussi — mais avec SON motif
    // à lui (« accuse-refuse-lettre »), depuis la base, après avoir ouvert la
    // lettre. Le mutant est vert si on n'exige que « refusé ».
    assert.equal(refus.json.refus, "pas-mon-courrier");
    assert.equal(getMessageById(db, lettre.msg_id).acked_at, null, "A9 : la lettre reste intacte");
    // Et la porte n'a même pas touché la lettre : aucun reçu à son nom.
    const traces = db.prepare("SELECT * FROM delivery_events WHERE msg_id = ?").all(lettre.msg_id);
    assert.deepEqual(
      traces.map((trace) => trace.event_type),
      ["created"],
      "la porte n'a pas ouvert la lettre d'un autre : rien d'autre que sa création au journal"
    );
  }

  // Contrôle positif : le geste MARCHE sur son propre courrier. Une `task`,
  // parce que c'est la branche qui exige justement le geste de l'humain.
  insertMessage(db, {
    msg_id: "m-tache-pour-moi",
    sender: "bob-eternal",
    recipient: MOI,
    subject: "à faire",
    body: "une tâche",
    msg_type: "task"
  });
  const acke = await requete(base, "/api/accuser", { methode: "POST", cookie, corps: { msg_id: "m-tache-pour-moi" } });
  assert.equal(acke.statut, 200, acke.texte);
  assert.equal(acke.json.acke, true);
  assert.ok(getMessageById(db, "m-tache-pour-moi").acked_at, "la lettre de l'opérateur, elle, est bien signée");
});
