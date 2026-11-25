// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LE TRANSPORT DES TESTS DU RELAIS — l'autre Mac est un second bureau jetable.
//
// `transportLocal` est le transport ssh lui-même (src/lib/relais/transport-ssh.js),
// moins ssh : son `spawn` lance ICI la ligne exacte que ssh ferait lancer sur
// l'autre Mac (tout ce qui suit l'hôte : `env VALXOS_MESSENGER_HOME=<bureau>
// <node> <dépôt>/src/bin/relais.js echanger --de <moi>`). La vraie commande
// `echanger` tourne donc, avec la vraie ligne, et c'est cette ligne qui pose
// le bureau de l'autre Mac : aucun `CC2CC_V2_HOME` hérité ne viendrait cacher
// une ligne fausse. `SSH_CONNECTION` est posé, comme sous ssh ; la garde du
// bureau vivant aussi. Aucun ssh, aucun réseau.
//
// `coupure` fait le vrai échange (l'autre Mac a donc tout appliqué), puis
// perd la réponse : `code: "coupure-simulee"`, `fois` fois.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { transportSsh } from "../src/lib/relais/transport-ssh.js";
import { envPropre } from "./aide-env.js";

export const DEPOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SSH_CONNECTION = "10.0.0.1 50000 10.0.0.2 22";

// La ligne que ssh ferait lancer sur l'autre Mac, lancée ici.
function sansSsh(commande, args, options) {
  if (commande !== "ssh") throw new Error(`the test transport only replaces ssh (got ${commande})`);
  const distant = args.slice(args.indexOf("env"));
  return spawn(distant[0], distant.slice(1), {
    ...options,
    env: envPropre({ CC2CC_GARDE_BUREAU: "1", SSH_CONNECTION })
  });
}

export function transportLocal({ racines, moi, node = process.execPath, depot = DEPOT, timeoutMs = 60_000 }) {
  const parMac = new Map();
  const pour = (mac) => {
    if (!parMac.has(mac)) {
      const racine = racines[mac];
      if (!racine) throw new Error(`no test bureau for ${mac}`);
      parMac.set(mac, transportSsh(
        { ssh: "autre-mac", node, depot, bureau: racine },
        { moi, spawn: sansSsh, timeoutMs }
      ));
    }
    return parMac.get(mac);
  };
  return { echanger: async (mac, entree) => pour(mac).echanger(mac, entree) };
}

export function coupure(transport, { apres = "echanger", fois = 1 } = {}) {
  if (apres !== "echanger") throw new Error(`coupure only knows apres: "echanger" (got ${apres})`);
  let reste = fois;
  return {
    async echanger(mac, entree) {
      const reponse = await transport.echanger(mac, entree);
      if (reste > 0) {
        reste -= 1;
        const erreur = new Error("simulated cut: the other Mac answered, the answer was lost");
        erreur.code = "coupure-simulee";
        throw erreur;
      }
      return reponse;
    }
  };
}
