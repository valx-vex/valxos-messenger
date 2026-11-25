// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Test aid: logs every synchronous `fs` call aimed at a watched Claude Code
// house. Load it with `NODE_OPTIONS=--require <this file>` in a test process
// and every child it spawns.
//
//   ESPION_JOURNAL  file the accesses are appended to (required, else inert)
//   ESPION_CIBLES   path-delimited list of directories to watch; default: the
//                   `.claude` directory of the REAL account home
//                   (os.userInfo().homedir, which ignores $HOME) and of $HOME.
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { syncBuiltinESMExports } = require("node:module");

const journal = process.env.ESPION_JOURNAL;
const cibles = process.env.ESPION_CIBLES
  ? process.env.ESPION_CIBLES.split(path.delimiter).filter(Boolean)
  : [];
if (!process.env.ESPION_CIBLES) {
  try { cibles.push(path.join(os.userInfo().homedir, ".claude")); } catch { /* no account home */ }
  if (process.env.HOME) cibles.push(path.join(process.env.HOME, ".claude"));
}
const ecrire = fs.appendFileSync;

function noter(operation, cible) {
  try {
    const chemin = typeof cible === "string" ? cible : Buffer.isBuffer(cible) ? cible.toString() : cible instanceof URL ? cible.pathname : "";
    if (journal && cibles.some((c) => chemin === c || chemin.startsWith(c + path.sep))) {
      ecrire(journal, `${process.pid} ${operation} ${chemin}\n`);
    }
  } catch { /* the spy never breaks the process it watches */ }
}

for (const nom of ["readdirSync", "readFileSync", "statSync", "lstatSync", "existsSync", "openSync", "accessSync", "realpathSync"]) {
  const origine = fs[nom];
  if (typeof origine !== "function") continue;
  fs[nom] = function (cible, ...reste) { noter(nom, cible); return origine.call(this, cible, ...reste); };
}
syncBuiltinESMExports();
