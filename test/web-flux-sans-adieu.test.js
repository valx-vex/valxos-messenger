// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LE PLAFOND DE FLUX SE LIBÈRE SANS ADIEU — sinon ce n'est pas un plafond,
// c'est un compte à rebours.
//
// Douze places, libérées « à chaque déconnexion » : la phrase était vraie et
// elle ne suffisait pas. RIEN ne provoque de déconnexion côté serveur. Un
// iPhone qui se rendort, un onglet qui perd le réseau, un tunnel tailnet qui
// tombe : le client ne dit jamais au revoir, la socket reste « ouverte » pour
// le processus, et la place reste prise jusqu'à ce que le système
// d'exploitation s'en aperçoive — quinze minutes de retransmissions TCP,
// parfois jamais. Au treizième réveil, l'opérateur ne peut plus ouvrir sa porte,
// et le refus qu'il reçoit (503, « fermez un onglet ») lui demande de fermer
// des onglets qui n'existent plus.
//
// LE SEUL SIGNE QU'UNE SOCKET MORTE DONNE, C'EST QU'ELLE N'AVALE PLUS. D'où les
// deux gestes de ce test : un BATTEMENT DE CŒUR (on écrit, régulièrement, même
// quand il n'y a rien à dire) et une EXPIRATION (ce qu'on écrit s'entasse sans
// jamais partir → la place se rend). Sans le battement, l'expiration ne verrait
// jamais rien : un flux muet ne remplit aucun tampon.
//
// ⚠️ POURQUOI UNE HORLOGE ET DES TOURS PILOTÉS : la vraie période de battement
// se compte en dizaines de secondes. Un test qui les attendrait vraiment
// deviendrait un test qu'on saute. On injecte donc l'horloge et le poseur
// d'intervalle — les deux sont déjà des paramètres de la porte, pour la même
// raison (le filet des minuteurs orphelins).
//
// ⚠️ Plancher jetable (CC2CC_V2_HOME) posé AVANT le premier test — voir
// aide-porte.js (remède de la revue adverse F2).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

const BUREAU_INITIAL = process.env.CC2CC_V2_HOME;
poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-porte-adieu-plancher-")));
after(() => {
  if (BUREAU_INITIAL === undefined) delete process.env.CC2CC_V2_HOME;
  else process.env.CC2CC_V2_HOME = BUREAU_INITIAL;
});

import { DELAI_DE_SILENCE_MS, PERIODE_DU_BATTEMENT_MS } from "../src/web/serveur.js";
import { bureauJetable, cookieDePremiereVisite, porteDeTest } from "./aide-porte.js";
import { poserLeBureau } from "./aide-env.js";

// UN CLIENT QUI N'AVALE PLUS — l'iPhone endormi, en une trentaine de lignes.
// Il accepte la connexion, il ne rend jamais la main : tout ce qu'on lui écrit
// s'entasse. C'est EXACTEMENT ce que le noyau observe d'une socket dont le pair
// a disparu sans fermer.
function clientQuiNAvalePlus({ avale }) {
  const etat = { statut: null, ecrits: [], detruit: false };
  const res = {
    etat,
    // Ce qui reste coincé dans le tampon de sortie : zéro pour un client qui
    // lit, croissant pour un client qui n'est plus là.
    get writableLength() {
      return avale ? 0 : etat.ecrits.join("").length;
    },
    get writableEnded() {
      return false;
    },
    get destroyed() {
      return etat.detruit;
    },
    get headersSent() {
      return etat.statut !== null;
    },
    setHeader() {},
    getHeader() {},
    writeHead(statut) {
      etat.statut = statut;
      return res;
    },
    write(bloc) {
      etat.ecrits.push(String(bloc));
      return avale;
    },
    end() {
      etat.detruit = true;
    },
    destroy() {
      etat.detruit = true;
    },
    on() {
      return res;
    },
    once() {
      return res;
    }
  };
  return res;
}

// ⚠️ LE GESTIONNAIRE EST ASYNCHRONE : `emit` rend la main avant que le flux ne
// soit inscrit. On laisse donc passer un tour de boucle — sans quoi on
// mesurerait un compte qui n'a pas encore été écrit.
async function installerLeFlux(porte, cookie, res) {
  porte.serveur.emit("request", requeteDuFlux(cookie), res);
  await new Promise((resolve) => setImmediate(resolve));
}

function requeteDuFlux(cookie) {
  const req = Readable.from([]);
  req.method = "GET";
  req.url = "/api/evenements";
  req.headers = { cookie };
  return req;
}

// La porte, avec son horloge et ses tours dans la main du test.
async function porteAuRalenti(t, db, options = {}) {
  let maintenant = 1_700_000_000_000;
  const tours = new Set();
  const porte = await porteDeTest(t, {
    db,
    plafondDeFlux: 1,
    horloge: () => maintenant,
    poserIntervalle: (fonction) => {
      tours.add(fonction);
      return fonction;
    },
    retirerIntervalle: (fonction) => tours.delete(fonction),
    ...options
  });
  return {
    ...porte,
    avancer(ms) {
      maintenant += ms;
    },
    unTour() {
      for (const tour of [...tours]) tour();
    },
    tours
  };
}

function ouvrirUnFluxHttp(base, cookie) {
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

test("LA PLACE SE REND SANS ADIEU — un client qui n'avale plus finit par rendre son fauteuil", async (t) => {
  const db = bureauJetable(t);
  const porte = await porteAuRalenti(t, db);
  const { cookie } = await cookieDePremiereVisite(porte.base);

  // TROIS ISSUES : sans place prise, il n'y a rien à rendre.
  const endormi = clientQuiNAvalePlus({ avale: false });
  await installerLeFlux(porte, cookie, endormi);
  assert.equal(porte.fluxOuverts(), 1, "SONDE IMPOSSIBLE : le flux de l'iPhone n'a pas été accepté");
  assert.equal(endormi.etat.statut, 200);

  // LA PORTE EST FERMÉE POUR OPERATEUR : le plafond de test est à un.
  const refuse = await ouvrirUnFluxHttp(porte.base, cookie);
  assert.equal(refuse.statut, 503, "la place est bien prise — sinon la suite ne prouverait rien");

  // LE TEMPS PASSE, ET PERSONNE NE DIT AU REVOIR. Premier tour : la porte bat,
  // et CONSTATE que rien ne part. C'est de là que le silence se compte.
  porte.avancer(PERIODE_DU_BATTEMENT_MS + 1);
  porte.unTour();
  assert.equal(
    porte.fluxOuverts(),
    1,
    "on ne moissonne pas au premier soupçon : un réseau lent n'est pas un réseau mort"
  );

  // Trois battements plus tard, le tampon ne s'est toujours pas vidé.
  porte.avancer(DELAI_DE_SILENCE_MS + 1);
  porte.unTour();

  assert.equal(
    porte.fluxOuverts(),
    0,
    "la place n'est jamais rendue : au treizième réveil, l'opérateur ne peut plus ouvrir sa porte"
  );
  assert.ok(endormi.etat.detruit, "et la socket morte est vraiment lâchée, pas seulement oubliée du compte");

  // ET L'IPHONE QUI REPREND RETROUVE SA PLACE, sans avoir rien fermé.
  const repris = await ouvrirUnFluxHttp(porte.base, cookie);
  assert.equal(repris.statut, 200, "le fauteuil rendu doit être réellement réutilisable");
  repris.fermer();
});

test("LE BATTEMENT DE CŒUR EXISTE — sans écriture, une socket morte ne se trahit jamais", async (t) => {
  const db = bureauJetable(t);
  const porte = await porteAuRalenti(t, db);
  const { cookie } = await cookieDePremiereVisite(porte.base);

  const vivant = clientQuiNAvalePlus({ avale: true });
  await installerLeFlux(porte, cookie, vivant);
  const auDepart = vivant.etat.ecrits.length;

  // Un tour tout de suite : rien à dire, donc rien de plus qu'à l'ouverture.
  porte.unTour();
  assert.equal(vivant.etat.ecrits.length, auDepart, "un flux ne bat pas à chaque tour — ce serait du bruit, pas un battement");

  porte.avancer(PERIODE_DU_BATTEMENT_MS + 1);
  porte.unTour();
  const battements = vivant.etat.ecrits.filter((bloc) => bloc.startsWith(":"));
  assert.equal(battements.length, 1, `le flux doit battre : écrits = ${JSON.stringify(vivant.etat.ecrits)}`);

  // ⚠️ UN BATTEMENT EST UN COMMENTAIRE SSE, PAS UN ÉVÉNEMENT : `EventSource`
  // l'ignore sans le remonter à la page. Un battement qui se présenterait comme
  // un événement obligerait le front à connaître un mot de plus, pour rien.
  assert.match(battements[0], /^:[^\n]*\n\n$/, "le battement doit être un commentaire, terminé comme un événement");

  // ET UN CLIENT QUI AVALE GARDE SA PLACE. Sans ce contrôle, une porte qui
  // moissonne TOUT le monde passerait le premier test en triomphe.
  porte.avancer(DELAI_DE_SILENCE_MS * 4);
  porte.unTour();
  porte.unTour();
  assert.equal(porte.fluxOuverts(), 1, "un onglet qui lit son courrier ne se fait pas moissonner");
  assert.ok(!vivant.etat.detruit, "et sa socket n'est pas lâchée");
});

test("UNE SOCKET DÉJÀ MORTE NE COÛTE PAS UN TOUR DE PLUS — la place se rend au premier tour", async (t) => {
  const db = bureauJetable(t);
  const porte = await porteAuRalenti(t, db);
  const { cookie } = await cookieDePremiereVisite(porte.base);

  const parti = clientQuiNAvalePlus({ avale: true });
  await installerLeFlux(porte, cookie, parti);
  assert.equal(porte.fluxOuverts(), 1);

  // Le cas où l'on N'A PAS reçu l'événement `close` (il arrive : une socket
  // détruite par le noyau, un `end()` venu d'ailleurs) — le flux doit quand
  // même disparaître au tour suivant.
  parti.etat.detruit = true;
  porte.unTour();
  assert.equal(porte.fluxOuverts(), 0, "une socket morte n'a pas besoin d'attendre le délai de silence");
});

// ⚠️ CE QUE LES TROIS TESTS CI-DESSUS NE PROUVENT PAS, DIT À VOIX HAUTE : ils
// parlent à une réponse JOUET. C'est le seul moyen d'observer un tampon qui ne
// se vide pas — une VRAIE socket morte sur la boucle locale avale des dizaines
// de milliers de battements dans les tampons du noyau avant de se boucher, et
// un test qui l'attendrait vraiment durerait des minutes. Le contrôle ci-dessous
// ferme l'autre moitié : que le battement soit bien des OCTETS QUI PARTENT sur
// une vraie connexion, dans la forme qu'un navigateur accepte.
test("LE BATTEMENT PART VRAIMENT SUR LE FIL — un vrai client, une vraie socket", async (t) => {
  const db = bureauJetable(t);
  // Un battement toutes les 30 ms : la vraie période se compte en dizaines de
  // secondes, et c'est le FORMAT qu'on vérifie ici, pas le rythme.
  const { base } = await porteDeTest(t, { db, periodeMs: 10, periodeDuBattementMs: 30 });
  const { cookie } = await cookieDePremiereVisite(base);
  const url = new URL(base);

  const recu = await new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: "/api/evenements", method: "GET", headers: { cookie } },
      (res) => {
        let texte = "";
        res.on("data", (bloc) => {
          texte += bloc.toString("utf8");
          if (/^:.*$/m.test(texte)) {
            req.destroy();
            resolve(texte);
          }
        });
      }
    );
    req.on("error", (erreur) => {
      // La coupure qu'on vient de provoquer n'est pas une panne.
      if (erreur.code !== "ECONNRESET") reject(erreur);
    });
    const couperet = setTimeout(() => {
      req.destroy();
      reject(new Error("aucun battement reçu en 3 s sur une vraie socket"));
    }, 3000);
    couperet.unref();
    req.end();
  });

  assert.match(recu, /^: /m, "le battement doit voyager comme un commentaire SSE");
  assert.match(recu, /event: pairs/, "et il ne remplace pas le premier événement — il s'y ajoute");
});
