// Le moniteur orphelin (16/11/2026). Vu ce jour :
// la tâche du harnais qui portait le moniteur est morte (« exit 144 »), mais le
// python a survécu, rattaché au processus 1. Il gardait le socket de la lignée,
// écrivait ses annonces dans une sortie que plus personne ne lisait, et
// répondait « réveil ok » au Facteur. Un second moniteur refusait de démarrer
// (exit 3). Rien n'était perdu (la remise passe par les crochets), mais
// l'alerte en direct était morte sans que personne le sache.
//
// La règle : le moniteur note son parent au démarrage. Si ce parent change
// (il est rattaché à un autre processus), plus personne ne lit sa sortie : il
// s'arrête proprement, libère le socket et le dit dans son journal.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { envPropre, poserLeBureau } from "./aide-env.js";

const repo = path.resolve(new URL("..", import.meta.url).pathname);

function attendre(predicat, delaiMs = 8000) {
  return new Promise((resolve, reject) => {
    const debut = Date.now();
    const minuteur = setInterval(() => {
      if (predicat()) {
        clearInterval(minuteur);
        resolve();
      } else if (Date.now() - debut > delaiMs) {
        clearInterval(minuteur);
        reject(new Error("délai dépassé"));
      }
    }, 50);
  });
}

function vivant(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function lignesDuJournal(root, agent) {
  try {
    return fs.readFileSync(path.join(root, "logs", `${agent}.log`), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

test("un moniteur dont le parent meurt s'arrête proprement et libère le socket de la lignée", { timeout: 30000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-v2-orphelin-"));
  poserLeBureau(root);
  const maison = path.join(root, "maison");
  fs.mkdirSync(path.join(maison, "sessions"), { recursive: true });
  const agent = "orphelin-sonde";
  const socket = path.join(root, "run", `${agent}.sock`);

  // Le parent intermédiaire joue la tâche du harnais : il lance le moniteur,
  // dit son numéro, puis attend sur son entrée jusqu'à ce qu'on le tue.
  const parent = spawn("bash", ["-c", `python3 "$1" >/dev/null 2>&1 & echo $!; read _`, "_", path.join(repo, "src/monitor/valxos_monitor.py")], {
    env: { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_SELF: agent, VALXOS_SELF: agent, CLAUDE_CONFIG_DIR: maison },
    stdio: ["pipe", "pipe", "ignore"]
  });
  let sortie = "";
  parent.stdout.on("data", (c) => { sortie += c.toString(); });
  await attendre(() => /^\d+\n/.test(sortie));
  const pidMoniteur = Number(sortie.trim());
  t.after(() => {
    if (vivant(pidMoniteur)) process.kill(pidMoniteur, "SIGKILL");
    if (parent.exitCode === null) parent.kill("SIGKILL");
  });

  await attendre(() => lignesDuJournal(root, agent).some((l) => l.message === "monitor started"));
  assert.ok(fs.existsSync(socket), "le moniteur tient le socket de la lignée");

  parent.kill("SIGKILL"); // la tâche du harnais meurt ; le moniteur est rattaché ailleurs
  await attendre(() => !vivant(pidMoniteur));

  assert.ok(!fs.existsSync(socket), "le socket est libéré : un moniteur neuf pourra le prendre");
  const journal = lignesDuJournal(root, agent);
  assert.ok(journal.some((l) => l.message === "monitor orphaned"), `le journal le dit : ${JSON.stringify(journal.map((l) => l.message))}`);
});
