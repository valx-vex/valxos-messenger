// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// La tournée : trouver les boîtes aux lettres vivantes de chaque maison.
// Aucune boîte vivante n'est touchée ici : chaque test monte SES propres
// fausses boîtes dans un répertoire temporaire.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import {
  CODE_SONDE_OCCUPEE,
  DELAI_SONDE_MS,
  MARGE_SONDE_MS,
  isEntryAlive,
  isKnownHouse,
  isProcessAlive,
  keyFileName,
  listMailboxes,
  procStartOf,
  readDeliveryToken,
  readMailboxEntry,
  sessionsDir,
  sonderLaBoite,
  tourHouses
} from "../src/lib/postbox.js";

const MODULE_URL = new URL("../src/lib/postbox.js", import.meta.url).href;

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

// Une fiche de carton : le contenu qu'on veut, et une stat qui dit « c'est
// bien un fichier, de cette taille-là ». La lecture REGARDE la fiche avant de
// l'avaler ; une fiche de carton doit donc savoir se laisser regarder.
function ficheDeCarton(contenu) {
  const raw = typeof contenu === "string" ? contenu : JSON.stringify(contenu);
  return {
    readFileSync: () => raw,
    lstatSync: () => ({ isFile: () => true, size: Buffer.byteLength(raw, "utf8") })
  };
}

// Le décor se démonte : une suite qui laisse traîner ses maisons de carton
// finit par en laisser des milliers.
const decors = [];
function decorJetable(prefixe) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefixe));
  decors.push(dir);
  return dir;
}
after(() => {
  for (const dir of decors) fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- l'adresse

test("le nom du fichier de clé est déterministe (sha256 du chemin résolu)", () => {
  // Empreinte vérifiée à la main sur la machine (recon-socket-natif.md §3)
  assert.equal(
    keyFileName(12980, "/tmp/cc-socks/12980.sock"),
    "12980.fbccf38ca32b2970c4a6f5b9c58b0ae66b0dd3c777911773b1015599ddd7ec77.key"
  );
});

test("le nom du fichier de clé se calcule sur le chemin RÉSOLU, pas sur le chemin écrit", () => {
  assert.equal(
    keyFileName(12980, "/tmp/cc-socks/../cc-socks/12980.sock"),
    keyFileName(12980, "/tmp/cc-socks/12980.sock")
  );
});

test("le registre d'une maison vit dans son sous-répertoire sessions/", () => {
  assert.equal(sessionsDir("/maisons/work"), path.join("/maisons/work", "sessions"));
});

// ------------------------------------------------------- lire une fiche

test("une fiche de registre illisible rend null, jamais une exception", () => {
  assert.equal(readMailboxEntry("/x/sessions/1.json", ficheDeCarton("{ pas du json")), null);
});

test("une fiche absente rend null, jamais une exception, et n'est même pas ouverte", () => {
  let ouverte = false;
  const deps = {
    lstatSync: () => {
      const err = new Error("ENOENT");
      err.code = "ENOENT";
      throw err;
    },
    readFileSync: () => {
      ouverte = true;
      return "{}";
    }
  };
  assert.equal(readMailboxEntry("/x/sessions/1.json", deps), null);
  assert.equal(ouverte, false, "une fiche qu'on ne peut pas regarder ne s'ouvre pas");
});

test("une fiche sans chemin de boîte est ignorée", () => {
  assert.equal(
    readMailboxEntry("/x/sessions/7.json", ficheDeCarton({ pid: 7, sessionId: "s" })),
    null
  );
});

test("un chemin de boîte qui n'est pas du texte n'est pas une adresse", () => {
  for (const adresse of [42, ["/s"], { path: "/s" }, true]) {
    assert.equal(
      readMailboxEntry(
        "/x/sessions/7.json",
        ficheDeCarton({ pid: 7, sessionId: "s", messagingSocketPath: adresse })
      ),
      null,
      `adresse refusée: ${JSON.stringify(adresse)}`
    );
  }
});

test("une fiche sans numéro de processus utilisable est ignorée", () => {
  assert.equal(
    readMailboxEntry(
      "/x/sessions/7.json",
      ficheDeCarton({ pid: "sept", sessionId: "s", messagingSocketPath: "/s" })
    ),
    null
  );
});

// 0 désigne le GROUPE de processus tout entier et 1 le premier-né du système :
// ni l'un ni l'autre n'est une boîte aux lettres. Le programme qui tient les
// registres pose exactement la même borne (`function rw(e){if(e<=1)return!1;…}`).
test("un numéro de processus impossible n'ouvre aucune boîte", () => {
  for (const pid of [0, 1, -1, 1.5, "7", null, undefined]) {
    assert.equal(
      readMailboxEntry(
        "/x/sessions/7.json",
        ficheDeCarton({ pid, sessionId: "s", messagingSocketPath: "/s" })
      ),
      null,
      `numéro refusé: ${String(pid)}`
    );
  }
  assert.ok(
    readMailboxEntry(
      "/x/sessions/7.json",
      ficheDeCarton({ pid: 2, sessionId: "s", messagingSocketPath: "/s" })
    ),
    "un numéro plausible reste une fiche lisible"
  );
});

test("une fiche sans session est ignorée (sans elle, pas de verrou d'incarnation)", () => {
  assert.equal(
    readMailboxEntry("/x/sessions/7.json", ficheDeCarton({ pid: 7, messagingSocketPath: "/s" })),
    null
  );
});

test("une fiche démesurée est écartée au lieu d'être avalée (plafond de lecture)", () => {
  const enorme = {
    pid: 7,
    sessionId: "s",
    messagingSocketPath: "/s",
    bavardage: "x".repeat(300000)
  };
  assert.equal(readMailboxEntry("/x/sessions/7.json", ficheDeCarton(enorme)), null);
});

// « Écarter au lieu d'avaler » n'est pas une manière de parler : on REGARDE la
// fiche (taille et nature) avant de l'ouvrir. Le programme natif fait de même
// (`lstat` → `!isFile() || size > t` → rien).
test("une fiche démesurée n'est pas seulement rejetée : elle n'est jamais ouverte", () => {
  const maison = decorJetable("maison-");
  const fichier = path.join(maison, "7.json");
  fs.writeFileSync(
    fichier,
    JSON.stringify({ pid: 7, sessionId: "s", messagingSocketPath: "/s", bavardage: "x".repeat(300000) })
  );
  let ouverte = false;
  const resultat = readMailboxEntry(fichier, {
    readFileSync: (...args) => {
      ouverte = true;
      return fs.readFileSync(...args);
    }
  });
  assert.equal(resultat, null);
  assert.equal(ouverte, false, "une fiche trop lourde s'écarte AVANT d'être avalée");
});

// Le regard porté sur la fiche peut être trompé (fiche qui grossit entre le
// regard et la lecture, stat fournie par un appelant) : la seconde ceinture
// pèse ce qu'on a réellement avalé.
test("une fiche qui ment sur son poids est écartée quand même", () => {
  const enorme = JSON.stringify({
    pid: 7,
    sessionId: "s",
    messagingSocketPath: "/s",
    bavardage: "x".repeat(300000)
  });
  assert.equal(
    readMailboxEntry("/x/sessions/7.json", {
      lstatSync: () => ({ isFile: () => true, size: 12 }),
      readFileSync: () => enorme
    }),
    null
  );
});

test("un répertoire nommé comme une fiche n'est pas une fiche", () => {
  const maison = decorJetable("maison-");
  fs.mkdirSync(path.join(maison, "7.json"));
  assert.equal(readMailboxEntry(path.join(maison, "7.json")), null);
});

// Un tube nommé glissé dans un registre est le piège qui FIGE une tournée :
// l'ouvrir en lecture attend un écrivain, pour toujours, et la tournée est
// synchrone. On le prouve dans un processus à part, sous couperet — si la
// garde saute, l'enfant ne rend jamais la main et le test rougit au lieu de
// figer la suite entière.
test("un tube nommé glissé dans le registre n'arrête jamais la tournée", () => {
  const maison = decorJetable("maison-");
  const tube = path.join(maison, "999.json");
  childProcess.execFileSync("/usr/bin/mkfifo", [tube]);

  const source = [
    `import(${JSON.stringify(MODULE_URL)}).then((m) => {`,
    `  const r = m.readMailboxEntry(${JSON.stringify(tube)});`,
    '  process.stdout.write(r === null ? "ECARTE" : "AVALE");',
    "});"
  ].join("");

  let sortie;
  try {
    sortie = String(
      childProcess.execFileSync(process.execPath, ["--input-type=module", "-e", source], {
        timeout: 4000,
        stdio: ["ignore", "pipe", "ignore"]
      })
    );
  } catch (err) {
    assert.fail(
      `la lecture du tube n'a jamais rendu la main (${err?.signal || err?.code}) : ` +
        "la fiche a été avalée au lieu d'être regardée"
    );
  }
  assert.equal(sortie, "ECARTE");
});

test("une fiche complète est rendue telle quelle", () => {
  const fiche = {
    pid: 12980,
    sessionId: "35e98d0b",
    procStart: "Thu Aug 13 06:04:14 2026",
    messagingSocketPath: "/tmp/cc-socks/12980.sock",
    name: "atelier",
    kind: "interactive",
    status: "busy"
  };
  assert.deepEqual(readMailboxEntry("/x/sessions/12980.json", ficheDeCarton(fiche)), fiche);
});

test("une fiche lue sur un vrai disque n'a besoin d'aucune dépendance injectée", () => {
  const maison = decorJetable("maison-");
  const fichier = path.join(maison, "111.json");
  fs.writeFileSync(
    fichier,
    JSON.stringify({ pid: 111, sessionId: "aaa", messagingSocketPath: "/s" })
  );
  assert.equal(readMailboxEntry(fichier).pid, 111);
  assert.equal(readMailboxEntry(path.join(maison, "jamais-ecrite.json")), null);
  fs.rmSync(maison, { recursive: true, force: true });
});

// ------------------------------------------------------- la vivacité
// Deux preuves exigées : le processus existe ET c'est le MÊME processus.
// Un numéro de processus se recycle ; une fiche périmée + un numéro recyclé
// livreraient le courrier à la mauvaise personne.

test("un numéro de processus recyclé ne passe pas pour vivant (heure de démarrage discordante)", () => {
  const entry = {
    pid: 42,
    procStart: "Thu Aug 13 06:04:14 2026",
    messagingSocketPath: "/s",
    sessionId: "s"
  };
  const deps = { isProcessAlive: () => true, procStartOf: () => "Thu Aug 13 09:12:00 2026" };
  assert.equal(isEntryAlive(entry, deps), false);
});

test("un processus mort ne passe pas pour vivant même si l'heure de démarrage concorde", () => {
  const entry = { pid: 42, procStart: "X", messagingSocketPath: "/s", sessionId: "s" };
  const deps = { isProcessAlive: () => false, procStartOf: () => "X" };
  assert.equal(isEntryAlive(entry, deps), false);
});

test("processus vivant ET heure de démarrage concordante = vivant", () => {
  const entry = { pid: 42, procStart: "X", messagingSocketPath: "/s", sessionId: "s" };
  const deps = { isProcessAlive: () => true, procStartOf: () => "X" };
  assert.equal(isEntryAlive(entry, deps), true);
});

test("les espaces de /bin/ps ne font pas mentir la concordance", () => {
  const entry = {
    pid: 42,
    procStart: "Thu Aug 13 06:04:14 2026",
    messagingSocketPath: "/s",
    sessionId: "s"
  };
  const deps = {
    isProcessAlive: () => true,
    procStartOf: () => "Thu Aug 13  06:04:14 2026    \n"
  };
  assert.equal(isEntryAlive(entry, deps), true);
});

test("l'heure de démarrage introuvable (ps muet) ne s'invente pas : la boîte est écartée", () => {
  const entry = { pid: 42, procStart: "X", messagingSocketPath: "/s", sessionId: "s" };
  let sondee = false;
  const deps = {
    isProcessAlive: () => true,
    procStartOf: () => null,
    sonderLaBoite: () => {
      sondee = true;
      return true;
    }
  };
  assert.equal(isEntryAlive(entry, deps), false);
  assert.equal(sondee, false, "une fiche qui a une heure de démarrage ne se rattrape pas à la sonde");
});

// Amendement A5 : la fiche SANS heure de démarrage n'est plus exclue à l'aveugle.
// On ne devine pas — on sonde, comme le client officiel, et brièvement.

test("fiche sans heure de démarrage : la boîte muette reste écartée (on ne devine jamais)", () => {
  const entry = { pid: 42, messagingSocketPath: "/s", sessionId: "s" };
  const deps = {
    isProcessAlive: () => true,
    procStartOf: () => "X",
    sonderLaBoite: () => false
  };
  assert.equal(isEntryAlive(entry, deps), false);
});

test("fiche sans heure de démarrage : une boîte qui répond à la sonde est vivante (second recours)", () => {
  const entry = { pid: 42, messagingSocketPath: "/s", sessionId: "s" };
  const deps = {
    isProcessAlive: () => true,
    procStartOf: () => "X",
    sonderLaBoite: () => true
  };
  assert.equal(isEntryAlive(entry, deps), true);
});

test("la sonde reçoit le chemin de la boîte et un délai court", () => {
  const entry = { pid: 42, messagingSocketPath: "/tmp/faux/42.sock", sessionId: "s" };
  const vues = [];
  const deps = {
    isProcessAlive: () => true,
    sonderLaBoite: (socketPath, options) => {
      vues.push({ socketPath, options });
      return true;
    }
  };
  isEntryAlive(entry, deps);
  assert.equal(vues.length, 1);
  assert.equal(vues[0].socketPath, "/tmp/faux/42.sock");
  assert.equal(vues[0].options.timeoutMs, DELAI_SONDE_MS);
  assert.ok(DELAI_SONDE_MS > 0 && DELAI_SONDE_MS <= 500, "la sonde doit rester courte");
});

// Le programme qui écrit les fiches connaît une seconde écriture de l'heure de
// démarrage, `procStartFt`, qui REMPLACE la chaîne quand un réglage distant
// l'active. Il la relit et la valide comme une CHAÎNE de chiffres —
// `procStartFt: string().optional()`, `typeof l.procStartFt === "string"` —
// et c'est ce format-là que la tâche 4 devra savoir lire. Chez nous, ce
// jour-là, la fiche n'a plus de `procStart` : c'est la sonde qui décide,
// jamais une supposition.
test("une fiche qui n'inscrit son heure de démarrage qu'en nombre passe par la sonde", () => {
  const entry = {
    pid: 42,
    procStartFt: "1786601058448123", // le format réel : une chaîne de chiffres
    messagingSocketPath: "/s",
    sessionId: "s"
  };
  assert.equal(
    isEntryAlive(entry, { isProcessAlive: () => true, sonderLaBoite: () => true }),
    true
  );
  assert.equal(
    isEntryAlive(entry, { isProcessAlive: () => true, sonderLaBoite: () => false }),
    false
  );

  // Quelle que soit l'écriture, la conclusion est la même : sans `procStart`,
  // c'est la sonde qui tranche.
  const enNombreJs = { ...entry, procStartFt: 1786601058448123 };
  assert.equal(
    isEntryAlive(enNombreJs, { isProcessAlive: () => true, sonderLaBoite: () => false }),
    false
  );
});

test("fiche sans heure de démarrage ET processus mort : on ne sonde même pas", () => {
  const entry = { pid: 42, messagingSocketPath: "/s", sessionId: "s" };
  let sondee = false;
  const deps = {
    isProcessAlive: () => false,
    sonderLaBoite: () => {
      sondee = true;
      return true;
    }
  };
  assert.equal(isEntryAlive(entry, deps), false);
  assert.equal(sondee, false);
});

// ------------------------------------------- les sondes, pour de vrai
// Ces tests-ci parlent au vrai système : /bin/ps, kill(pid,0), et une
// FAUSSE boîte montée par le test dans un répertoire temporaire.

test("l'existence d'un processus se constate (notre propre processus est vivant)", () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(2147483647), false);
});

// `kill(0, 0)` ne désigne pas un processus : il désigne TOUT le groupe, et il
// réussit toujours. Une fiche à zéro passerait donc pour vivante à jamais.
test("le numéro du groupe de processus n'est jamais une boîte vivante", () => {
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(1), false);
  assert.equal(isProcessAlive(-1), false);
  assert.equal(isProcessAlive(1.5), false);

  const entry = { pid: 0, procStart: "X", messagingSocketPath: "/s", sessionId: "s" };
  assert.equal(
    isEntryAlive(entry, { isProcessAlive: () => true, procStartOf: () => "X" }),
    false,
    "la borne vit dans la vivacité elle-même, pas seulement dans la lecture de la fiche"
  );
});

test("l'heure de démarrage se lit sur /bin/ps (notre propre processus)", () => {
  const observee = procStartOf(process.pid);
  assert.equal(typeof observee, "string");
  assert.ok(observee.length > 0, `heure de démarrage vide: ${JSON.stringify(observee)}`);
  assert.equal(procStartOf(2147483647), null);
});

// Le registre écrit son heure de démarrage en UTC et en langue « C ».
// Lue en heure locale, la même seconde devient une autre chaîne : toutes les
// boîtes de la machine passeraient pour endormies. On lit donc dans la même
// langue et sur le même fuseau que celui qui écrit.
test("l'heure de démarrage se lit dans le fuseau du registre (UTC), pas dans celui de la machine", () => {
  const vues = [];
  procStartOf(4242, {
    execFileSync: (bin, args, options) => {
      vues.push({ bin, args, options });
      return "Thu Aug 13 06:04:14 2026";
    }
  });
  assert.equal(vues.length, 1);
  assert.equal(vues[0].options.env.TZ, "UTC");
  assert.equal(vues[0].options.env.LC_ALL, "C");
});

// Re-verdict de la revue adverse sur rc2 (29/08, F4) : `sonderLaBoite` recevait déjà un
// environnement minimal, `procStartOf` passait encore TOUT `process.env` à
// /bin/ps. Le message du commit rc2 (« the probe child gets a minimal env »)
// était vrai pour une sonde et faux pour l'autre. Un canari posé dans l'env
// du test ne doit arriver dans AUCUNE des deux — et les deux doivent recevoir
// LE MÊME environnement, construit à un seul endroit.
function envVuParLaSonde(sonde) {
  process.env.VALXOS_CANARI = "fuite";
  try {
    const vues = [];
    sonde((bin, args, options) => {
      vues.push(options.env);
      return "";
    });
    assert.equal(vues.length, 1, "la sonde doit avoir été lancée une fois");
    return vues[0];
  } finally {
    delete process.env.VALXOS_CANARI;
  }
}

test("la lecture de l'heure de démarrage ne passe pas l'environnement du parent à ps : un canari n'y arrive pas", () => {
  const env = envVuParLaSonde((execFileSync) => procStartOf(4242, { execFileSync }));
  assert.ok(!("VALXOS_CANARI" in env), "le canari a traversé : ps reçoit tout l'environnement du parent (jetons, clés de modèles)");
  assert.equal(env.LC_ALL, "C");
  assert.equal(env.TZ, "UTC");
});

test("la sonde de connexion ne passe pas non plus l'environnement du parent (contrôle : elle l'avait déjà)", () => {
  const env = envVuParLaSonde((execFileSync) => sonderLaBoite("/tmp/faux/1.sock", { execFileSync }));
  assert.ok(!("VALXOS_CANARI" in env), "le canari a traversé la sonde de connexion");
  assert.equal(env.LC_ALL, "C");
  assert.equal(env.TZ, "UTC");
});

test("les deux sondes reçoivent LE MÊME environnement minimal — construit à un seul endroit", () => {
  const pourPs = envVuParLaSonde((execFileSync) => procStartOf(4242, { execFileSync }));
  const pourLaBoite = envVuParLaSonde((execFileSync) => sonderLaBoite("/tmp/faux/1.sock", { execFileSync }));
  assert.deepEqual(pourPs, pourLaBoite);
  assert.deepEqual(Object.keys(pourPs).sort(), ["HOME", "LC_ALL", "PATH", "TMPDIR", "TZ"]);
});

// La garde précédente vérifie ce qu'on DEMANDE à `ps`. Celle-ci vérifie ce
// qu'on OBTIENT — et elle ne doit pas dépendre du réglage de la machine qui
// joue la suite : sur une machine déjà réglée en UTC, retirer `TZ=UTC` ne
// changerait rien et la garde mourrait sans que personne ne le voie. On force
// donc, DANS UN PROCESSUS À PART, un fuseau (+14, jamais d'heure d'été) et une
// langue étrangers : si notre lecture n'imposait pas les siens, l'heure lue
// désignerait un autre instant (14 h d'écart) ou ne se lirait pas du tout
// (mois en toutes lettres françaises).
test("l'heure de démarrage se lit en UTC même quand la machine vit à l'autre bout du monde", () => {
  const source = [
    `const m = await import(${JSON.stringify(MODULE_URL)});`,
    "const lue = m.procStartOf(process.pid);",
    "const instantLu = Date.parse(lue + ' UTC');",
    "const instantVecu = Date.now() - process.uptime() * 1000;",
    "process.stdout.write(JSON.stringify({ lue, ecartMs: instantLu - instantVecu }));"
  ].join("\n");

  const sortie = childProcess.execFileSync(
    process.execPath,
    ["--input-type=module", "-e", source],
    {
      timeout: 15000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, TZ: "Pacific/Kiritimati", LC_ALL: "fr_FR.ISO8859-1" }
    }
  );

  const vu = JSON.parse(sortie);
  assert.ok(
    Number.isFinite(vu.ecartMs),
    `heure de démarrage illisible depuis un fuseau étranger : ${JSON.stringify(vu.lue)} ` +
      "— la langue de la machine a traversé notre lecture"
  );
  assert.ok(
    Math.abs(vu.ecartMs) < 5000,
    `l'heure lue depuis un fuseau étranger (${JSON.stringify(vu.lue)}) désigne un instant ` +
      `à ${Math.round(vu.ecartMs / 1000)} s de l'âge du processus — le fuseau de la machine ` +
      "a traversé notre lecture, et toutes les boîtes passeraient pour endormies"
  );
});

test("l'heure de démarrage lue désigne bien l'instant où ce processus a commencé", () => {
  // Témoin indépendant de /bin/ps : l'âge que le processus se donne lui-même.
  const instantLu = Date.parse(`${procStartOf(process.pid)} UTC`);
  const instantVecu = Date.now() - process.uptime() * 1000;
  assert.ok(Number.isFinite(instantLu), "heure de démarrage illisible");
  assert.ok(
    Math.abs(instantLu - instantVecu) < 5000,
    `l'heure lue (${new Date(instantLu).toISOString()}) et l'âge du processus ` +
      `(${new Date(instantVecu).toISOString()}) désignent deux instants différents`
  );
});

// Une fausse boîte jetable : elle écoute, elle note ce qu'on lui glisse, et
// elle est démontée quoi qu'il arrive (un test rouge ne doit pas laisser
// traîner une boîte ouverte).
async function fausseBoite(t) {
  const dir = decorJetable("boite-");
  const sockPath = path.join(dir, "b.sock");
  const recu = [];
  const server = net.createServer((c) => c.on("data", (d) => recu.push(d.toString())));
  await new Promise((resolve) => server.listen(sockPath, resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, sockPath, recu };
}

test("la sonde répond vrai à une boîte qui écoute, faux à une adresse sans boîte", async (t) => {
  const boite = await fausseBoite(t);
  assert.equal(sonderLaBoite(boite.sockPath), true);
  assert.equal(sonderLaBoite(path.join(boite.dir, "jamais-ouverte.sock")), false);
});

// Le client officiel lit une boîte OCCUPÉE comme une boîte VIVANTE :
//   `r.on("connect",()=>n(!0)), r.on("error",(o)=>n(Nt(o)==="EBUSY")), r.setTimeout(250,()=>n(!1))`
// Sans cette lecture, une session en train de recevoir quelqu'un d'autre
// passerait pour endormie et son courrier attendrait le canal de repli.
test("une boîte occupée est une boîte vivante (la lecture du client officiel)", () => {
  const echec = (status, signal = null) => () => {
    const err = new Error("sonde");
    err.status = status;
    err.signal = signal;
    throw err;
  };

  assert.equal(
    sonderLaBoite("/tmp/faux/1.sock", { execFileSync: echec(CODE_SONDE_OCCUPEE) }),
    true,
    "occupée = vivante"
  );
  assert.equal(
    sonderLaBoite("/tmp/faux/1.sock", { execFileSync: echec(1) }),
    false,
    "personne n'ouvre = endormie"
  );
  assert.equal(
    sonderLaBoite("/tmp/faux/1.sock", { execFileSync: echec(null, "SIGTERM") }),
    false,
    "une sonde tuée par son couperet ne conclut RIEN — surtout pas « vivante »"
  );
});

// La tournée est synchrone : un enfant de sonde coincé la retient POUR
// TOUJOURS. Le couperet est la seule borne, et il n'était gardé par rien.
test("la sonde emporte un couperet, borné et plus large que son propre budget", () => {
  const vues = [];
  sonderLaBoite("/tmp/faux/1.sock", {
    timeoutMs: 250,
    execFileSync: (bin, args, options) => {
      vues.push({ bin, args, options });
      return "";
    }
  });

  assert.equal(vues.length, 1);
  const couperet = vues[0].options.timeout;
  assert.ok(
    Number.isFinite(couperet),
    "sans couperet, un enfant de sonde coincé retient la tournée pour toujours"
  );
  assert.ok(couperet > 250, `le couperet doit laisser la sonde finir son propre budget (${couperet})`);
  assert.ok(
    couperet <= 250 + MARGE_SONDE_MS,
    `le couperet doit rester borné (${couperet} > ${250 + MARGE_SONDE_MS})`
  );
  // Les deux bornes ci-dessus se lisent à travers MARGE_SONDE_MS : portée à un
  // quart d'heure, la constante les laisserait vertes — et une seule fiche
  // muette retiendrait la tournée un quart d'heure. La VALEUR se garde donc
  // ici, en clair.
  assert.ok(
    MARGE_SONDE_MS > 0 && MARGE_SONDE_MS <= 5000,
    `une seule fiche retiendrait la tournée ${MARGE_SONDE_MS} ms au-delà de son budget`
  );
});

// Et le couperet TOMBE pour de vrai : on remplace l'enfant de sonde par un
// enfant qui traîne, et on chronomètre la tournée.
test("un enfant de sonde qui traîne est coupé, et la tournée rend la main", () => {
  const dir = decorJetable("boite-");
  const trainard = path.join(dir, "sonde-qui-traine.sh");
  fs.writeFileSync(trainard, "#!/bin/sh\nexec sleep 5\n", { mode: 0o755 });

  const debut = Date.now();
  const verdict = sonderLaBoite("/tmp/faux/1.sock", {
    execPath: trainard,
    timeoutMs: 10,
    margeMs: 200
  });
  const ecoule = Date.now() - debut;

  assert.equal(verdict, false, "une sonde qui n'a pas conclu ne déclare jamais une boîte vivante");
  assert.ok(
    ecoule < 2000,
    `la sonde a retenu la tournée ${ecoule} ms : le couperet n'est pas tombé`
  );
});

test("la sonde ne dépose RIEN dans la boîte : elle frappe et repart", async (t) => {
  const boite = await fausseBoite(t);
  assert.equal(sonderLaBoite(boite.sockPath), true);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(boite.recu, [], "une sonde qui écrit n'est plus une sonde, c'est un dépôt");
});

// ------------------------------------------------------------ la tournée

// Monte une fausse MAISON sur disque : un registre, des fiches, des clés.
// Aucune maison réelle n'est lue par ces tests.
function fausseMaison(fiches = []) {
  const maison = decorJetable("maison-");
  const registre = path.join(maison, "sessions");
  fs.mkdirSync(registre);
  for (const { fiche, jeton } of fiches) {
    fs.writeFileSync(path.join(registre, `${fiche.pid}.json`), JSON.stringify(fiche));
    if (jeton !== undefined) {
      const nom = `${fiche.pid}.${sha256(path.resolve(fiche.messagingSocketPath))}.key`;
      fs.writeFileSync(
        path.join(registre, nom),
        JSON.stringify({ peerToken: jeton, procStart: fiche.procStart })
      );
    }
  }
  return { maison, registre };
}

const FICHE_VIVANTE = {
  pid: 111,
  sessionId: "aaa",
  name: "vivante",
  procStart: "X",
  messagingSocketPath: "/tmp/faux-cc-socks/111.sock",
  kind: "interactive",
  status: "idle"
};

const FICHE_MORTE = {
  pid: 222,
  sessionId: "bbb",
  name: "morte",
  procStart: "Y",
  messagingSocketPath: "/tmp/faux-cc-socks/222.sock",
  kind: "interactive",
  status: "idle"
};

const SEULE_111_VIVANTE = { isProcessAlive: (pid) => pid === 111, procStartOf: () => "X" };

test("la clé de dépôt se lit dans la maison DU DESTINATAIRE", () => {
  const { maison } = fausseMaison([{ fiche: FICHE_VIVANTE, jeton: "jeton-111" }]);
  assert.equal(readDeliveryToken(maison, FICHE_VIVANTE), "jeton-111");
});

test("une boîte sans clé publiée rend un jeton null, jamais une exception", () => {
  const { maison } = fausseMaison([{ fiche: FICHE_VIVANTE }]);
  assert.equal(readDeliveryToken(maison, FICHE_VIVANTE), null);
});

test("une clé illisible ou sans jeton rend null", () => {
  const { maison, registre } = fausseMaison([{ fiche: FICHE_VIVANTE, jeton: "jeton-111" }]);
  const nom = `111.${sha256(path.resolve(FICHE_VIVANTE.messagingSocketPath))}.key`;
  fs.writeFileSync(path.join(registre, nom), "{ pas du json");
  assert.equal(readDeliveryToken(maison, FICHE_VIVANTE), null);
  fs.writeFileSync(path.join(registre, nom), JSON.stringify({ peerToken: 42 }));
  assert.equal(readDeliveryToken(maison, FICHE_VIVANTE), null);
});

// La clé de dépôt porte, elle aussi, l'heure de démarrage de la boîte qu'elle
// ouvre (`{peerToken, procStart}`). Deux preuves valent mieux qu'une : une clé
// qui parle d'une AUTRE incarnation est une clé périmée, et on ne la présente
// pas au guichet. La boîte reste rendue (le jeton est optionnel sur cette
// plateforme) — on ne perd donc aucune lettre à ce refus.
test("une clé qui parle d'une autre incarnation n'est pas présentée au guichet", () => {
  const { maison, registre } = fausseMaison([{ fiche: FICHE_VIVANTE, jeton: "jeton-111" }]);
  const nom = `111.${sha256(path.resolve(FICHE_VIVANTE.messagingSocketPath))}.key`;

  assert.equal(readDeliveryToken(maison, FICHE_VIVANTE), "jeton-111", "clé concordante : on la prend");

  fs.writeFileSync(
    path.join(registre, nom),
    JSON.stringify({ peerToken: "jeton-perime", procStart: "UNE AUTRE HEURE" })
  );
  assert.equal(readDeliveryToken(maison, FICHE_VIVANTE), null, "clé d'une autre incarnation : on s'abstient");

  // Une clé muette sur l'incarnation reste la clé publiée pour cette boîte :
  // on ne fabrique pas un refus à partir d'un silence.
  fs.writeFileSync(path.join(registre, nom), JSON.stringify({ peerToken: "jeton-sans-heure" }));
  assert.equal(readDeliveryToken(maison, FICHE_VIVANTE), "jeton-sans-heure");
});

test("la clé se confronte aussi quand l'heure de démarrage est écrite en nombre", () => {
  const fiche = { ...FICHE_VIVANTE };
  delete fiche.procStart;
  fiche.procStartFt = "1786601058448123";
  const { maison, registre } = fausseMaison([{ fiche }]);
  const nom = `111.${sha256(path.resolve(fiche.messagingSocketPath))}.key`;

  fs.writeFileSync(
    path.join(registre, nom),
    JSON.stringify({ peerToken: "jeton-111", procStartFt: "1786601058448123" })
  );
  assert.equal(readDeliveryToken(maison, fiche), "jeton-111");

  fs.writeFileSync(
    path.join(registre, nom),
    JSON.stringify({ peerToken: "jeton-perime", procStartFt: "1700000000000000" })
  );
  assert.equal(readDeliveryToken(maison, fiche), null);
});

test("une boîte dont la clé est périmée reste rendue, sans jeton (jamais de lettre perdue à ce refus)", () => {
  const { maison, registre } = fausseMaison([{ fiche: FICHE_VIVANTE, jeton: "jeton-111" }]);
  const nom = `111.${sha256(path.resolve(FICHE_VIVANTE.messagingSocketPath))}.key`;
  fs.writeFileSync(
    path.join(registre, nom),
    JSON.stringify({ peerToken: "jeton-perime", procStart: "UNE AUTRE HEURE" })
  );

  const boxes = listMailboxes([maison], SEULE_111_VIVANTE);
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].token, null);
});

test("la tournée ne rend que les boîtes vivantes, avec leur clé", () => {
  const { maison, registre } = fausseMaison([
    { fiche: FICHE_VIVANTE, jeton: "jeton-111" },
    { fiche: FICHE_MORTE }
  ]);
  fs.writeFileSync(path.join(registre, "note.txt"), "pas une fiche");

  const boxes = listMailboxes([maison], SEULE_111_VIVANTE);

  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].name, "vivante");
  assert.equal(boxes[0].token, "jeton-111");
  assert.equal(boxes[0].house, maison);
  assert.equal(boxes[0].sessionId, "aaa");
  assert.equal(boxes[0].pid, 111);
  assert.equal(boxes[0].socketPath, FICHE_VIVANTE.messagingSocketPath);
  assert.equal(boxes[0].kind, "interactive");
  assert.equal(boxes[0].status, "idle");
  assert.equal(boxes[0].procStart, "X");
  assert.equal(boxes[0].preuve, "registre", "cette boîte-là est prouvée par le registre seul");
});

// A5 (la sonde) contre A12 (la boîte est un quadruplet COMPLET) : les deux
// amendements se croisent ici, et l'arbitrage est écrit dans le module.
// Une boîte prouvée par la sonde EST rendue — sinon la sonde ne sert à rien
// et une session vivante attendrait le canal de repli — mais elle ne MENT
// pas sur ce qui la prouve : `procStart` reste nul (on n'invente pas l'heure
// qu'on n'a pas lue) et `preuve` nomme la sonde.
test("une boîte prouvée vivante par la sonde est rendue, et elle dit d'où vient sa preuve", () => {
  const sansHeure = { ...FICHE_VIVANTE };
  delete sansHeure.procStart;
  const { maison } = fausseMaison([{ fiche: sansHeure, jeton: "jeton-111" }]);

  const tour = tourHouses([maison], {
    isProcessAlive: (pid) => pid === 111,
    sonderLaBoite: () => true
  });

  assert.equal(tour.boxes.length, 1, "sans elle, la sonde du second recours ne sert à rien");
  const boite = tour.boxes[0];
  assert.equal(boite.sessionId, "aaa", "le verrou d'incarnation, lui, reste entier");
  assert.equal(boite.socketPath, sansHeure.messagingSocketPath);
  assert.equal(boite.token, "jeton-111");
  assert.equal(boite.procStart, null, "on ne fabrique jamais une heure qu'on n'a pas lue");
  assert.equal(boite.preuve, "sonde");
  assert.equal(tour.houses[0].sondees, 1);
});

test("une boîte que la sonde ne fait pas répondre n'est pas rendue du tout", () => {
  const sansHeure = { ...FICHE_VIVANTE };
  delete sansHeure.procStart;
  const { maison } = fausseMaison([{ fiche: sansHeure, jeton: "jeton-111" }]);

  const tour = tourHouses([maison], {
    isProcessAlive: (pid) => pid === 111,
    sonderLaBoite: () => false
  });

  assert.equal(tour.boxes.length, 0);
  assert.equal(tour.houses[0].endormies, 1);
  assert.equal(tour.houses[0].sondees, 0);
});

// ⚠️ LE JOUR OÙ `procStartFt` S'ACTIVE — le programme qui tient les registres
// sait écrire l'heure de démarrage en NOMBRE (`procStartFt`, validé comme une
// CHAÎNE de chiffres : `procStartFt: string().optional()`) À LA PLACE de
// `procStart`. Ce jour-là PLUS AUCUNE fiche ne portera `procStart`, et toute
// la vivacité de la machine reposera sur la sonde. Ce test fige ce qui se
// passe alors : la tournée DÉGRADE (un coup court frappé par fiche), elle ne
// se tait pas, et elle COMPTE ses sondes pour que la dégradation se voie.
test("le jour où l'heure de démarrage ne s'écrit qu'en nombre, la tournée dégrade en sondes courtes", () => {
  const fiches = [1, 2, 3].map((n) => ({
    fiche: {
      pid: 100 + n,
      sessionId: `s-${n}`,
      name: `boite-${n}`,
      procStartFt: "1786601058448123",
      messagingSocketPath: `/tmp/faux-cc-socks/${100 + n}.sock`,
      kind: "interactive",
      status: "idle"
    }
  }));
  const { maison } = fausseMaison(fiches);

  const coups = [];
  let confrontations = 0;
  const tour = tourHouses([maison], {
    isProcessAlive: () => true,
    procStartOf: () => {
      confrontations += 1;
      return "X";
    },
    sonderLaBoite: (socketPath, options) => {
      coups.push({ socketPath, options });
      return true;
    }
  });

  assert.equal(confrontations, 0, "une fiche sans heure de démarrage n'a rien à confronter");
  assert.equal(coups.length, 3, "un coup frappé par fiche, pas un de plus");
  for (const coup of coups) {
    assert.ok(
      coup.options.timeoutMs > 0 && coup.options.timeoutMs <= 500,
      `la sonde de dégradation doit rester COURTE (${coup.options.timeoutMs} ms)`
    );
  }
  assert.equal(tour.boxes.length, 3, "la tournée continue de porter : elle dégrade, elle ne meurt pas");
  assert.equal(tour.houses[0].sondees, 3, "la dégradation se COMPTE — elle n'est jamais silencieuse");
  for (const boite of tour.boxes) {
    assert.equal(boite.procStart, null);
    assert.equal(boite.preuve, "sonde");
  }
});

test("une copie de fiche laissée dans le registre ne crée pas une deuxième boîte", () => {
  const { maison, registre } = fausseMaison([{ fiche: FICHE_VIVANTE, jeton: "jeton-111" }]);
  // Une écriture atomique interrompue, une sauvegarde à la main : le registre
  // se salit. Deux boîtes pour une même session, ce serait deux fois la lettre.
  //
  // Les leurres portent un JSON VALIDE (A12 : sinon la lecture les rejetterait
  // plus loin de toute façon, et le filtre du NOM ne serait prouvé par rien) et
  // une session DISTINCTE : sans cela la dédup de session les rattraperait, et
  // ce test resterait vert le jour où le filtre disparaît.
  fs.writeFileSync(
    path.join(registre, "111.json.bak"),
    JSON.stringify({ ...FICHE_VIVANTE, sessionId: "aaa-bis" })
  );
  fs.writeFileSync(
    path.join(registre, "111.json.tmp.4242"),
    JSON.stringify({ ...FICHE_VIVANTE, sessionId: "aaa-ter" })
  );

  const boxes = listMailboxes([maison], SEULE_111_VIVANTE);
  assert.equal(boxes.length, 1, "seules les fiches <numéro>.json sont des fiches");
});

test("une boîte vivante sans clé reste listée, jeton null (sur cette plateforme l'authentification est optionnelle)", () => {
  const { maison } = fausseMaison([{ fiche: FICHE_VIVANTE }]);
  const boxes = listMailboxes([maison], SEULE_111_VIVANTE);
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].token, null);
});

test("une maison sans registre n'est jamais une panne : les autres maisons sont servies", () => {
  const { maison } = fausseMaison([{ fiche: FICHE_VIVANTE, jeton: "jeton-111" }]);
  const boxes = listMailboxes(["/maison/qui/nexiste/pas", maison], SEULE_111_VIVANTE);
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].house, maison);
});

test("l'inventaire des maisons ne s'itère jamais lettre par lettre (une seule maison passée en texte)", () => {
  const { maison } = fausseMaison([{ fiche: FICHE_VIVANTE, jeton: "jeton-111" }]);
  const boxes = listMailboxes(maison, SEULE_111_VIVANTE);
  assert.equal(boxes.length, 1, "une maison unique passée en texte doit être servie, pas épelée");
});

// Une lettre en double est un désagrément, une lettre perdue est une
// trahison — mais un doublon qu'on peut éviter à la source, on l'évite. Un
// inventaire qui nomme deux fois la même maison (barre finale, chemin non
// résolu, raccourci) doublerait CHAQUE boîte de cette maison, donc chaque
// lettre qu'on y porte.
test("la même maison nommée deux fois n'est parcourue qu'une fois", () => {
  const { maison } = fausseMaison([{ fiche: FICHE_VIVANTE, jeton: "jeton-111" }]);

  for (const jumelle of [`${maison}/`, path.join(maison, "."), `${maison}//`]) {
    const tour = tourHouses([maison, jumelle], SEULE_111_VIVANTE);
    assert.equal(tour.boxes.length, 1, `deux boîtes pour ${jumelle}`);
    assert.equal(tour.houses.length, 1, `deux maisons pour ${jumelle}`);
  }
});

test("une maison atteinte par un raccourci reste la même maison", () => {
  const { maison } = fausseMaison([{ fiche: FICHE_VIVANTE, jeton: "jeton-111" }]);
  const ailleurs = decorJetable("maison-");
  const raccourci = path.join(ailleurs, "vers-la-maison");
  fs.symlinkSync(maison, raccourci);

  const tour = tourHouses([maison, raccourci], SEULE_111_VIVANTE);
  assert.equal(tour.boxes.length, 1, "un raccourci vers une maison n'est pas une deuxième maison");
  assert.equal(tour.houses.length, 1);
});

// La MÊME règle des deux côtés (A4) : la tournée ne retient qu'une orthographe
// par maison, et c'est celle de l'inventaire qui l'a nommée en premier. Si la
// reconnaissance comparait autrement, une maison qu'on VIENT de parcourir
// passerait pour inconnue selon l'ordre de l'inventaire — et le Facteur dirait
// « maison-inconnue » d'une maison servie, ce que A4 interdit précisément.
test("une maison parcourue est reconnue quelle que soit l'orthographe de l'inventaire", () => {
  const { maison } = fausseMaison([{ fiche: FICHE_VIVANTE, jeton: "jeton-111" }]);
  const ailleurs = decorJetable("maison-");
  const raccourci = path.join(ailleurs, "vers-la-maison");
  fs.symlinkSync(maison, raccourci);

  for (const inventaire of [
    [maison, raccourci],
    [raccourci, maison]
  ]) {
    const ordre = inventaire[0] === maison ? "maison d'abord" : "raccourci d'abord";
    const tour = tourHouses(inventaire, SEULE_111_VIVANTE);
    assert.equal(tour.houses.length, 1, `deux maisons pour une seule (${ordre})`);
    assert.equal(isKnownHouse(tour.houses, maison), true, `maison parcourue déclarée inconnue (${ordre})`);
    assert.equal(
      isKnownHouse(tour.houses, raccourci),
      true,
      `raccourci parcouru déclaré inconnu (${ordre})`
    );
  }
});

// Le registre se salit (écriture atomique interrompue, fiche recopiée sous un
// autre numéro, maison clonée) : deux fiches peuvent décrire LA MÊME session.
// Deux boîtes pour une session, ce serait deux fois la lettre.
test("deux fiches pour une même session ne font qu'une seule boîte", () => {
  const { maison } = fausseMaison([
    { fiche: FICHE_VIVANTE, jeton: "jeton-111" },
    { fiche: { ...FICHE_VIVANTE, pid: 333 }, jeton: "jeton-333" }
  ]);

  const tour = tourHouses([maison], { isProcessAlive: () => true, procStartOf: () => "X" });
  assert.equal(tour.boxes.length, 1, "une session n'a qu'une boîte dans une tournée");
  assert.equal(tour.boxes[0].pid, 111, "à fiches égales, la tournée sert toujours la même");
  assert.equal(tour.houses[0].doublons, 1, "le doublon écarté se compte, il ne disparaît pas");
});

test("une même session vue dans deux maisons ne fait qu'une seule boîte", () => {
  const a = fausseMaison([{ fiche: FICHE_VIVANTE, jeton: "jeton-111" }]);
  const b = fausseMaison([{ fiche: FICHE_VIVANTE, jeton: "jeton-111" }]);

  const boxes = listMailboxes([a.maison, b.maison], SEULE_111_VIVANTE);
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].house, a.maison, "la première maison de l'inventaire sert");
});

test("un inventaire vide rend une tournée vide, sans panne", () => {
  assert.deepEqual(listMailboxes([]), []);
  assert.deepEqual(listMailboxes(null), []);
});

test("deux maisons sont servies dans une seule tournée", () => {
  const a = fausseMaison([{ fiche: FICHE_VIVANTE, jeton: "jeton-111" }]);
  const b = fausseMaison([{ fiche: { ...FICHE_MORTE, pid: 333, sessionId: "ccc", name: "voisine", procStart: "X" }, jeton: "jeton-333" }]);
  const boxes = listMailboxes([a.maison, b.maison], {
    isProcessAlive: () => true,
    procStartOf: () => "X"
  });
  assert.deepEqual(boxes.map((b2) => b2.name).sort(), ["vivante", "voisine"]);
});

// Amendement A4 : une maison ABSENTE de l'inventaire ne doit jamais être
// confondue avec une boîte endormie. La tournée rend donc AUSSI l'inventaire
// qu'elle vient de parcourir — c'est la donnée dont le Facteur (tâche 4) a
// besoin pour journaliser « maison-inconnue » au lieu de « endormie ».

test("la tournée rend l'inventaire des maisons parcourues, avec ce qu'elle y a vu", () => {
  const { maison, registre } = fausseMaison([
    { fiche: FICHE_VIVANTE, jeton: "jeton-111" },
    { fiche: FICHE_MORTE }
  ]);
  fs.writeFileSync(path.join(registre, "444.json"), "{ pas du json");

  const tour = tourHouses([maison, "/maison/qui/nexiste/pas"], SEULE_111_VIVANTE);

  assert.equal(tour.boxes.length, 1);
  assert.equal(tour.houses.length, 2);

  const servie = tour.houses.find((h) => h.house === maison);
  assert.equal(servie.readable, true);
  assert.equal(servie.fiches, 3);
  assert.equal(servie.boxes, 1);
  assert.equal(servie.endormies, 1);
  assert.equal(servie.illisibles, 1);

  const absente = tour.houses.find((h) => h.house === "/maison/qui/nexiste/pas");
  assert.equal(absente.readable, false, "une maison sans registre est CONNUE mais illisible");
  assert.equal(absente.boxes, 0);
});

test("une maison de l'inventaire est reconnue, une maison hors inventaire ne l'est pas", () => {
  const tour = tourHouses(["/maisons/work"], { readdirSync: () => [] });
  assert.equal(isKnownHouse(tour.houses, "/maisons/work"), true);
  assert.equal(isKnownHouse(tour.houses, "/maisons/work/"), true);
  assert.equal(isKnownHouse(tour.houses, "/maisons/./work"), true);
  assert.equal(isKnownHouse(tour.houses, "/maisons/bob"), false);
  assert.equal(isKnownHouse(tour.houses, null), false);
  assert.equal(isKnownHouse([], "/maisons/work"), false);
});

test("la tournée et l'inventaire rendent exactement les mêmes boîtes", () => {
  const { maison } = fausseMaison([
    { fiche: FICHE_VIVANTE, jeton: "jeton-111" },
    { fiche: FICHE_MORTE }
  ]);
  assert.deepEqual(
    listMailboxes([maison], SEULE_111_VIVANTE),
    tourHouses([maison], SEULE_111_VIVANTE).boxes
  );
});

test("la tournée ne se connecte à aucune boîte quand les fiches portent leur heure de démarrage", () => {
  const { maison } = fausseMaison([{ fiche: FICHE_VIVANTE, jeton: "jeton-111" }]);
  let sondes = 0;
  const boxes = listMailboxes([maison], {
    ...SEULE_111_VIVANTE,
    sonderLaBoite: () => {
      sondes += 1;
      return true;
    }
  });
  assert.equal(boxes.length, 1);
  assert.equal(sondes, 0, "regarder le registre suffit : on ne frappe pas aux portes pour rien");
});
