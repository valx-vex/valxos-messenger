// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// GARDE N°2 — LA QUATRIÈME SURFACE : `/api/poster`.
//
// Les trois surfaces déjà gardées (`/api/fil`, le flux, `/api/accuser`) LISENT
// du courrier. `/api/poster` en ÉCRIT — et c'est justement ce qui l'avait fait
// oublier. Or son `msg_id` est ENTIÈREMENT choisi par le client (le contrat le
// veut : le front en génère un par lettre, pour l'idempotence), et
// `posterUneLettre` rend LA LIGNE EXISTANTE quand la clef est déjà prise
// (remède R2). Une clef qui désigne le courrier de deux TIERS rendait donc,
// avant ce fichier :
//   • `destinataire: "claude-alice"` — le destinataire d'une lettre entre deux
//     autres, servi à quelqu'un qui n'y a aucun droit ;
//   • un coup de sonnette chez `claude-alice` POUR CETTE LETTRE-LÀ ;
//   • et la lettre que l'opérateur venait de taper : nulle part. Perdue en
//     silence, ce qu'A8 interdit — on préfère un doublon à une lettre perdue.
//
// Les trois se prouvent ici, séparément : une fuite réparée qui laisserait la
// lettre au fossé ne serait pas une réparation.
//
// ⚠️ Plancher jetable (CC2CC_V2_HOME) posé AVANT le premier test — voir
// aide-porte.js (remède de la revue adverse F2).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const BUREAU_INITIAL = process.env.CC2CC_V2_HOME;
poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-porte-poster-plancher-")));
after(() => {
  if (BUREAU_INITIAL === undefined) delete process.env.CC2CC_V2_HOME;
  else process.env.CC2CC_V2_HOME = BUREAU_INITIAL;
});

import { getMessageById, insertMessage } from "../src/lib/database.js";
import { registerInstance } from "../src/lib/registry.js";
import { deposerPourLOperateur } from "../src/web/serveur.js";
import { MOI, bureauJetable, cookieDePremiereVisite, porteDeTest, requete } from "./aide-porte.js";
import { poserLeBureau } from "./aide-env.js";

const SECRET_A = "SECRET-BOB-VERS-ALICE";

// Le décor de la sonde adverse, mot pour mot : une lettre entre deux tiers,
// déjà au bureau, sous une clef que le client va réclamer.
function decorDesTiers(db) {
  registerInstance(db, { lineage: "bob-eternal", sessionId: "s-bob", house: "/maison/claude", pid: 4242 });
  registerInstance(db, { lineage: "claude-alice", sessionId: "s-alice", house: "/maison/work", pid: 4243 });
  return insertMessage(db, {
    msg_id: "m-tiers-aller",
    sender: "bob-eternal",
    recipient: "claude-alice",
    subject: "entre eux",
    body: SECRET_A
  });
}

function evenementsDe(db, msgId) {
  return db
    .prepare("SELECT event_type FROM delivery_events WHERE msg_id = ? ORDER BY rowid")
    .all(msgId)
    .map((ligne) => ligne.event_type);
}

test("POSTER : une clef qui désigne le courrier des tiers ne rend PAS UN MOT de cette ligne", async (t) => {
  const db = bureauJetable(t);
  decorDesTiers(db);
  const { base } = await porteDeTest(t, { db });
  const { cookie } = await cookieDePremiereVisite(base);

  const reponse = await requete(base, "/api/poster", {
    methode: "POST",
    cookie,
    corps: { a: "bob-eternal", corps: "MA-LETTRE-A-MOI", msg_id: "m-tiers-aller" }
  });

  // La réponse BRUTE, pas les champs qu'on aurait pensé à regarder : une fuite
  // se cache toujours dans le champ auquel personne n'a pensé.
  for (const trace of [SECRET_A, "claude-alice", "entre eux"]) {
    assert.ok(
      !reponse.texte.includes(trace),
      `la porte laisse fuir « ${trace} » sur /api/poster — c'est le courrier des autres (${reponse.texte})`
    );
  }
  // Et le `destinataire` annoncé est celui que l'opérateur a écrit, pas celui
  // d'une ligne trouvée sous sa clef.
  assert.equal(reponse.json.destinataire, "bob-eternal");
});

test("POSTER : la lettre des tiers reste INTACTE — la porte ne sonne pas chez autrui sur ordre d'un client", async (t) => {
  const db = bureauJetable(t);
  const tiers = decorDesTiers(db);
  const { base } = await porteDeTest(t, { db });
  const { cookie } = await cookieDePremiereVisite(base);

  assert.deepEqual(evenementsDe(db, "m-tiers-aller"), ["created"], "le décor part d'une lettre que personne n'a touchée");

  const reponse = await requete(base, "/api/poster", {
    methode: "POST",
    cookie,
    corps: { a: "bob-eternal", corps: "MA-LETTRE-A-MOI", msg_id: "m-tiers-aller" }
  });

  // LA SONNETTE EST L'EFFET LE PLUS VISIBLE, ET LE SEUL QUI SORTE DE LA BASE :
  // `posterUneLettre` réveille le destinataire DE LA LIGNE (R2), donc avant le
  // remède la porte frappait à la porte de `claude-alice` pour une lettre entre
  // tiers, sur ordre d'un client. Le chemin de socket rendu le prouve.
  assert.ok(
    !JSON.stringify(reponse.json?.reveil ?? null).includes("claude-alice"),
    `la porte a SONNÉ chez un tiers pour la lettre d'un tiers : ${JSON.stringify(reponse.json?.reveil)}`
  );

  const apres = getMessageById(db, "m-tiers-aller");
  assert.equal(apres.body, tiers.body, "Camp B : la lettre des tiers n'a pas bougé d'un octet");
  assert.equal(apres.injected_at, null, "la porte n'a pas fait pousser la lettre des tiers chez son destinataire");
  assert.equal(apres.delivered_at, null);
  assert.deepEqual(
    evenementsDe(db, "m-tiers-aller"),
    ["created"],
    "aucun reçu de plus au journal : la porte n'a pas travaillé sur le courrier d'un autre"
  );
});

test("POSTER : la lettre de l'opérateur ne se perd JAMAIS en silence — A8 préfère un doublon à une lettre perdue", async (t) => {
  const db = bureauJetable(t);
  decorDesTiers(db);
  const { base } = await porteDeTest(t, { db });
  const { cookie } = await cookieDePremiereVisite(base);

  const reponse = await requete(base, "/api/poster", {
    methode: "POST",
    cookie,
    corps: { a: "bob-eternal", corps: "MA-LETTRE-A-MOI", msg_id: "m-tiers-aller" }
  });

  // ① ELLE EXISTE. C'est la seule chose qui compte vraiment : le texte qu'il
  //    vient de taper est au bureau, sous une clef, avec sa signature.
  const sienne = db
    .prepare("SELECT * FROM messages WHERE sender = ? AND body = ?")
    .all(MOI, "MA-LETTRE-A-MOI");
  assert.equal(sienne.length, 1, "la lettre de l'opérateur est au bureau — une fois, pas zéro, pas deux");
  assert.equal(sienne[0].recipient, "bob-eternal");
  assert.notEqual(sienne[0].msg_id, "m-tiers-aller", "elle ne s'est PAS écrite par-dessus le courrier des tiers");

  // ② IL LE SAIT. La clef qu'il a proposée a été écartée, la réponse le DIT et
  //    rend la clef réellement posée — sans nommer ce qui occupait la place.
  assert.equal(reponse.statut, 200, reponse.texte);
  assert.equal(reponse.json.msg_id, sienne[0].msg_id, "la réponse nomme la clef sous laquelle la lettre est VRAIMENT partie");
  assert.equal(reponse.json.clef_ecartee.demandee, "m-tiers-aller", "la clef refusée est celle qu'il a envoyée — pas une découverte");
  assert.equal(reponse.json.clef_ecartee.motif, "clef-deja-prise");
});

test("POSTER : le rejeu de SA PROPRE lettre reste idempotent — la garde n'a pas cassé R2", async (t) => {
  const db = bureauJetable(t);
  decorDesTiers(db);
  const { base } = await porteDeTest(t, { db });
  const { cookie } = await cookieDePremiereVisite(base);

  const lettre = { a: "bob-eternal", corps: "le réseau a coupé", msg_id: "m-a-moi-rejouee" };
  const premier = await requete(base, "/api/poster", { methode: "POST", cookie, corps: lettre });
  const rejeu = await requete(base, "/api/poster", { methode: "POST", cookie, corps: lettre });

  assert.equal(premier.json.msg_id, "m-a-moi-rejouee", "sa clef à lui est HONORÉE : la garde ne renomme que ce qui n'est pas à lui");
  assert.equal(rejeu.json.msg_id, premier.json.msg_id);
  assert.equal(rejeu.json.seq, premier.json.seq, "le rejeu rend LA lettre, pas une seconde");
  assert.equal(rejeu.json.clef_ecartee, undefined, "rien d'écarté : la clef était la sienne");
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM messages WHERE sender = ?").get(MOI).n,
    1,
    "une seule lettre de l'opérateur au bureau"
  );
});

// ── LA COURSE (la ceinture derrière les bretelles) ──────────────────────────
// La vérification de la clef AVANT le dépôt est une PHOTO : rien n'interdit à
// une autre surface de prendre la clef entre la lecture et l'insertion. Le
// contrôle d'APRÈS est donc là pour de bon, et il se prouve — un verrou qu'on
// ne peut pas voir mordre n'est pas un verrou.
test("POSTER : même si la clef est prise ENTRE la lecture et l'insertion, rien ne fuit et la lettre part", async (t) => {
  const db = bureauJetable(t);
  decorDesTiers(db);

  let appels = 0;
  const resultat = await deposerPourLOperateur(
    db,
    MOI,
    { sender: MOI, recipient: "bob-eternal", body: "MA-LETTRE-DANS-LA-COURSE" },
    "m-libre-en-apparence",
    {
      // La clef paraît LIBRE à la lecture…
      chercher: () => null,
      // …et l'insertion tombe malgré tout sur la ligne d'un tiers (la course).
      poster: async (base, entree) => {
        appels += 1;
        if (appels === 1) return { row: getMessageById(base, "m-tiers-aller"), wake: null, attente: null, rejeu: null };
        const { posterUneLettre } = await import("../src/lib/guichet.js");
        return posterUneLettre(base, entree);
      }
    }
  );

  assert.equal(appels, 2, "la porte a REPOSÉ la lettre au lieu de rendre la ligne d'un tiers");
  assert.equal(resultat.row.sender, MOI);
  assert.equal(resultat.row.body, "MA-LETTRE-DANS-LA-COURSE");
  assert.notEqual(resultat.row.msg_id, "m-tiers-aller");
  assert.equal(resultat.clefEcartee, "m-libre-en-apparence");
});

// ── LE REJEU SE DIT (guichet.js, remède R2 ④) ───────────────────────────────
// Le guichet rend le FAIT : « le `a` que tu viens de taper a été écarté, la
// ligne existante l'emporte ». Deux surfaces le mettaient déjà en forme
// (server.js, valxos-send.js) et le commentaire ④ annonçait que la porte web
// serait « la troisième, et la première à l'oublier ». Elle l'avait oublié :
// elle répondait `destinataire: <l'ancien>` sans dire que le nouveau avait été
// écarté — le demi-mensonge exact que R2 existe pour fermer.
test("POSTER : un rejeu vers un AUTRE destinataire le DIT — la porte ne cache pas ce que R2 a écarté", async (t) => {
  const db = bureauJetable(t);
  const { base } = await porteDeTest(t, { db });
  const { cookie } = await cookieDePremiereVisite(base);

  await requete(base, "/api/poster", {
    methode: "POST",
    cookie,
    corps: { a: "bob-eternal", corps: "la première", msg_id: "m-rejeu-ailleurs" }
  });
  const rejeu = await requete(base, "/api/poster", {
    methode: "POST",
    cookie,
    corps: { a: "claude-alice", corps: "la même clef, un autre nom", msg_id: "m-rejeu-ailleurs" }
  });

  assert.equal(rejeu.json.destinataire, "bob-eternal", "R2 : la ligne existante est la vérité");
  assert.ok(rejeu.json.rejeu, "et le posteur DOIT s'entendre dire que le `a` qu'il a tapé a été écarté");
  assert.equal(rejeu.json.rejeu.motif, "msg_id-deja-connu");
  assert.equal(rejeu.json.rejeu.demande, "claude-alice");
});

// ── LE MOUCHARD DES SONNETTES — « LA GARDE VA OÙ LA DONNÉE SORT » ───────────
//
// ⚠️ LEÇON PAYÉE (5e passe adverse, 22/08). Le test « la lettre des tiers reste
// INTACTE » (plus haut) prétendait garder la sonnette, et il NAISSAIT VERT :
// mutation de l'étape ① de `deposerPourLOperateur` — `if (dejaLa &&
// !estMonCourrier(dejaLa))` → `if (false)` — et les 589 tests restaient verts.
// Le comportement, lui, devenait faux : mesuré avec un mouchard sur
// `net.createConnection`, la porte frappait chez `claude-alice`, pour la lettre
// de `claude-alice`, sur ordre d'un client.
//
// POURQUOI CET ORACLE-LÀ NE VOIT RIEN : il lit `reponse.json.reveil`, un PROXY
// dans la RÉPONSE. Or le filet ② repose la lettre sous une clef neuve et
// repost — le `reveil` rendu est TOUJOURS celui du DERNIER essai. La sonnette
// intermédiaire n'atteint jamais la réponse, et un poke sur une socket que
// personne n'écoute ne laisse aucune trace en base : l'effet sortait du
// processus par une porte que rien ne surveillait.
//
// D'où les deux verrous qui suivent. Ils ne lisent plus un champ rendu : ils
// lisent LA SUITE COMPLÈTE des coups frappés, et exigent qu'AUCUN ne nomme le
// tiers — pas seulement le dernier. Le code livré est correct ; c'est le
// verrou qui manquait.

// Le mouchard se pose sur `net.createConnection` : c'est par là, et par là
// SEULEMENT, que `pokeAgentSocket` (src/lib/socket.js) fait sortir la sonnette
// du processus. Il délègue toujours à l'original — on observe, on n'empêche
// rien, sinon on mesurerait un autre programme que celui qui tourne.
function mouchardDesSonnettes(t) {
  const original = net.createConnection;
  const frappes = [];
  net.createConnection = function (...args) {
    // Seules les connexions à un CHEMIN sont des sonnettes (socket unix). Les
    // connexions hôte/port du client HTTP de la suite n'en portent pas.
    const cible = args[0] && typeof args[0] === "object" ? args[0].path : null;
    if (typeof cible === "string") frappes.push(path.basename(cible));
    return original.apply(this, args);
  };
  t.after(() => {
    net.createConnection = original;
  });
  return frappes;
}

test("POSTER : AUCUN coup de sonnette ne nomme le tiers — la suite entière, pas le dernier", async (t) => {
  const db = bureauJetable(t);
  decorDesTiers(db);
  const { base } = await porteDeTest(t, { db });
  const { cookie } = await cookieDePremiereVisite(base);

  const frappes = mouchardDesSonnettes(t);
  await requete(base, "/api/poster", {
    methode: "POST",
    cookie,
    corps: { a: "bob-eternal", corps: "MA-LETTRE-A-MOI", msg_id: "m-tiers-aller" }
  });

  // ① L'INSTRUMENT VOIT SA CIBLE. Sans cette ligne, un mouchard posé au mauvais
  //    endroit — ou une sonnette qui changerait de mécanisme demain — rendrait
  //    une liste vide, et l'assertion ② passerait sur du néant : le verrou
  //    naîtrait vert une deuxième fois. Une sonde qui ne peut pas voir sa cible
  //    n'est jamais un pass.
  assert.ok(
    frappes.includes("bob-eternal.sock"),
    `le mouchard ne voit pas la sonnette LÉGITIME — il n'est pas sur le bon fil : ${JSON.stringify(frappes)}`
  );

  // ② ET AUCUNE FRAPPE NE NOMME LE TIERS. Pas « la dernière » : aucune.
  assert.deepEqual(
    frappes.filter((nom) => nom.includes("claude-alice")),
    [],
    `la porte a SONNÉ chez un tiers pour la lettre d'un tiers — suite des frappes : ${JSON.stringify(frappes)}`
  );
});

test("DÉPÔT : la sonnette chez le tiers n'est pas RATTRAPÉE — elle n'a pas lieu", async (t) => {
  const db = bureauJetable(t);
  decorDesTiers(db);
  const { posterUneLettre } = await import("../src/lib/guichet.js");

  // Le même verrou, une lentille plus fine : le réveil injecté JUSQU'AU guichet
  // nomme la cible telle que `porteDeReveil` l'a calculée, pas un chemin de
  // fichier. Ce qu'il ajoute à l'oracle HTTP : la SUITE EXACTE, donc la preuve
  // que le remède est « aucune frappe fautive » et non « une frappe fautive
  // suivie d'une correction ». Une sonnette ne se reprend pas.
  const frappes = [];
  const resultat = await deposerPourLOperateur(
    db,
    MOI,
    { sender: MOI, recipient: "bob-eternal", body: "MA-LETTRE-SANS-SONNETTE-CHEZ-AUTRUI" },
    "m-tiers-aller",
    {
      poster: (bureau, entree) =>
        posterUneLettre(bureau, entree, {
          reveiller: (cible) => {
            frappes.push(cible);
            return { ok: false, socketPath: `${cible}.sock`, error: "ENOENT" };
          }
        })
    }
  );

  assert.equal(resultat.row.sender, MOI, "la lettre est bien la sienne");
  assert.deepEqual(
    frappes,
    ["bob-eternal"],
    `un seul coup frappé, chez le destinataire QU'IL A ÉCRIT — reçu : ${JSON.stringify(frappes)}`
  );
});
