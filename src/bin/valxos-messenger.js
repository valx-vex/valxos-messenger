#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
//
// valxos-messenger — the one-command entry point.
//
//   valxos-messenger install [--dry-run] [--force] [--no-enable]
//                            [--launchd | --launchd-load] [--operator NAME]
//   valxos-messenger uninstall
//   valxos-messenger doctor [--reap]
//   valxos-messenger --help
//
// This dispatcher keeps scripts/install.js as the implementation and
// exposes it under a single memorable name for `npx` and PATH use.
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { executer, sortir } from "./cli-common.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

const HELP = `valxos-messenger — durable local messaging for coding sessions

Usage:
  valxos-messenger install [--dry-run] [--force] [--no-enable]
                           [--launchd | --launchd-load] [--operator NAME]
      Install CLI links, plugin symlink, and (on request) the launchd plists.
      --dry-run        Show what would be done, change nothing.
      --force          Replace conflicting links and plists (backups kept).
      --no-enable      Skip 'claude plugin enable'.
      --launchd        Write the Facteur and web door plists under
                       ~/Library/LaunchAgents/ (macOS); load them by hand.
      --launchd-load   Write them and run 'launchctl bootstrap' on them.
      --operator NAME  With --launchd: pin the web door's operator in its plist
                       (it then takes precedence over web.env; without it
                       web.env decides).

  valxos-messenger uninstall [--dry-run] [--launchd-unload]
      Remove CLI links, plugin symlink, and the plists this installer wrote.
      Runtime data is preserved. Services still loaded in launchd (ours, and
      the legacy labels of earlier installs) are named, not stopped.
      --launchd-unload Also run 'launchctl bootout' on the services it names.

  valxos-messenger doctor [--reap]
      Run the health check. It reports and writes nothing by default.
      --reap           Mark dead chairs dead (an explicit gesture), then report.

  valxos-messenger --help
      Show this message.
`;

// UNE SEULE SORTIE (hygiène H2) : l'aide dépasse 512 octets, et un
// `process.exit()` juste après l'écrire la coupait à 512 sur n'importe quel
// tube (`valxos-messenger --help | less`). Le guichet rend un code — tout de
// suite pour l'aide et le refus, à la sortie de l'enfant pour les autres — et
// `executer()` (cli-common.js) sort une fois, après le drain.
//
// LE CODE DE L'ENFANT, TEL QUEL (hygiène H8) : `code ?? 0` rendait VERT un
// installeur tué par un signal, et sans écouteur `error` un enfant qui ne
// démarrait pas faisait mourir ce processus sur une exception non gérée.
// Un signal se nomme et sort 128 + son numéro (la convention du shell :
// SIGINT 130, SIGKILL 137, SIGTERM 143) ; un lancement impossible sort 2.
//
// LE NODE QUI TOURNE, JAMAIS CELUI DU PATH (F10, passe adverse, 28/09) : sous
// nvm, `npx -p node@X` ou un mélange Homebrew/système, `spawn("node")` lançait
// l'installeur et le doctor sous un autre Node que celui qui a construit
// better-sqlite3 — et sans node sur le PATH, ils ne démarraient pas.
function lancerEnfant(script, args) {
  const cheminDuScript = path.join(root, script);
  const child = spawn(process.execPath, [cheminDuScript, ...args], {
    stdio: "inherit",
    cwd: root
  });
  return new Promise((resolve) => {
    let rendu = false;
    const rendre = (code) => {
      if (rendu) return;
      rendu = true;
      resolve(code);
    };
    child.on("error", (erreur) => {
      process.stderr.write(`valxos-messenger: could not start ${process.execPath} ${cheminDuScript}: ${erreur.message}\n`);
      rendre(2);
    });
    child.on("exit", (code, signal) => {
      if (signal) {
        const numero = os.constants.signals[signal];
        process.stderr.write(`valxos-messenger: ${script} was killed by ${signal}\n`);
        rendre(typeof numero === "number" ? 128 + numero : 1);
        return;
      }
      rendre(code ?? 1);
    });
  });
}

function guichet() {
  const subcommand = process.argv[2];
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    process.stdout.write(HELP);
    return 0;
  }
  // Les arguments voyagent jusqu'au médecin, qui tranche lui-même (`--reap`, ou
  // un refus nommé, exit 2) : une liste vide ici rendait `doctor --reap` sans
  // moisson et `doctor --bogus` vert (A11, revue qualité Q2, 18/10).
  if (subcommand === "doctor") return lancerEnfant("src/bin/valxos-doctor.js", process.argv.slice(3));
  if (subcommand === "install" || subcommand === "uninstall") {
    const args = process.argv.slice(3);
    if (subcommand === "uninstall") args.unshift("--uninstall");
    return lancerEnfant("scripts/install.js", args);
  }
  // Un jeton qui est un drapeau se dit drapeau, pas sous-commande (Q11).
  const quoi = subcommand.startsWith("-") ? "flag" : "subcommand";
  return sortir(2, `Unknown ${quoi}: ${subcommand}\n\n${HELP.replace(/\n$/, "")}`);
}

await executer(guichet);
