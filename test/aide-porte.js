// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LE DÉCOR COMMUN DES TROIS FICHIERS DE LA PORTE WEB.
//
// Ce fichier ne porte AUCUN test, et son nom ne finit pas par `.test.js` :
// c'est délibéré — le balayage de `garde-bureau.test.js` rejoue tout ce qui
// porte ce suffixe, et un décor rejoué seul ne prouverait rien.
//
// ⚠️ Chaque fichier de test pose SON plancher jetable (CC2CC_V2_HOME) avant le
// premier test : `openDatabase` appelle `ensureRuntimeDirs`, qui lit
// `baseDir()` — l'ENV du runner, jamais le fichier qu'on lui impose
// (remède de la revue adverse F2). Le décor ci-dessous repose l'env par test,
// mais le plancher du fichier reste indispensable : la fiche de pair
// (`writeHeartbeat`) suit l'ENV et rien d'autre.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../src/lib/database.js";
import { EN_TETE_DE_LA_MARQUE, MARQUES, ouvrirLaPorte } from "../src/web/serveur.js";
import { poserLeBureau } from "./aide-env.js";

// ── LA MARQUE DU RÉPARTITEUR, VÉRIFIÉE SUR TOUTES LES RÉPONSES DE LA SUITE ───
//
// GARDE N°1, MOITIÉ ②. La porte n'a qu'un chemin vers une réponse : un verdict
// frappé par une décision de la porte. Ce fait est LISIBLE de l'extérieur —
// chaque réponse porte `x-porte-verdict`, posé par `autoriserLaReponse` et par
// personne d'autre (src/web/serveur.js).
//
// POURQUOI LA VÉRIFICATION EST ICI ET PAS DANS UN TEST DÉDIÉ : un test dédié ne
// sonde que les chemins auxquels il pense, et c'est exactement ce qui a laissé
// passer la porte dérobée du 22/08 (un chemin CALCULÉ, que rien ne nomme). Posée
// dans le décor commun, la vérification s'applique aux CENTAINES de requêtes que
// la suite provoque déjà — chaque route, chaque refus, chaque borne, chaque
// mutant. Une réponse écrite en amont du répartiteur n'a pas de marque : elle se
// fait voir par le premier test qui touche son chemin, quel qu'il soit, sans que
// personne n'ait eu à le deviner.
export function verifierLaMarque(statut, entetes, quoi) {
  const marque = entetes[EN_TETE_DE_LA_MARQUE];
  if (MARQUES.includes(marque)) return;
  throw new Error(
    `RÉPONSE SANS MARQUE DU RÉPARTITEUR : ${quoi} → ${statut}, ` +
      `${EN_TETE_DE_LA_MARQUE} = ${JSON.stringify(marque ?? null)}. ` +
      `Toute réponse de la porte sort d'un verdict frappé (marques : ${MARQUES.join(", ")}) — ` +
      `une réponse sans marque a été écrite ailleurs que sur le chemin du répartiteur.`
  );
}

// Des jetons de la VRAIE forme (32 octets en hexadécimal). Un jeton jouet de
// six lettres ferait passer pour vert le piège de `timingSafeEqual`, qui ne
// mord que sur des longueurs qui diffèrent.
export const JETON = "a".repeat(64);
export const JETON_FAUX = "b".repeat(64);
export const JETON_COURT = "b".repeat(12);
export const MOI = "operateur";

export function bureauJetable(t) {
  const racine = fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-porte-"));
  poserLeBureau(racine);
  const db = openDatabase({ file: path.join(racine, "broker.db") });
  t.after(() => {
    try {
      db.close();
    } catch {
      /* base jetable */
    }
    fs.rmSync(racine, { recursive: true, force: true });
  });
  return db;
}

// La porte de test écoute sur le port 0 (le noyau choisit) mais passe par
// `ouvrirLaPorte`, comme le vrai lanceur : la garde de l'hôte est ainsi sur le
// chemin de TOUS les tests, jamais contournée par un raccourci de décor.
export async function porteDeTest(t, options = {}) {
  const ouverte = await ouvrirLaPorte({
    jeton: JETON,
    operateur: MOI,
    hote: "127.0.0.1",
    port: 0,
    ...options
  });
  t.after(async () => {
    await ouverte.fermer();
  });
  return { ...ouverte, base: `http://127.0.0.1:${ouverte.adresse.port}` };
}

export function requete(base, chemin, { methode = "GET", cookie = null, corps = null, entetes = {} } = {}) {
  const url = new URL(chemin, base);
  const enTetes = { ...entetes };
  if (cookie) enTetes.cookie = cookie;
  const charge = corps === null ? null : typeof corps === "string" ? corps : JSON.stringify(corps);
  if (charge !== null && !enTetes["content-type"]) enTetes["content-type"] = "application/json";
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: methode,
        headers: enTetes
      },
      (res) => {
        const morceaux = [];
        res.on("data", (bloc) => morceaux.push(bloc));
        res.on("end", () => {
          // La marque se vérifie AVANT de rendre la réponse, et son échec passe
          // par `reject` : levée dans un auditeur, elle tomberait à côté de la
          // promesse et le test PENDRAIT au lieu de rougir.
          try {
            verifierLaMarque(res.statusCode, res.headers, `${methode} ${chemin}`);
          } catch (erreur) {
            reject(erreur);
            return;
          }
          const texte = Buffer.concat(morceaux).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(texte);
          } catch {
            /* toutes les réponses ne sont pas du JSON — le texte brut reste lisible */
          }
          resolve({
            statut: res.statusCode,
            entetes: res.headers,
            cookies: res.headers["set-cookie"] || [],
            texte,
            json
          });
        });
      }
    );
    req.on("error", reject);
    req.end(charge === null ? undefined : charge);
  });
}

// Le cookie tel que le NAVIGATEUR le renverrait : pris au Set-Cookie de la
// vraie première visite, jamais fabriqué à la main — un cookie fabriqué
// resterait vert le jour où la porte changerait le nom du sien.
export async function cookieDePremiereVisite(base, jeton = JETON) {
  const visite = await requete(base, `/?t=${jeton}`);
  const pose = String(visite.cookies[0] || "").split(";")[0];
  return { cookie: pose, visite };
}

// Un client SSE minimal : il accumule les événements et sait attendre le
// premier qui répond à une question. `fermer()` coupe la connexion côté
// client, exactement comme un onglet qu'on referme.
export function fluxSSE(base, { cookie }) {
  const url = new URL("/api/evenements", base);
  const evenements = [];
  const guetteurs = [];
  let requeteHttp = null;
  const pret = new Promise((resolve, reject) => {
    requeteHttp = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: "GET", headers: { cookie } },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`le flux répond ${res.statusCode}, pas 200`));
          return;
        }
        // Le FLUX aussi porte la marque : c'est une réponse comme une autre, et
        // la seule qui ne finit jamais — l'oublier laisserait une surface entière
        // hors du contrôle.
        try {
          verifierLaMarque(res.statusCode, res.headers, "GET /api/evenements");
        } catch (erreur) {
          reject(erreur);
          return;
        }
        let tampon = "";
        res.on("data", (bloc) => {
          tampon += bloc.toString("utf8");
          let coupe = tampon.indexOf("\n\n");
          while (coupe >= 0) {
            const message = tampon.slice(0, coupe);
            tampon = tampon.slice(coupe + 2);
            const type = message.match(/^event: (.*)$/m)?.[1] || "message";
            const brut = message.match(/^data: (.*)$/m)?.[1] || "null";
            evenements.push({ type, brut, donnees: JSON.parse(brut) });
            for (const guetteur of guetteurs.splice(0)) guetteur();
            coupe = tampon.indexOf("\n\n");
          }
        });
        resolve();
      }
    );
    requeteHttp.on("error", reject);
    requeteHttp.end();
  });

  return {
    pret,
    evenements,
    async attendre(predicat, delaiMs = 5000) {
      const limite = Date.now() + delaiMs;
      for (;;) {
        const trouve = evenements.find(predicat);
        if (trouve) return trouve;
        if (Date.now() > limite) {
          throw new Error(
            `aucun événement attendu en ${delaiMs} ms — reçus : ${JSON.stringify(evenements.map((e) => e.type))}`
          );
        }
        await new Promise((resolve) => {
          const minuteur = setTimeout(resolve, 20);
          guetteurs.push(() => {
            clearTimeout(minuteur);
            resolve();
          });
        });
      }
    },
    fermer() {
      requeteHttp.destroy();
    }
  };
}

// Une pause explicite. Elle ne sert JAMAIS à « laisser le temps » à une
// assertion : uniquement à prouver qu'après une déconnexion, plusieurs tours
// de scrutation passent SANS que la porte ne travaille plus pour ce client.
export function attendre(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
