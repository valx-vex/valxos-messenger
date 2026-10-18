// LE CADRAGE DE LA PORTE — fermé par défaut, ouvert seulement sur des origines.
//
// Cette garde ne se contente pas de regarder un objet construit par le test :
// elle ouvre une vraie porte sur un port jetable, lit ses réponses HTTP et lit
// aussi le chemin de configuration réel. Une liste blanche qui existerait à
// côté du lanceur, ou un en-tête qui ne voyagerait pas sur le 401, rougirait.
//
// Aucune requête ne touche le service vivant. Le seul chemin demandé est `/`,
// sans cookie : il répond 401 et ne relève donc aucun courrier.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { poserLeBureau } from "./aide-env.js";

const BUREAU_INITIAL = process.env.CC2CC_V2_HOME;
poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-porte-cadrage-plancher-")));
after(() => {
  if (BUREAU_INITIAL === undefined) delete process.env.CC2CC_V2_HOME;
  else process.env.CC2CC_V2_HOME = BUREAU_INITIAL;
});

const auth = await import("../src/web/auth.js");
const serveur = await import("../src/web/serveur.js");
const { bureauJetable, porteDeTest, requete } = await import("./aide-porte.js");

const racine = path.resolve(new URL("..", import.meta.url).pathname);
const sourceAuth = fs.readFileSync(path.join(racine, "src", "web", "auth.js"), "utf8");
const sourceLanceur = fs.readFileSync(path.join(racine, "src", "bin", "valxos-web.js"), "utf8");

const DIRECTIVES_FIXES = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'"
];

function cspAttendue(ancetres) {
  return [...DIRECTIVES_FIXES, `frame-ancestors ${ancetres}`].join("; ");
}

async function entetesPour(t, cadreAutorise) {
  const db = bureauJetable(t);
  const { base } = await porteDeTest(t, { db, cadreAutorise });
  const reponse = await requete(base, "/");
  assert.equal(reponse.statut, 401, "la sonde reste devant la serrure");
  return reponse.entetes;
}

function exigerLeVerrou(entetes, quoi) {
  assert.equal(
    entetes["content-security-policy"],
    cspAttendue("'none'"),
    `${quoi} doit rendre le verrou CSP complet, sans liste partielle`
  );
  assert.equal(entetes["x-frame-options"], "DENY", `${quoi} doit garder le vieux verrou DENY`);
}

test("C1 sans configuration, le cadrage reste verrouillé à l'octet près", async (t) => {
  assert.deepEqual(
    serveur.ENTETES_DE_SECURITE,
    {
      "content-security-policy": cspAttendue("'none'"),
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer"
    },
    "le défaut exporté reste exactement celui de la porte actuelle"
  );
  exigerLeVerrou(await entetesPour(t, undefined), "la configuration absente");
  exigerLeVerrou(await entetesPour(t, "   "), "la configuration vide");
});

test("C2 une liste valide vient de web.env, garde l'ordre exact et retire X-Frame-Options", async (t) => {
  const origines = [
    "http://command-center.example:8787",
    "https://command-center.example.net:8787",
    "http://127.0.0.1:8787"
  ];
  const maison = fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-porte-cadrage-config-"));
  t.after(() => fs.rmSync(maison, { recursive: true, force: true }));
  const fichier = path.join(maison, "web.env");
  fs.writeFileSync(
    fichier,
    `CC2CC_WEB_OPERATEUR=operateur\nCC2CC_WEB_CADRE_AUTORISE=${origines.join(" ")}\n`,
    { mode: 0o600 }
  );

  const reglages = auth.reglagesDeLaPorte({ fichier, env: {} });
  assert.deepEqual(reglages.cadreAutorise, origines, "la nouvelle clef suit bien le chemin web.env");
  assert.deepEqual(
    auth.reglagesDeLaPorte({
      fichier,
      env: { CC2CC_WEB_CADRE_AUTORISE: "https://priorite-env.example:8787" }
    }).cadreAutorise,
    ["https://priorite-env.example:8787"],
    "comme les autres clefs, l'ENV garde le dernier mot sur web.env"
  );
  assert.deepEqual(
    auth.reglagesDeLaPorte({
      fichier,
      env: {
        CC2CC_WEB_CADRE_AUTORISE: "https://alias-historique.example:8787",
        VALXOS_WEB_CADRE_AUTORISE: "https://nom-public.example:8787"
      }
    }).cadreAutorise,
    ["https://nom-public.example:8787"],
    "la clef VALXOS publique l'emporte sur l'alias CC2CC historique"
  );
  const entetes = await entetesPour(t, reglages.cadreAutorise);
  assert.equal(entetes["content-security-policy"], cspAttendue(origines.join(" ")));
  assert.equal(entetes["x-frame-options"], undefined, "DENY annulerait la liste chez les navigateurs qui le lisent");

  assert.match(sourceAuth, /CC2CC_WEB_CADRE_AUTORISE/, "l'alias historique reste accepté par la porte");
  assert.match(sourceAuth, /VALXOS_WEB_CADRE_AUTORISE/, "la clef publique du produit est nommée par la porte");
  assert.match(
    sourceLanceur,
    /ouvrirLaPorte\(\{ db, jeton, hote, port, operateur, cadreAutorise \}\)/,
    "le lanceur vivant transmet la liste au serveur — une fonction pure à côté ne suffit pas"
  );
});

test("C3 aucun joker ne peut ouvrir le cadrage", async (t) => {
  const controle = await entetesPour(t, "https://command-center.example:8787");
  assert.equal(
    controle["content-security-policy"],
    cspAttendue("https://command-center.example:8787"),
    "contrôle positif : la garde sait reconnaître une vraie ouverture"
  );

  for (const hostile of ["*", "http://*", "https://*:8787", "*.ts.net"]) {
    exigerLeVerrou(await entetesPour(t, hostile), `le joker ${JSON.stringify(hostile)}`);
  }
});

test("C4 point-virgule et caractères de contrôle invalident toute la directive", async (t) => {
  const controle = await entetesPour(t, "http://x https://bon.example:8787");
  assert.equal(
    controle["content-security-policy"],
    cspAttendue("http://x https://bon.example:8787"),
    "contrôle positif : la même garde accepte la liste avant d'éprouver l'injection"
  );
  const hostiles = [
    "http://x;",
    "http://x\nhttps://bon.example:8787",
    "http://x; script-src *"
  ];
  for (const hostile of hostiles) {
    exigerLeVerrou(await entetesPour(t, hostile), `l'injection ${JSON.stringify(hostile)}`);
  }
});

test("C5 une origine invalide au milieu invalide toute la liste", async (t) => {
  const controle = await entetesPour(t, "https://avant.example:8787 http://apres.example:8787");
  assert.equal(
    controle["content-security-policy"],
    cspAttendue("https://avant.example:8787 http://apres.example:8787"),
    "contrôle positif : la liste entière est acceptée quand chaque entrée est valide"
  );
  const valeur = "https://avant.example:8787 ftp://milieu.example:8787 http://apres.example:8787";
  exigerLeVerrou(await entetesPour(t, valeur), "la liste mêlant une origine invalide");

  for (const hostile of [
    "ftp://ailleurs.example:8787",
    "http://identifiant@porte.example:8787",
    "http://porte.example:8787/chemin",
    "http://porte.example:8787?requete=1",
    "http://porte.example:8787#fragment",
    "null",
    "'self'"
  ]) {
    exigerLeVerrou(await entetesPour(t, hostile), `la source interdite ${JSON.stringify(hostile)}`);
  }
});
