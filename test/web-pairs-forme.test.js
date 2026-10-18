// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// GARDE N°2 SUR LES BOÎTES — `/api/pairs` et la FORME de ce qu'il rend.
//
// Deux défauts, un seul fichier, parce qu'ils se tiennent :
//
// ① L'EN-SOUFFRANCE PUBLIAIT LE COURRIER DES TIERS. Sonde adverse du 22/08 :
//    un décor où l'opérateur n'a STRICTEMENT AUCUN courrier. `/api/fil` rend zéro
//    lettre — et `/api/pairs` rendait pour `bob-eternal`
//    `{"lettres":3,"depuis_h":30,"tentatives":1,"motif":"boite-endormie"}` :
//    le volume, l'âge et la raison d'échec d'une correspondance entre deux
//    tiers. La loi de la maison ne dit pas « on ne lit pas le CORPS des
//    autres », elle dit « le courrier des autres ne se lit pas ». Un compte et
//    une échéance sont du courrier.
//
// ② LA FORME N'ÉTAIT BORNÉE PAR AUCUN TEST. On pouvait ajouter l'objet d'une
//    lettre d'autrui à la réponse sans faire rougir un verrou. Une garde de
//    surface se pose sur la CLASSE de ce qui sort — donc sur la liste FERMÉE
//    des clefs, pas sur les trois champs auxquels on a pensé.
//
// ⚠️ Plancher jetable (CC2CC_V2_HOME) posé AVANT le premier test — voir
// aide-porte.js (remède de la revue adverse F2).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BUREAU_INITIAL = process.env.CC2CC_V2_HOME;
poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-porte-pairs-plancher-")));
after(() => {
  if (BUREAU_INITIAL === undefined) delete process.env.CC2CC_V2_HOME;
  else process.env.CC2CC_V2_HOME = BUREAU_INITIAL;
});

import { insertMessage } from "../src/lib/database.js";
import { registerInstance } from "../src/lib/registry.js";
import { MOI, bureauJetable, cookieDePremiereVisite, fluxSSE, porteDeTest, requete } from "./aide-porte.js";
import { poserLeBureau } from "./aide-env.js";

// Les seuils du produit : au-delà de quatre heures sans accusé, une lettre crie.
const VIEUX = () => new Date(Date.now() - 30 * 3_600_000).toISOString();

// Le décor de la sonde : l'opérateur n'a RIEN. Trois lettres entre deux tiers,
// toutes en souffrance depuis trente heures.
function decorSansMoi(db) {
  registerInstance(db, { lineage: "bob-eternal", sessionId: "s-bob", house: "/maison/claude", pid: 4242 });
  registerInstance(db, { lineage: "claude-alice", sessionId: "s-alice", house: "/maison/work", pid: 4243 });
  for (const n of [1, 2, 3]) {
    insertMessage(db, {
      msg_id: `m-tiers-${n}`,
      sender: "claude-alice",
      recipient: "bob-eternal",
      subject: "entre eux",
      body: `SECRET-TIERS-${n}`,
      created_at: VIEUX()
    });
  }
}

test("/api/pairs : l'en-souffrance d'une correspondance entre TIERS ne sort pas — l'opérateur n'a aucun courrier, la porte le dit", async (t) => {
  const db = bureauJetable(t);
  decorSansMoi(db);
  const { base } = await porteDeTest(t, { db });
  const { cookie } = await cookieDePremiereVisite(base);

  // Le contrôle qui donne son sens au reste : l'opérateur n'a RIEN.
  const fil = await requete(base, "/api/fil", { cookie });
  assert.equal(fil.json.lettres.length, 0, "le décor doit bien être « aucun courrier de l'opérateur »");

  const pairs = await requete(base, "/api/pairs", { cookie });
  assert.equal(pairs.statut, 200);
  const bob = pairs.json.pairs.find((boite) => boite.nom === "bob-eternal");
  assert.ok(bob, "la BOÎTE reste visible — la garde porte sur le courrier, pas sur le registre");
  assert.equal(
    bob.en_souffrance,
    null,
    `la porte publie l'en-souffrance d'une correspondance entre tiers : ${JSON.stringify(bob.en_souffrance)}`
  );

  // Et rien nulle part dans la réponse brute : ni un compte, ni un motif, ni
  // un identifiant de lettre.
  for (const trace of ["m-tiers-", "SECRET-TIERS", "en_souffrance\":{"]) {
    assert.ok(!pairs.texte.includes(trace), `/api/pairs laisse fuir « ${trace} »`);
  }
});

test("le flux SSE porte la MÊME vue des boîtes — une garde posée sur une seule des deux surfaces n'en est pas une", async (t) => {
  const db = bureauJetable(t);
  decorSansMoi(db);
  const { base } = await porteDeTest(t, { db, periodeMs: 20 });
  const { cookie } = await cookieDePremiereVisite(base);

  const flux = fluxSSE(base, { cookie });
  await flux.pret;
  const premier = await flux.attendre((evenement) => evenement.type === "pairs");
  flux.fermer();

  const bob = premier.donnees.pairs.find((boite) => boite.nom === "bob-eternal");
  assert.equal(bob.en_souffrance, null, "le premier événement du flux est un `pairs` COMPLET : il porte la même garde");
  assert.ok(!premier.brut.includes("m-tiers-"), "et pas un identifiant de lettre d'autrui");
});

test("/api/pairs : SON courrier à elle crie toujours — la garde n'est pas un mur", async (t) => {
  const db = bureauJetable(t);
  decorSansMoi(db);
  // Une lettre de l'opérateur vers `bob-eternal`, vieille elle aussi.
  insertMessage(db, {
    msg_id: "m-de-moi-vieille",
    sender: MOI,
    recipient: "bob-eternal",
    body: "personne ne l'a signée",
    created_at: VIEUX()
  });

  const { base } = await porteDeTest(t, { db });
  const { cookie } = await cookieDePremiereVisite(base);
  const pairs = await requete(base, "/api/pairs", { cookie });
  const bob = pairs.json.pairs.find((boite) => boite.nom === "bob-eternal");

  assert.ok(bob.en_souffrance, "sa lettre à lui crie — sinon on aurait remplacé une fuite par une cécité");
  assert.equal(
    bob.en_souffrance.lettres,
    1,
    `le compte ne doit porter QUE sa lettre, pas les trois des tiers : ${JSON.stringify(bob.en_souffrance)}`
  );
  assert.ok(bob.en_souffrance.depuis_h >= 4);
});

// ── ② LA FORME, EN LISTE FERMÉE ─────────────────────────────────────────────
// Les deux sens : une clef de trop est une fuite en puissance, une clef qui
// manque est un produit qui ment sur ce qu'il livre. Le contrat (22/08, « les
// boîtes : nom, vivant/hors service, désignée, en-souffrance par fiche ») est
// la référence — le tableau ci-dessous ne se dérive de rien.
const CLEFS_DE_LA_REPONSE = ["pairs"];
const CLEFS_D_UNE_BOITE = ["nom", "chaises", "en_service", "libelle", "designee", "en_souffrance"];
const CLEFS_D_UNE_SOUFFRANCE = ["lettres", "depuis_h", "tentatives", "motif"];

test("/api/pairs : la FORME est une liste FERMÉE — on n'ajoute pas un champ à cette réponse sans le dire ici", async (t) => {
  const db = bureauJetable(t);
  decorSansMoi(db);
  insertMessage(db, {
    msg_id: "m-de-moi-pour-la-forme",
    sender: MOI,
    recipient: "bob-eternal",
    body: "de quoi faire crier une boîte",
    created_at: VIEUX()
  });

  const { base } = await porteDeTest(t, { db });
  const { cookie } = await cookieDePremiereVisite(base);
  const pairs = await requete(base, "/api/pairs", { cookie });

  assert.deepEqual(Object.keys(pairs.json).sort(), [...CLEFS_DE_LA_REPONSE].sort());
  assert.ok(pairs.json.pairs.length >= 2, "SONDE IMPOSSIBLE : sans boîte, la forme d'une boîte ne se mesure pas");

  let criees = 0;
  for (const boite of pairs.json.pairs) {
    assert.deepEqual(
      Object.keys(boite).sort(),
      [...CLEFS_D_UNE_BOITE].sort(),
      `la boîte ${boite.nom} n'a pas la forme du contrat`
    );
    if (boite.en_souffrance === null) continue;
    criees += 1;
    assert.deepEqual(
      Object.keys(boite.en_souffrance).sort(),
      [...CLEFS_D_UNE_SOUFFRANCE].sort(),
      `l'en-souffrance de ${boite.nom} n'a pas la forme du contrat`
    );
  }
  // Sans une boîte qui crie, la forme de l'en-souffrance n'aurait été mesurée
  // sur rien du tout.
  assert.equal(criees, 1, "SONDE IMPOSSIBLE : aucune en-souffrance dans la réponse, sa forme n'a pas été vue");
});
