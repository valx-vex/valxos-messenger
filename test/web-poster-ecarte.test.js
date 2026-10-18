// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// CE QUE LE REJEU A ÉCARTÉ — ET RIEN D'AUTRE.
//
// Le remède ⑧ rend au posteur ce qu'il vient de taper et qui n'est parti nulle
// part. Il comparait TOUS les champs, y compris ceux que l'appelant n'a jamais
// fournis : un posteur qui omet le sujet s'entendait dire qu'on lui avait
// « écarté » un sujet qu'il n'a pas écrit — avec pour valeur `null`, ce qui ne
// veut rien dire du tout. Un signal qui crie sur ce que personne n'a tapé est
// un signal qu'on cesse de lire, et c'est exactement ce que ⑧ existait pour
// éviter.
//
// LA PORTE WEB EST LA PREMIÈRE CONCERNÉE, et c'est pour ça que ce test vit sous
// ce préfixe : `servirPoster` écrit `subject: … ?? null` et `sender_model: null`
// à CHAQUE dépôt (l'opérateur est un humain, aucun modèle à estampiller). Deux
// champs nuls, toujours présents, donc deux faux écartés sur chaque rejeu de la
// page. Le défaut vit dans `inscrireUneLettre` (database.js) — il se répare là,
// une fois, pour les trois surfaces.
//
// ⚠️ Plancher jetable (CC2CC_V2_HOME) posé AVANT le premier test — voir
// aide-porte.js (remède de la revue adverse F2).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BUREAU_INITIAL = process.env.CC2CC_V2_HOME;
poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-porte-ecarte-plancher-")));
after(() => {
  if (BUREAU_INITIAL === undefined) delete process.env.CC2CC_V2_HOME;
  else process.env.CC2CC_V2_HOME = BUREAU_INITIAL;
});

import { inscrireUneLettre } from "../src/lib/database.js";
import { registerInstance } from "../src/lib/registry.js";
import { deposerPourLOperateur } from "../src/web/serveur.js";
import { MOI, bureauJetable } from "./aide-porte.js";
import { poserLeBureau } from "./aide-env.js";

// EXACTEMENT ce que `servirPoster` passe au guichet — recopié depuis la source,
// champs nuls compris : c'est ce qui rend le faux écarté inévitable.
function commeLaPorte({ a, corps, objet = null }) {
  return {
    sender: MOI,
    recipient: a,
    subject: objet,
    body: corps,
    thread_id: null,
    priority: undefined,
    msg_type: undefined,
    sender_model: null
  };
}

test("LA PORTE NE S'ENTEND PAS ÉCARTER CE QU'ELLE N'A PAS ÉCRIT — sujet et modèle nuls", async (t) => {
  const db = bureauJetable(t);
  registerInstance(db, { lineage: "bob-eternal", sessionId: "s-bob", house: "/maison/claude", pid: 4242 });

  // Une lettre déjà déposée, AVEC un sujet et un modèle — par une autre surface
  // (le CLI d'une session, qui les connaît tous les deux).
  inscrireUneLettre(db, {
    msg_id: "m-idem",
    sender: MOI,
    recipient: "bob-eternal",
    subject: "posé par le CLI",
    body: "le premier corps",
    sender_model: "claude-opus"
  });

  // La page rejoue sa clef d'idempotence, sans sujet — comme elle le fait à
  // chaque reprise d'un pli en attente.
  const rejeu = await deposerPourLOperateur(
    db,
    MOI,
    commeLaPorte({ a: "bob-eternal", corps: "le premier corps" }),
    "m-idem"
  );

  assert.equal(rejeu.row.msg_id, "m-idem", "SONDE IMPOSSIBLE : ce n'est pas la ligne existante qui a été rendue");
  assert.equal(rejeu.rejeu?.motif, "msg_id-deja-connu", "SONDE IMPOSSIBLE : le rejeu n'a même pas été reconnu");
  assert.equal(
    rejeu.ecarte,
    null,
    `la porte n'a écrit ni sujet ni modèle : on ne lui écarte rien. Reçu : ${JSON.stringify(rejeu.ecarte)}`
  );
});

test("MAIS CE QUI A VRAIMENT ÉTÉ TAPÉ REVIENT — sinon le remède ⑧ serait mort en silence", async (t) => {
  const db = bureauJetable(t);
  registerInstance(db, { lineage: "bob-eternal", sessionId: "s-bob", house: "/maison/claude", pid: 4242 });

  inscrireUneLettre(db, {
    msg_id: "m-perdu",
    sender: MOI,
    recipient: "bob-eternal",
    subject: "le premier sujet",
    body: "le premier corps"
  });

  const rejeu = await deposerPourLOperateur(
    db,
    MOI,
    commeLaPorte({ a: "bob-eternal", corps: "LE SECOND CORPS, perdu", objet: "LE SECOND SUJET, perdu" }),
    "m-perdu"
  );

  assert.deepEqual(
    rejeu.ecarte,
    { subject: "LE SECOND SUJET, perdu", body: "LE SECOND CORPS, perdu" },
    "ce que le posteur a TAPÉ et qui n'est parti nulle part doit lui revenir, entier"
  );
});

test("LA RÈGLE, CHAMP PAR CHAMP : fourni ⇒ comparé, absent ⇒ jamais nommé", (t) => {
  const db = bureauJetable(t);

  inscrireUneLettre(db, {
    msg_id: "m-regle",
    sender: "expediteur",
    recipient: "alpha",
    thread_id: "fil-1",
    subject: "un sujet",
    body: "un corps",
    priority: "high",
    msg_type: "broadcast",
    sender_model: "un-modele"
  });

  // ① L'APPELANT MINIMAL. Il ne tape que ce qu'il faut pour poster, et tout
  //    diverge en base : seuls SES champs peuvent lui être rendus.
  const minimal = inscrireUneLettre(db, {
    msg_id: "m-regle",
    sender: "expediteur",
    recipient: "alpha",
    body: "un AUTRE corps"
  });
  assert.deepEqual(
    Object.keys(minimal.ecarte),
    ["body"],
    `seul le corps a été tapé — reçu : ${JSON.stringify(minimal.ecarte)}`
  );

  // ② LES DÉFAUTS NORMALISÉS NE SONT PAS DES SAISIES. Sans priorité ni type,
  //    `msg` porte quand même « normal » et « message » : les comparer, c'est
  //    annoncer deux pertes à qui n'a rien écrit.
  assert.equal(minimal.ecarte.priority, undefined, "une priorité par défaut n'est pas une priorité tapée");
  assert.equal(minimal.ecarte.msg_type, undefined, "un type par défaut n'est pas un type tapé");

  // ③ LES DEUX ORTHOGRAPHES COMPTENT. `to`/`from`/`text`/`type` sont des
  //    saisies au même titre que leurs jumelles — la question est « a-t-il
  //    tapé ? », pas « comment l'a-t-il épelé ? ».
  const autreOrthographe = inscrireUneLettre(db, {
    msg_id: "m-regle",
    from: "expediteur",
    to: "alpha",
    text: "encore un autre corps",
    type: "status"
  });
  assert.deepEqual(
    autreOrthographe.ecarte,
    { body: "encore un autre corps", msg_type: "status" },
    `l'orthographe ne change pas ce qui a été tapé — reçu : ${JSON.stringify(autreOrthographe.ecarte)}`
  );

  // ④ ET UN NUL EXPLICITE NE COMPTE PAS POUR UNE SAISIE : c'est ce qu'écrit une
  //    surface qui n'a rien à dire de ce champ-là (la porte web, à chaque pli).
  const avecDesNuls = inscrireUneLettre(db, {
    msg_id: "m-regle",
    sender: "expediteur",
    recipient: "alpha",
    body: "un corps encore",
    subject: null,
    thread_id: null,
    sender_model: null
  });
  assert.deepEqual(
    Object.keys(avecDesNuls.ecarte),
    ["body"],
    `un nul explicite n'est pas une saisie — reçu : ${JSON.stringify(avecDesNuls.ecarte)}`
  );
});
