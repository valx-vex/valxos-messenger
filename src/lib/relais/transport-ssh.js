// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LE TRANSPORT SSH DU RELAIS — un appel `valxos-relais echanger` sur l'autre
// Mac, par ssh, et rien d'autre.
//
// Chaque échange lance UN ssh, sur SA connexion :
//   ssh -o BatchMode=yes -o ConnectTimeout=5 -o ControlMaster=no
//       <hôte> env VALXOS_MESSENGER_HOME=<bureau> <node> <dépôt>/src/bin/relais.js echanger --de <moi>
// Le JSON entre par l'entrée standard et revient par la sortie.
//
// R36 : AUCUNE CONNEXION PARTAGÉE (`ControlMaster=no`, ni `ControlPath` ni
// `ControlPersist`). Mesuré le 17/11 entre deux vrais Macs, par Tailscale SSH :
// avec un maître de connexion, ssh sortait parfois en 255 alors que la commande
// de là-bas avait fini (sa sortie complète, stderr vide) — 16 échanges sur 270,
// lus comme `mac-injoignable` d'un Mac éveillé ; sans maître, 0 sur 210. Le
// prix est une poignée de main par tournée (environ 0,4 s).
//
// ssh colle les mots qui suivent l'hôte avec des espaces, et le shell de
// l'autre Mac (zsh) les relit : un chemin avec une espace serait coupé, un `$`
// ou un `~` serait développé (le `~` après un `=` ne l'est pas sous zsh : il
// ouvrirait un bureau dans un dossier nommé `~`). On refuse donc ces mots ICI,
// à la construction, en nommant le défaut, plutôt qu'un échec à distance que
// personne ne saurait lire. Un hôte qui commence par `-` serait lu par ssh
// comme une option.
//
// Les erreurs : ssh qui n'atteint pas l'autre Mac (sa sortie 255 : connexion
// refusée, délai, Mac éteint ou endormi, clé non autorisée là-bas — « Permission
// denied » dans le détail) lève `mac-injoignable` (R22) ; une
// autre sortie non nulle de la commande de là-bas lève `relais-distant-echanger`,
// avec la fin de stderr (son `code: message`) ; la commande
// absente de l'autre Mac — code 127 (le shell ne la trouve pas), ou un dépôt
// d'avant le relais où node ne trouve pas `src/bin/relais.js` — lève
// `relais-absent-de-l-autre-mac` ; une sortie qui n'est pas du JSON lève
// `paquet-illisible` ; un échange plus long que `timeoutMs` est arrêté et lève
// `relais-delai-depasse`. Une erreur du lancement (ssh absent d'ici) remonte
// telle quelle. Dans tous ces cas, la tournée ne marque rien.
import { spawn as spawnReel } from "node:child_process";
import path from "node:path";

export const DELAI_PAR_DEFAUT_MS = 15_000;
// La fin de stderr qu'on garde (et qu'on cite) : la commande de là-bas écrit
// une ligne `code: message` ; une pile de node tient dans cette fenêtre.
const FIN_DE_STDERR = 4000;
// Ce que le shell de l'autre Mac relit sans le couper ni le développer.
const MOT_SUR = /^[A-Za-z0-9_./:@%+=,-]+$/;
const CHEMINS = ["node", "depot", "bureau"];

function erreurDuTransport(code, message) {
  const erreur = new Error(message);
  erreur.code = code;
  return erreur;
}

const invalide = (message) => erreurDuTransport("config-relais-invalide", `invalid relais.json: ${message}`);

function exigerUnMotSur(mot, role) {
  if (typeof mot !== "string" || !MOT_SUR.test(mot)) {
    throw invalide(`${role} ${JSON.stringify(mot)} would be split or expanded by the other Mac's shell (allowed: letters, digits and _ . / : @ % + = , -)`);
  }
  return mot;
}

/**
 * Le transport d'UN Mac de `relais.json` (`configMac` : `{ ssh, node, depot, bureau }`).
 * Rend `{ echanger(mac, entree) }`, qui rend la réponse de l'autre Mac,
 * `{ resume, paquet }`, telle quelle (la tournée la vérifie). `mac` n'est que
 * le nom que la tournée lui donne : ce transport ne joint que `configMac`.
 */
export function transportSsh(configMac, { moi, spawn = spawnReel, timeoutMs = DELAI_PAR_DEFAUT_MS } = {}) {
  if (!configMac || typeof configMac !== "object") throw invalide("the Mac to reach must be an object");
  const hote = exigerUnMotSur(configMac.ssh, "`ssh`");
  if (hote.startsWith("-")) throw invalide(`\`ssh\` ${JSON.stringify(hote)} would be read by ssh as an option`);
  for (const clef of CHEMINS) {
    exigerUnMotSur(configMac[clef], `\`${clef}\``);
    if (!configMac[clef].startsWith("/")) throw invalide(`\`${clef}\` must be an absolute path (${JSON.stringify(configMac[clef])})`);
  }
  exigerUnMotSur(moi, "this Mac's name (`moi`)");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw invalide(`timeoutMs must be a positive number (${JSON.stringify(timeoutMs)})`);

  const script = path.posix.join(configMac.depot, "src/bin/relais.js");
  const args = [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=5",
    "-o", "ControlMaster=no",
    hote,
    "env", `VALXOS_MESSENGER_HOME=${configMac.bureau}`, configMac.node, script, "echanger", "--de", moi
  ];
  return {
    echanger: (_mac, entree) => echangerParSsh({ spawn, args, entree, timeoutMs, hote, script })
  };
}

/**
 * Les transports de tous les Macs de `config.macs`, sous un seul `echanger` :
 * celui que la veille donne à la tournée. Un Mac absent de `relais.json` ne
 * lance rien.
 */
export function transportsSsh(config, { spawn = spawnReel, timeoutMs = DELAI_PAR_DEFAUT_MS } = {}) {
  const parMac = new Map(
    Object.entries(config.macs).map(([nom, mac]) => [nom, transportSsh(mac, { moi: config.moi, spawn, timeoutMs })])
  );
  return {
    async echanger(mac, entree) {
      const transport = parMac.get(mac);
      if (!transport) throw invalide(`no Mac ${JSON.stringify(mac)} in relais.json`);
      return transport.echanger(mac, entree);
    }
  };
}

function echangerParSsh({ spawn, args, entree, timeoutMs, hote, script }) {
  return new Promise((resolve, reject) => {
    let fini = false;
    let minuteur = null;
    const finir = (erreur, valeur) => {
      if (fini) return;
      fini = true;
      clearTimeout(minuteur);
      if (erreur) reject(erreur);
      else resolve(valeur);
    };

    let enfant;
    try {
      enfant = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (erreur) {
      finir(erreur);
      return;
    }
    const sortie = [];
    let erreurs = "";
    minuteur = setTimeout(() => {
      try {
        enfant.kill("SIGTERM");
      } catch {
        /* déjà parti */
      }
      finir(erreurDuTransport("relais-delai-depasse", `the exchange with ${hote} did not finish within ${timeoutMs} ms; nothing was marked`));
    }, timeoutMs);

    enfant.on("error", (erreur) => finir(erreur));
    enfant.stdout.on("data", (morceau) => sortie.push(morceau));
    enfant.stderr.on("data", (morceau) => {
      erreurs = (erreurs + morceau).slice(-FIN_DE_STDERR);
    });
    enfant.on("close", (code, signal) => {
      const fin = erreurs.trim();
      if (code === 0) {
        try {
          finir(null, JSON.parse(Buffer.concat(sortie).toString("utf8")));
        } catch (erreur) {
          finir(erreurDuTransport("paquet-illisible", `the answer of ${hote} is not valid JSON (${erreur.message})`));
        }
        return;
      }
      // R22 : 255 est le code de ssh lui-même (connexion refusée, délai de
      // connexion, hôte éteint ou endormi, clé refusée) — la commande de là-bas
      // ne sort qu'en 0 à 3. Un Mac qui dort : la lettre attend.
      if (code === 255) {
        finir(erreurDuTransport("mac-injoignable", `ssh could not reach ${hote}: ${fin}`));
        return;
      }
      if (code === 127 || erreurs.includes(`Cannot find module '${script}'`)) {
        finir(erreurDuTransport(
          "relais-absent-de-l-autre-mac",
          `valxos-relais cannot be started on ${hote} (${script}): update the Messenger there. ${fin}`
        ));
        return;
      }
      finir(erreurDuTransport(
        "relais-distant-echanger",
        `valxos-relais echanger on ${hote} exited with ${code ?? signal}: ${fin}`
      ));
    });
    // Un autre Mac qui sort avant d'avoir tout lu ferme le tube : c'est son
    // code de sortie qui dit pourquoi, pas cette écriture.
    enfant.stdin.on("error", () => {});
    enfant.stdin.end(JSON.stringify(entree));
  });
}
