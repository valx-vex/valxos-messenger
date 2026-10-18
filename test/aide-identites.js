// LES IDENTITÉS À NE PAS PUBLIER NE S'ÉCRIVENT PAS — ELLES SE DÉCOUVRENT.
//
// La garde d'identité listait les noms en clair : le prénom de l'opérateur, le
// nom de la machine. Le propriétaire a inspecté le dépôt public et y a trouvé
// son propre prénom — DANS LA GARDE CENSÉE L'INTERDIRE.
//
// C'est le défaut le plus retors de la semaine, parce qu'il est logiquement
// correct : la ligne est une assertion NÉGATIVE, elle interdit ce qu'elle
// nomme, la garde l'exempte à juste titre. Mais `grep <prénom>` sur le dépôt
// public le trouve quand même. **UNE GARDE NE PEUT PAS S'ATTRAPER ELLE-MÊME.**
//
// Le remède facile aurait été d'obscurcir le mot (codes de caractères, morceaux
// concaténés). On ne l'a pas pris : dans un dépôt public, un motif illisible est
// une garde que personne ne pourra relire ni corriger. On a préféré changer la
// NATURE de la liste.
//
// Les identités sont maintenant DÉRIVÉES DE LA MACHINE QUI LANCE LE TEST :
// nom de compte, nom d'hôte et ses labels, chemin du domicile, le nom
// d'opérateur configuré s'il existe, le réseau privé tel que `tailscale status`
// le décrit (cette machine, son nom DNS, ses adresses, ses pairs), et ce que
// l'opérateur ajoute dans un fichier LOCAL, NON SUIVI et gitignoré :
// `test/.identites-locales.json` (un tableau de chaînes). Aucun nom propre
// n'est écrit nulle part. Conséquence heureuse : la garde marche pour
// n'importe qui, sur n'importe quelle machine — elle protégeait UN humain
// nommé, elle protège maintenant celui qui l'exécute.
//
// La garde de classe (test/class-guard.test.js) portait encore ses identités
// en MORCEAUX concaténés (rev-t8, 29/08) — exactement le remède facile refusé
// ci-dessus, et n'importe quel lecteur les recomposait. Elle lit ici, comme
// les autres. Une seule vérité.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Ce qui est trop court ou trop commun ne peut pas être cherché sans noyer le
// rapport sous les faux positifs (« vex », « m3 », « ci »…).
const ASSEZ_LONG = 4;

// Les labels d'hôte qui ne nomment personne.
const LABELS_GENERIQUES = new Set(["local", "localhost", "lan", "home", "internal", "ts", "net"]);

export const FICHIER_LOCAL_PAR_DEFAUT = path.join(path.dirname(fileURLToPath(import.meta.url)), ".identites-locales.json");

// Ce que `tailscale status --json` sait de ce réseau : cette machine, son nom
// DNS et ses labels (nom de machine, nom de tailnet), ses adresses, et chaque
// pair. Sans tailscale, ou sans démon, il n'y a rien — ce n'est pas un échec.
function identitesTailscale(env) {
  let etat;
  try {
    const brut = execFileSync("tailscale", ["status", "--json"], {
      timeout: 3000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { PATH: `${env.PATH || ""}:/opt/homebrew/bin:/usr/local/bin:/Applications/Tailscale.app/Contents/MacOS:/usr/bin:/bin` }
    });
    etat = JSON.parse(brut);
  } catch {
    return [];
  }
  // `JSON.parse` rend volontiers `null` ou un nombre : pas un état, rien à lire.
  if (!etat || typeof etat !== "object") return [];
  const trouvees = [];
  const noeud = (n, quoi) => {
    if (!n || typeof n !== "object") return;
    trouvees.push([n.HostName, `le nom ${quoi} sur le réseau privé`]);
    const dns = String(n.DNSName || "").replace(/\.$/, "");
    if (dns) {
      trouvees.push([dns, `le nom DNS ${quoi} sur le réseau privé`]);
      for (const label of dns.split(".")) trouvees.push([label, `un label du nom DNS ${quoi} sur le réseau privé`]);
    }
    for (const ip of n.TailscaleIPs || []) trouvees.push([ip, `une adresse ${quoi} sur le réseau privé`]);
  };
  noeud(etat.Self, "de cette machine");
  trouvees.push([etat.MagicDNSSuffix, "le nom du réseau privé"]);
  for (const pair of Object.values(etat.Peer || {})) noeud(pair, "d'un pair");
  return trouvees;
}

function identitesDuFichierLocal(fichier) {
  try {
    const liste = JSON.parse(fs.readFileSync(fichier, "utf8"));
    return Array.isArray(liste) ? liste.map((v) => [v, "une identité déclarée dans le fichier local"]) : [];
  } catch {
    return []; // absent, ou illisible : rien à découvrir ici
  }
}

function lireLOperateurConfigure() {
  // Le nom de l'opérateur vit HORS du dépôt, avec le jeton. Sur une machine où
  // la porte n'est pas installée, il n'y a rien à découvrir — et c'est une
  // information, pas un échec : un clone neuf n'a aucune identité à fuir.
  const maisons = [".valxos-messenger", ".cc2cc-v2"];
  for (const maison of maisons) {
    const f = path.join(os.homedir(), maison, "web.env");
    try {
      const m = fs.readFileSync(f, "utf8").match(/^(?:VALXOS|CC2CC)_WEB_OPERATEUR=(.+)$/m);
      if (m) return m[1].trim();
    } catch { /* absente : rien à découvrir ici */ }
  }
  return null;
}

// LE MODE CI (Run 6, ruling 10). Dans GitHub Actions, le compte est
// « runner », le domicile est celui du runner et la machine est jetable : ce
// ne sont pas des identités de la maison, et chercher « runner » dans l'arbre
// accusait chaque commentaire sur le runner de `node --test` (19 fuites
// fantômes, main rouge le 27/09). Le mode s'allume à DEUX conditions : il est
// demandé (`VALXOS_GARDES_MODE=ci`, posé par le workflow) ET GitHub Actions
// tourne (`GITHUB_ACTIONS=true`, posé par le runner). Une seule des deux,
// posée par erreur sur une machine de la maison, laisse les gardes entières.
export function modeCI(env = process.env) {
  return env.VALXOS_GARDES_MODE === "ci" && env.GITHUB_ACTIONS === "true";
}

// Chaque identité rend son MOTIF (avec frontières), ce qu'elle est (`quoi`),
// sa VALEUR brute — pour qui doit prouver qu'un fichier ne la porte pas même
// en morceaux — et sa SOURCE (compte, machine, domicile, operateur, tailscale,
// fichier), pour que le champ couvert se voie. `env` sert au PATH de
// `tailscale` (les tests y mettent un démon de carton) et au mode CI.
export function identitesDeCetteMachine({ fichierLocal = FICHIER_LOCAL_PAR_DEFAUT, env = process.env } = {}) {
  const trouvees = [];
  const vues = new Set();
  const ajouter = (valeur, quoi, source) => {
    const v = String(valeur || "").trim();
    if (v.length < ASSEZ_LONG) return;
    if (LABELS_GENERIQUES.has(v.toLowerCase())) return;
    if (vues.has(v.toLowerCase())) return;
    vues.add(v.toLowerCase());
    // ⚠️ AVEC SES FRONTIÈRES, SINON LA SONDE MORD SUR LE PRODUIT LUI-MÊME.
    // Mesuré : le nom de compte de cette machine est une SOUS-CHAÎNE du nom du
    // produit — la garde accusait `package.json`, la CI et le README de fuiter
    // une identité, alors qu'ils écrivaient simplement le nom du logiciel.
    // C'est la même faute qu'un motif qui comptait 23 fois un nom de famille et
    // trouvait en réalité le futur du verbe « passer » : un mot cherché sans sa
    // frontière n'est pas un motif, c'est un piège à faux positifs.
    const echappe = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    trouvees.push({ motif: new RegExp(`(?<![\\w-])${echappe}(?![\\w-])`, "i"), quoi, valeur: v, source });
  };
  if (!modeCI(env)) {
    // CI (ruling 10) : le compte « runner » est celui de GitHub, pas de la maison
    ajouter(os.userInfo().username, "le nom de compte de cette machine", "compte");
    for (const label of os.hostname().split(".")) ajouter(label, "un label du nom de cette machine", "machine");
    ajouter(os.homedir(), "le chemin du domicile de cette machine", "domicile");
  }
  ajouter(lireLOperateurConfigure(), "le nom de l'opérateur configuré ici", "operateur");
  for (const [valeur, quoi] of identitesTailscale(env)) ajouter(valeur, quoi, "tailscale");
  for (const [valeur, quoi] of identitesDuFichierLocal(fichierLocal)) ajouter(valeur, quoi, "fichier");
  return trouvees;
}

// Les noms du REGISTRE local (lignées et noms de session), en lecture seule et
// hors dépôt — pour qui veut voir ce qu'une liste tirée du registre attraperait.
// Ce n'est PAS une source par défaut des gardes : mesuré le 29/08, ces noms
// sont aussi le vocabulaire d'exemple documenté du produit et l'attribution de
// son auteur (un seul nom vit dans 30 fichiers). Sans registre, rien.
export function nomsDuRegistreLocal() {
  let Database;
  try {
    Database = createRequire(import.meta.url)("better-sqlite3");
  } catch {
    return [];
  }
  const noms = new Set();
  for (const maison of [".valxos-messenger", ".cc2cc-v2"]) {
    const fichier = path.join(os.homedir(), maison, "broker.db");
    if (!fs.existsSync(fichier)) continue;
    let db = null;
    try {
      db = new Database(fichier, { readonly: true, fileMustExist: true });
      for (const { id } of db.prepare("SELECT DISTINCT id FROM peers").all()) noms.add(String(id).split("#")[0]);
      for (const { session_name } of db.prepare("SELECT DISTINCT session_name FROM peers WHERE session_name IS NOT NULL").all()) {
        noms.add(String(session_name));
      }
    } catch { /* un registre qu'on ne sait pas lire ne nomme personne */ } finally {
      try { db?.close(); } catch { /* déjà fermé */ }
    }
  }
  return [...noms].filter((n) => n.length >= ASSEZ_LONG).sort();
}

// Les formes GÉNÉRIQUES n'exposent personne : elles décrivent une FAMILLE de
// secrets, pas un secret. Elles peuvent donc rester écrites en clair.
export const FORMES_PRIVEES = [
  [/\/Users\/[a-z][a-z0-9_-]*/i, "un chemin révélant un nom de compte"],
  [/[a-z0-9-]+\.ts\.net/i, "un nom d'hôte de réseau privé"]
];
