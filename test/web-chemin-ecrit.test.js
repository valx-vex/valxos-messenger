// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// GARDE N°1, MOITIÉ ①-bis — LE CHEMIN JUGÉ EST LE CHEMIN ÉCRIT.
//
// Ce que `web-repartiteur.test.js` prouve : que le répartiteur, à qui on donne
// un chemin, ne rend jamais une route hors de sa table. Ce qu'il ne prouve
// PAS, et la sonde du 22/08 l'a montré en une ligne insérée dans le
// gestionnaire :
//
//     const chemin = cheminDemande(req.url).replace(/^\/x9\//, "/");
//
// TOUTE la porte servie sous un préfixe jetable — `/x9/api/fil`, `/x9/`,
// `/x9/app.js` — et les trois voies de l'oracle restent VERTES. Le répartiteur
// juge parfaitement ; on lui donne simplement autre chose que ce que le client
// a demandé. Le préfixe n'est écrit nulle part en littéral (c'est une
// expression régulière), donc ⓐ ne le voit pas ; aucun tirage ne le devine,
// donc ⓑ et ⓒ ne le voient pas non plus. Allonger le tirage ne ferme pas cette
// famille-là : elle est infinie, exactement comme l'était la liste des chemins
// interdits.
//
// CE FICHIER LA FERME PAR CONSTRUCTION, PAS PAR ÉCHANTILLON. La porte note la
// cible que l'analyseur HTTP a lue (premier auditeur de `request`) et refuse de
// servir une route qui ne soit pas exactement celle-là. L'oracle porte donc sur
// LA TABLE ENTIÈRE, une route après l'autre : pour chacune, une réécriture qui
// mène jusqu'à elle doit rendre 404.
//
// ⚠️ COMMENT ON SIMULE UNE RÉÉCRITURE SANS EN ÉCRIRE UNE. On ne modifie pas la
// source pour la tester (un test qui exige sa propre mutation n'est pas un
// test) : on parle au serveur par `serveur.emit("request", …)` avec une requête
// dont `url` REND UNE AUTRE VALEUR à partir de la deuxième lecture. Le premier
// auditeur lit ce que le client a écrit, le gestionnaire lit ce qu'une
// réécriture lui aurait donné — c'est le défaut lui-même, joué au bon endroit,
// sans qu'aucune ligne de la porte ne soit tordue pour l'occasion.
//
// ⚠️ Plancher jetable (CC2CC_V2_HOME) posé AVANT le premier test — voir
// aide-porte.js (remède de la revue adverse F2).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

const BUREAU_INITIAL = process.env.CC2CC_V2_HOME;
poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-porte-chemin-plancher-")));
after(() => {
  if (BUREAU_INITIAL === undefined) delete process.env.CC2CC_V2_HOME;
  else process.env.CC2CC_V2_HOME = BUREAU_INITIAL;
});

import { ROUTES, noterLaLigne } from "../src/web/serveur.js";
import { bureauJetable, cookieDePremiereVisite, porteDeTest, requete } from "./aide-porte.js";
import { poserLeBureau } from "./aide-env.js";

// Une réponse jouet : elle ne fait rien d'autre que retenir ce que la porte a
// répondu, et savoir dire quand la réponse est finie.
function fausseReponse() {
  const etat = { statut: null, corps: "", entetes: {}, envoyes: false };
  let finir;
  const finie = new Promise((resolve) => {
    finir = resolve;
  });
  const res = {
    etat,
    finie,
    get headersSent() {
      return etat.envoyes;
    },
    setHeader(nom, valeur) {
      etat.entetes[String(nom).toLowerCase()] = valeur;
    },
    getHeader(nom) {
      return etat.entetes[String(nom).toLowerCase()];
    },
    writeHead(statut, entetes = {}) {
      etat.statut = statut;
      etat.envoyes = true;
      for (const [nom, valeur] of Object.entries(entetes || {})) etat.entetes[String(nom).toLowerCase()] = valeur;
      return res;
    },
    write(bloc) {
      etat.corps += String(bloc);
      return true;
    },
    end(bloc) {
      if (bloc !== undefined) etat.corps += String(bloc);
      finir(etat);
    },
    on() {
      return res;
    },
    once() {
      return res;
    },
    destroy() {}
  };
  return res;
}

// LA REQUÊTE QUI SE RÉÉCRIT ENTRE DEUX LECTURES. `ecrit` est ce que le client a
// mis dans sa ligne de requête ; `juge` est ce qu'une réécriture posée dans le
// gestionnaire donnerait au routage. Quand les deux sont égaux, il n'y a pas de
// réécriture du tout — c'est le contrôle positif.
function requeteQuiSeReecrit({ ecrit, juge, methode = "GET", cookie, corps = "{}" }) {
  // Un VRAI flux lisible, et pas un jouet : `/api/poster` et `/api/accuser`
  // attendent la fin du corps avant de répondre. Un faux `on()` qui ne dit
  // jamais « fini » les laisserait pendre, et le contrôle positif ne
  // prouverait plus rien de ces deux routes-là.
  const requete = Readable.from(methode === "POST" ? [Buffer.from(corps, "utf8")] : []);
  requete.method = methode;
  requete.headers = { cookie, "content-type": "application/json" };
  let lue = 0;
  Object.defineProperty(requete, "url", {
    get() {
      lue += 1;
      return lue === 1 ? ecrit : juge;
    }
  });
  return requete;
}

// ⚠️ UN COUPERET PAR SONDE, et il n'est pas décoratif : une porte qui SERVIRAIT
// la réécriture de `/api/evenements` ouvrirait un FLUX — une réponse qui ne
// finit jamais. Sans couperet, le test PEND au lieu de rougir, et un test qui
// pend est un test qu'on cesse de croire. Le couperet rend ce que la porte a
// déjà écrit : c'est exactement ce qu'on veut lire dans le message d'échec.
async function parlerALaPorte(serveur, options) {
  const res = fausseReponse();
  serveur.emit("request", requeteQuiSeReecrit(options), res);
  let couperet;
  const patience = new Promise((resolve) => {
    couperet = setTimeout(() => resolve({ ...res.etat, pend: true }), 2000);
  });
  try {
    return await Promise.race([res.finie, patience]);
  } finally {
    clearTimeout(couperet);
  }
}

test("①-bis LE TÉMOIN DE LA CIBLE EST LE PREMIER AUDITEUR — sinon la référence est teignable", async (t) => {
  const db = bureauJetable(t);
  const { serveur } = await porteDeTest(t, { db });
  const auditeurs = serveur.listeners("request");
  assert.ok(auditeurs.length >= 2, `SONDE IMPOSSIBLE : ${auditeurs.length} auditeur(s) de requête`);
  assert.equal(
    auditeurs[0],
    noterLaLigne,
    "le témoin de la cible doit être posé AVANT le gestionnaire — un auditeur glissé devant lui pourrait teindre la référence"
  );
});

test("①-bis UNE RÉÉCRITURE DU CHEMIN NE SERT PLUS RIEN — la table ENTIÈRE, une route après l'autre", async (t) => {
  const db = bureauJetable(t);
  const { serveur, base } = await porteDeTest(t, { db });
  const { cookie } = await cookieDePremiereVisite(base);

  // TROIS ISSUES, JAMAIS DEUX : sans route à sonder, ce test ne prouve rien.
  assert.ok(ROUTES.length >= 9, `SONDE IMPOSSIBLE : ${ROUTES.length} routes dans la table`);

  // Les préfixes jetables d'une réécriture — celui de la sonde du 22/08, et
  // trois autres formes pour qu'on ne puisse pas dire « c'est ce préfixe-là ».
  const PREFIXES = ["/x9", "/pont", "/a/b/c", "/%41"];

  for (const route of ROUTES) {
    for (const prefixe of PREFIXES) {
      const etat = await parlerALaPorte(serveur, {
        ecrit: `${prefixe}${route.chemin}`,
        juge: route.chemin,
        methode: route.methode,
        cookie
      });
      assert.equal(
        etat.statut,
        404,
        `${route.methode} ${prefixe}${route.chemin} réécrit en ${route.chemin} → ${etat.statut} : ` +
          `une porte servie sous un préfixe jetable est une porte dérobée qu'aucun tirage ne devine`
      );
      assert.match(etat.corps, /route-inconnue/, "et le refus est celui de tout le monde — pas une carte du produit");
    }
  }
});

test("①-bis LE CONTRÔLE POSITIF — sans réécriture, la même mécanique SERT (sinon la garde est un mur)", async (t) => {
  const db = bureauJetable(t);
  const { serveur, base } = await porteDeTest(t, { db });
  const { cookie } = await cookieDePremiereVisite(base);

  // `/api/evenements` est un FLUX : il ne finit jamais, on ne le sonde pas ici
  // (l'oracle du répartiteur s'en charge par la ligne de statut).
  const sondables = ROUTES.filter((route) => route.chemin !== "/api/evenements");
  assert.ok(sondables.length >= 8, `SONDE IMPOSSIBLE : ${sondables.length} routes sondables`);

  for (const route of sondables) {
    const etat = await parlerALaPorte(serveur, {
      ecrit: route.chemin,
      juge: route.chemin,
      methode: route.methode,
      cookie
    });
    assert.notEqual(etat.statut, 404, `${route.methode} ${route.chemin} → 404 : la table doit être SERVIE`);
    assert.notEqual(etat.statut, 405, `${route.methode} ${route.chemin} → 405 : la table doit être SERVIE`);
  }
});

test("①-bis UNE RÉÉCRITURE QUI DÉTOURNE UNE VRAIE ROUTE VERS UNE AUTRE ne sert pas davantage", async (t) => {
  const db = bureauJetable(t);
  const { serveur, base } = await porteDeTest(t, { db });
  const { cookie } = await cookieDePremiereVisite(base);

  // Le cas que même un tirage exhaustif sur les chemins ne verrait pas : les
  // DEUX chemins sont dans la table, seul le lien entre eux est faux. Le client
  // demande la feuille de style, la porte servirait son courrier.
  const etat = await parlerALaPorte(serveur, { ecrit: "/style.css", juge: "/api/fil", methode: "GET", cookie });
  assert.equal(etat.statut, 404, "un chemin de la table détourné vers un autre reste un détournement");
  assert.ok(!etat.corps.includes("\"lettres\""), "et pas un octet du fil n'est parti sur un chemin qui ne le nomme pas");

  // ET LA PORTE VIT TOUJOURS : le refus ci-dessus n'est pas un mur posé sur la
  // vraie route, qui répond par le VRAI chemin, en HTTP, comme tous les jours.
  const vraie = await requete(base, "/api/fil", { cookie });
  assert.equal(vraie.statut, 200, "la vraie route, demandée par son vrai chemin, sert toujours");
});
