// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LES BORNES DE LA PORTE — en-têtes, type du pli, drainage, plafond de flux.
//
// Quatre trouvailles mineures du 22/08, réunies parce qu'elles disent toutes la
// même chose : la porte annonçait des limites qu'elle n'appliquait pas, et
// n'annonçait rien de ce qu'elle aurait dû.
//
//   ⑥ AUCUN EN-TÊTE DE SÉCURITÉ. Sonde : `csp=false nosniff=false
//     frameopts=false refpol=false` sur `/`, `/app.js`, `/api/pairs`. Rien
//     n'est exploitable AUJOURD'HUI (l'échappement du front tient,
//     `SameSite=Strict` neutralise le cadre hostile) — mais la page rend du
//     courrier ARBITRAIRE écrit par des tiers dans du `innerHTML`. Le jour où
//     une interpolation oublie d'échapper, il n'y a pas de deuxième ligne.
//   ⑦ LE PLAFOND DE 256 Kio ÉTAIT ANNONCÉ, PAS APPLIQUÉ. Le drainage après
//     dépassement est justifié (« un refus que personne ne reçoit n'est pas un
//     refus ») — la raison est bonne, la BORNE manquait. Sonde : 64,1 Mio
//     envoyés après le plafond, aucune réponse, la porte lisait toujours.
//   ⑧ AUCUN PLAFOND DE FLUX. Soixante `EventSource` d'un coup, chacun rejouant
//     jusqu'à 500 lignes par seconde. Le risque n'est pas un attaquant : c'est
//     l'iPhone qui reprend, l'onglet oublié, la reconnexion en rafale.
//   ⑨ `POST` ACCEPTÉ QUEL QUE SOIT LE `Content-Type` (`text/plain` → 200). Pas
//     exploitable aujourd'hui (`SameSite=Strict` vérifié), mais c'est la
//     DERNIÈRE ligne après le cookie.
//
// ⚠️ Plancher jetable (CC2CC_V2_HOME) posé AVANT le premier test — voir
// aide-porte.js (remède de la revue adverse F2).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const BUREAU_INITIAL = process.env.CC2CC_V2_HOME;
poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-porte-bornes-plancher-")));
after(() => {
  if (BUREAU_INITIAL === undefined) delete process.env.CC2CC_V2_HOME;
  else process.env.CC2CC_V2_HOME = BUREAU_INITIAL;
});

import {
  ENTETES_DE_SECURITE,
  PLAFOND_DE_FLUX,
  PLAFOND_DU_CORPS,
  PLAFOND_DU_DRAINAGE
} from "../src/web/serveur.js";
import { JETON, attendre, bureauJetable, cookieDePremiereVisite, porteDeTest, requete } from "./aide-porte.js";
import { poserLeBureau } from "./aide-env.js";

// ── ⑥ LES EN-TÊTES DE SÉCURITÉ ──────────────────────────────────────────────

test("⑥ TOUTE réponse porte les en-têtes de sécurité — la page rend du courrier écrit par des TIERS", async (t) => {
  const db = bureauJetable(t);
  const { base } = await porteDeTest(t, { db });
  const { cookie, visite } = await cookieDePremiereVisite(base);

  const surfaces = [
    ["la page", await requete(base, "/", { cookie })],
    ["le script", await requete(base, "/app.js", { cookie })],
    ["la feuille", await requete(base, "/style.css", { cookie })],
    ["une API", await requete(base, "/api/pairs", { cookie })],
    ["une route inconnue", await requete(base, "/il-nexiste-pas", { cookie })],
    ["un refus d'entrée", await requete(base, "/api/fil")],
    ["la redirection du marque-page", visite]
  ];

  for (const [quoi, reponse] of surfaces) {
    for (const [nom, valeur] of Object.entries(ENTETES_DE_SECURITE)) {
      assert.equal(
        reponse.entetes[nom],
        valeur,
        `${quoi} (${reponse.statut}) ne porte pas « ${nom} » — un en-tête posé sur trois routes sur sept n'est pas une garde`
      );
    }
  }

  // LA CSP DOIT LAISSER VIVRE LA PAGE D'AUJOURD'HUI. La maquette validée par
  // l'opérateur charge ses polices chez Google (`<link>` dans index.html) : une
  // CSP qui les couperait casserait la page qu'il a validée. On l'exige donc
  // explicitement — et le jour où les polices deviennent locales, ces deux
  // lignes doivent tomber ensemble (voir le commentaire de serveur.js).
  const csp = ENTETES_DE_SECURITE["content-security-policy"];
  assert.match(csp, /default-src 'none'/, "tout est refusé par défaut, on n'ouvre que ce qui sert");
  assert.match(csp, /script-src 'self'/, "aucun script en ligne, aucun script d'ailleurs");
  assert.ok(!/unsafe-inline/.test(csp.replace(/style-src[^;]*/, "")), "aucun `unsafe-inline` hors du strict nécessaire");
  assert.match(csp, /frame-ancestors 'none'/, "la porte ne se met pas dans le cadre d'un autre");
  assert.match(csp, /connect-src 'self'/, "le flux SSE reste possible, et rien d'autre");
  const page = fs.readFileSync(
    path.resolve(new URL("../src/web/public/index.html", import.meta.url).pathname),
    "utf8"
  );
  if (page.includes("fonts.googleapis.com")) {
    assert.match(csp, /fonts\.googleapis\.com/, "la page charge ses polices chez Google : la CSP doit les laisser passer");
    assert.match(csp, /fonts\.gstatic\.com/, "et les fichiers de police avec");
  }
});

// ── ⑨ LE TYPE DU PLI ────────────────────────────────────────────────────────

test("⑨ un POST qui n'est pas du JSON se refuse — la dernière ligne après le cookie", async (t) => {
  const db = bureauJetable(t);
  const { base } = await porteDeTest(t, { db });
  const { cookie } = await cookieDePremiereVisite(base);

  for (const type of ["text/plain", "text/plain;charset=UTF-8", "application/x-www-form-urlencoded", "multipart/form-data"]) {
    const refus = await requete(base, "/api/poster", {
      methode: "POST",
      cookie,
      corps: JSON.stringify({ a: "bob-eternal", corps: "une lettre déguisée" }),
      entetes: { "content-type": type }
    });
    assert.equal(refus.statut, 415, `${type} doit être refusé (${refus.statut})`);
    assert.equal(refus.json.refus, "type-refuse");
  }

  // Un POST SANS AUCUN type : refusé aussi. Il faut une requête brute pour
  // l'écrire — le décor commun pose `application/json` dès qu'il y a un corps,
  // et un décor complaisant ne prouverait rien.
  const sansType = await new Promise((resolve, reject) => {
    const url = new URL(base);
    const charge = JSON.stringify({ msg_id: "m-quelconque" });
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: "/api/accuser",
        method: "POST",
        headers: { cookie, "content-length": Buffer.byteLength(charge) }
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      }
    );
    req.on("error", reject);
    req.end(charge);
  });
  assert.equal(sansType, 415, "sans type déclaré, la porte n'invente pas celui qui l'arrange");

  // CONTRÔLE POSITIF : le vrai type passe, avec ou sans paramètres.
  const bons = ["application/json", "application/json; charset=utf-8", "APPLICATION/JSON"];
  for (const [rang, type] of bons.entries()) {
    const bon = await requete(base, "/api/poster", {
      methode: "POST",
      cookie,
      corps: JSON.stringify({ a: "bob-eternal", corps: "la vraie", msg_id: `m-bon-${rang}` }),
      entetes: { "content-type": type }
    });
    assert.equal(bon.statut, 200, `${type} doit passer : ${bon.texte}`);
  }

  // La preuve que rien n'est passé en base par les refus.
  assert.equal(db.prepare("SELECT count(*) AS n FROM messages").get().n, 3, "trois lettres, celles des contrôles positifs");
});

// ── ⑦ LE DRAINAGE A UNE FIN ─────────────────────────────────────────────────

// On écrit BEAUCOUP et on regarde combien d'octets le client a réussi à
// pousser avant que la porte ne lui coupe la parole. Sans borne, il pousse
// tout — mesuré : 64,1 Mio, aucune réponse, la porte lisait toujours.
function deverser(base, chemin, cookie, octets) {
  const url = new URL(base);
  const bloc = Buffer.alloc(64 * 1024, 0x78);
  return new Promise((resolve) => {
    let ecrits = 0;
    let fini = false;
    const rendre = (comment, statut = null) => {
      if (fini) return;
      fini = true;
      clearTimeout(couperet);
      resolve({ comment, ecrits, statut });
    };
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: chemin,
        method: "POST",
        headers: { cookie, "content-type": "application/json" }
      },
      (res) => {
        res.resume();
        res.on("end", () => rendre("repondu", res.statusCode));
      }
    );
    req.on("error", () => rendre("coupe"));
    const couperet = setTimeout(() => {
      req.destroy();
      rendre("pend");
    }, 20_000);

    const pousser = () => {
      while (ecrits < octets) {
        ecrits += bloc.length;
        if (!req.write(bloc)) {
          req.once("drain", pousser);
          return;
        }
      }
      req.end();
    };
    pousser();
  });
}

test("⑦ le drainage a une FIN — une connexion qu'un client maladroit peut tenir indéfiniment n'est pas une borne", async (t) => {
  const db = bureauJetable(t);
  const { base } = await porteDeTest(t, { db });
  const { cookie } = await cookieDePremiereVisite(base);

  assert.ok(
    PLAFOND_DU_DRAINAGE > PLAFOND_DU_CORPS,
    "le drainage doit dépasser le plafond du corps — sinon le refus part avant d'être lisible"
  );

  // ① SOUS LA BORNE DE DRAINAGE : le refus se REND, proprement. C'est la
  //    raison même du drainage, et elle ne doit pas disparaître avec la borne.
  const juste = await deverser(base, "/api/poster", cookie, PLAFOND_DU_CORPS * 2);
  assert.equal(juste.comment, "repondu", "un pli à peine trop gros reçoit son 413 — il ne se fait pas raccrocher au nez");
  assert.equal(juste.statut, 413);

  // ② AU-DELÀ : la porte cesse de lire. On envoie seize fois la borne.
  const trop = await deverser(base, "/api/poster", cookie, PLAFOND_DU_DRAINAGE * 16);
  assert.notEqual(trop.comment, "pend", "la porte lit toujours après seize fois la borne de drainage");
  assert.ok(
    trop.ecrits < PLAFOND_DU_DRAINAGE * 8,
    `la porte a avalé ${trop.ecrits} octets — la borne est de ${PLAFOND_DU_DRAINAGE}, elle ne s'applique pas`
  );
});

// ── ⑧ LE PLAFOND DE FLUX ────────────────────────────────────────────────────

function ouvrirUnFlux(base, cookie) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: "/api/evenements", method: "GET", headers: { cookie } },
      (res) => {
        res.resume();
        resolve({ statut: res.statusCode, fermer: () => req.destroy() });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

test("⑧ au-delà du plafond, un flux de plus se refuse PROPREMENT — et une place se libère quand un onglet se ferme", async (t) => {
  const db = bureauJetable(t);
  assert.ok(PLAFOND_DE_FLUX >= 2, "le plafond doit laisser vivre plusieurs onglets — un iPhone et un portable, au moins");
  // Un plafond de test à DEUX : mesurer le vrai plafond coûterait soixante
  // connexions pour prouver la même chose.
  const { base, fluxOuverts } = await porteDeTest(t, { db, periodeMs: 50, plafondDeFlux: 2 });
  const { cookie } = await cookieDePremiereVisite(base);

  const premier = await ouvrirUnFlux(base, cookie);
  const second = await ouvrirUnFlux(base, cookie);
  assert.equal(premier.statut, 200);
  assert.equal(second.statut, 200);
  assert.equal(fluxOuverts(), 2);

  const troisieme = await ouvrirUnFlux(base, cookie);
  assert.equal(troisieme.statut, 503, "le flux de trop se refuse — il ne s'ajoute pas en silence");
  assert.equal(fluxOuverts(), 2, "et le refus n'a rien laissé derrière lui");

  // LE REFUS N'EST PAS UNE CONDAMNATION : un onglet qui se ferme rend sa place.
  // Sans ça, une reconnexion en rafale fermerait la porte pour de bon.
  premier.fermer();
  const limite = Date.now() + 3000;
  while (fluxOuverts() !== 1 && Date.now() < limite) await attendre(20);
  assert.equal(fluxOuverts(), 1, "la place se libère à la déconnexion");

  const repris = await ouvrirUnFlux(base, cookie);
  assert.equal(repris.statut, 200, "et l'iPhone qui reprend retrouve sa place");
  repris.fermer();
  second.fermer();
});

test("⑧ un flux refusé n'est pas une porte ouverte : sans jeton, c'est toujours 401 d'abord", async (t) => {
  const db = bureauJetable(t);
  const { base } = await porteDeTest(t, { db, plafondDeFlux: 1 });
  const { cookie } = await cookieDePremiereVisite(base, JETON);
  const tenu = await ouvrirUnFlux(base, cookie);
  assert.equal(tenu.statut, 200);
  // La serrure passe AVANT le plafond : un 503 dirait « cette route existe ».
  const sansJeton = await ouvrirUnFlux(base, "");
  assert.equal(sansJeton.statut, 401, "le plafond ne doit jamais court-circuiter la serrure");
  tenu.fermer();
});

// ── ⑦-bis LE REFUS PART D'ABORD, LE RACCROCHAGE VIENT APRÈS ─────────────────
//
// La borne du matin est juste dans son intention et fausse dans sa mise en
// œuvre : `req.destroy()` courait DEVANT la réponse. Au-delà d'un mégaoctet,
// l'humain recevait donc un diagnostic FAUX — « la connexion a été coupée » —
// au lieu du bon : « ton pli est trop gros ». Deux pannes qui ne se réparent
// pas de la même façon, et c'est le client qui devait deviner laquelle.
//
// Le drainage existe précisément pour que le refus arrive (« un refus que
// personne ne reçoit n'est pas un refus ») : le borner ne doit pas reprendre
// d'une main ce qu'il donne de l'autre. On cesse de LIRE, on rend le 413, et on
// raccroche seulement une fois qu'il est parti.
test("⑦-bis AU-DELÀ DE LA BORNE, LE 413 ARRIVE QUAND MÊME — un raccrochage n'est pas un diagnostic", async (t) => {
  const db = bureauJetable(t);
  const { base } = await porteDeTest(t, { db });
  const { cookie } = await cookieDePremiereVisite(base);

  for (const chemin of ["/api/poster", "/api/accuser"]) {
    const trop = await deverser(base, chemin, cookie, PLAFOND_DU_DRAINAGE * 8);
    assert.equal(
      trop.comment,
      "repondu",
      `${chemin} : le client a eu « ${trop.comment} » après ${trop.ecrits} octets — il ne saura jamais que son pli était trop gros`
    );
    assert.equal(trop.statut, 413, `${chemin} : le refus doit NOMMER le défaut`);
  }

  // ET LA BORNE TIENT TOUJOURS : le refus qui part d'abord ne doit pas rouvrir
  // la connexion qu'un client maladroit tenait indéfiniment.
  const tenu = await deverser(base, "/api/poster", cookie, PLAFOND_DU_DRAINAGE * 16);
  assert.ok(
    tenu.ecrits < PLAFOND_DU_DRAINAGE * 8,
    `la porte a avalé ${tenu.ecrits} octets — la borne est de ${PLAFOND_DU_DRAINAGE}`
  );

  // Rien n'est entré en base par un pli refusé.
  assert.equal(db.prepare("SELECT count(*) AS n FROM messages").get().n, 0, "un pli refusé ne dépose rien");
});
