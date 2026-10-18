// The door mints its token into web.env WITHOUT erasing what the operator wrote
// there (the mandatory operator, the frame list). Born red on 2026-08-26 from an
// adversarial review: the mint used to truncate the file, and the door refused
// to start on its second launch when the operator lived in the file — the exact
// path the README documents.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { chargerLeJeton, reglagesDeLaPorte } from "../src/web/auth.js";

function bureau() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-web-jeton-merge-"));
  return path.join(dir, "web.env");
}

test("minting the token keeps the operator and the frame list in web.env", () => {
  const fichier = bureau();
  fs.writeFileSync(fichier, [
    "# door settings",
    "VALXOS_WEB_OPERATEUR=operator",
    "VALXOS_WEB_CADRE_AUTORISE=http://command-center.example",
    "",
  ].join("\n"), { mode: 0o600 });
  const env = { PATH: "/usr/bin" };
  const jeton = chargerLeJeton({ fichier, env });
  assert.match(jeton, /^[0-9a-f]{32,}$/);
  const apres = fs.readFileSync(fichier, "utf8");
  assert.match(apres, /^VALXOS_WEB_OPERATEUR=operator$/m, "operator survives the mint");
  assert.match(apres, /^VALXOS_WEB_CADRE_AUTORISE=http:\/\/command-center\.example$/m, "frame list survives");
  assert.match(apres, /^# door settings$/m, "comments survive");
  assert.match(apres, new RegExp("^VALXOS_WEB_JETON=" + jeton + "$", "m"), "the token is written");
  assert.equal(fs.statSync(fichier).mode & 0o777, 0o600);
  // Second launch, the documented path: the door still finds its operator.
  const reglages = reglagesDeLaPorte({ fichier, env });
  assert.equal(reglages.operateur, "operator");
  assert.equal(chargerLeJeton({ fichier, env }), jeton, "the minted token is reused, not re-minted");
});

test("an empty token line is replaced, not duplicated", () => {
  const fichier = bureau();
  fs.writeFileSync(fichier, "VALXOS_WEB_OPERATEUR=operator\nVALXOS_WEB_JETON=\n", { mode: 0o600 });
  const jeton = chargerLeJeton({ fichier, env: {} });
  const lignes = fs.readFileSync(fichier, "utf8").split("\n").filter((l) => l.startsWith("VALXOS_WEB_JETON="));
  assert.deepEqual(lignes, ["VALXOS_WEB_JETON=" + jeton]);
});

test("without a file, the mint still creates web.env with only the token", () => {
  const fichier = bureau();
  const jeton = chargerLeJeton({ fichier, env: {} });
  assert.equal(fs.readFileSync(fichier, "utf8"), "VALXOS_WEB_JETON=" + jeton + "\n");
});

// J3 (jury, 18/10) — A HAND-MADE web.env AT 0644 LEAKS THE ONLY DOOR SECRET.
// `chargerLeJeton` returned the token of a web.env that already held one without looking
// at the file's mode: the mint writes 0600, but an operator who creates the file by hand
// (the README documents web.env as the place for the operator name) gets 0644 from the
// umask, and every other local account can read the token. On load, a mode that grants
// ANY group or other bit is changed to 0600, and one line on stderr says so — once,
// since the next load finds 0600 and has nothing to say. The line never prints the token.
const JETON_A_LA_MAIN = "c".repeat(64);

function webEnvFaitAlaMain(mode) {
  const fichier = bureau();
  fs.writeFileSync(fichier, `VALXOS_WEB_OPERATEUR=operator\nVALXOS_WEB_JETON=${JETON_A_LA_MAIN}\n`);
  fs.chmodSync(fichier, mode); // writeFileSync's mode is masked by the umask: chmod sets it for real
  return fichier;
}

// What the call writes on stderr, synchronously, without printing it into the test report.
function avecStderrCapte(appel) {
  const ecrire = process.stderr.write;
  let sortie = "";
  process.stderr.write = (bloc, ...reste) => {
    sortie += String(bloc);
    const rappel = reste.find((r) => typeof r === "function");
    if (rappel) rappel();
    return true;
  };
  try {
    return { valeur: appel(), sortie };
  } finally {
    process.stderr.write = ecrire;
  }
}

test("J3: a web.env at 0644 that holds a token becomes 0600 when the door loads it — token and contents unchanged, one line on stderr, once", () => {
  const fichier = webEnvFaitAlaMain(0o644);
  const avant = fs.readFileSync(fichier, "utf8");

  const { valeur, sortie } = avecStderrCapte(() => chargerLeJeton({ fichier, env: {} }));

  assert.equal(valeur, JETON_A_LA_MAIN, "the token is unchanged");
  assert.equal(fs.statSync(fichier).mode & 0o777, 0o600, "the file is now owner-only");
  assert.equal(fs.readFileSync(fichier, "utf8"), avant, "the contents are byte for byte the same");
  const lignes = sortie.split("\n").filter(Boolean);
  assert.equal(lignes.length, 1, `one line, not ${lignes.length}: ${sortie}`);
  assert.ok(lignes[0].includes(fichier), "the line names the file");
  assert.match(lignes[0], /644/, "and the mode it had");
  assert.match(lignes[0], /600/, "and the mode it has now");
  assert.ok(!sortie.includes(JETON_A_LA_MAIN), "the line never prints the token");

  const encore = avecStderrCapte(() => chargerLeJeton({ fichier, env: {} }));
  assert.equal(encore.valeur, JETON_A_LA_MAIN);
  assert.equal(encore.sortie, "", "the second load has nothing to say: the file is already 0600");
});

test("J3: ANY group or other bit is enough — 0640, 0604, 0660, 0666, 0750 and 0755 are all brought to 0600", () => {
  for (const mode of [0o640, 0o604, 0o660, 0o666, 0o750, 0o755]) {
    const fichier = webEnvFaitAlaMain(mode);
    const { valeur, sortie } = avecStderrCapte(() => chargerLeJeton({ fichier, env: {} }));
    assert.equal(valeur, JETON_A_LA_MAIN);
    assert.equal(fs.statSync(fichier).mode & 0o777, 0o600, `${mode.toString(8)} → 600`);
    assert.match(sortie, new RegExp(mode.toString(8)), `the line names the mode it found (${mode.toString(8)})`);
  }
});

test("J3: an owner-only web.env is left alone and silent — 0600, 0400 and 0700 keep their mode", () => {
  for (const mode of [0o600, 0o400, 0o700]) {
    const fichier = webEnvFaitAlaMain(mode);
    const { valeur, sortie } = avecStderrCapte(() => chargerLeJeton({ fichier, env: {} }));
    assert.equal(valeur, JETON_A_LA_MAIN);
    assert.equal(fs.statSync(fichier).mode & 0o777, mode, `${mode.toString(8)} is not touched`);
    assert.equal(sortie, "", `${mode.toString(8)}: nothing said`);
  }
});

test("J3: a symlinked web.env at 0644 — the real file is tightened and the link stays a link", () => {
  const reel = webEnvFaitAlaMain(0o644);
  const lien = path.join(path.dirname(reel), "lien-web.env");
  fs.symlinkSync(reel, lien);

  const { valeur } = avecStderrCapte(() => chargerLeJeton({ fichier: lien, env: {} }));

  assert.equal(valeur, JETON_A_LA_MAIN);
  assert.equal(fs.lstatSync(lien).isSymbolicLink(), true, "the link is still a link");
  assert.equal(fs.statSync(reel).mode & 0o777, 0o600, "the file it leads to is owner-only");
});

test("J3: a chmod that fails does not stop the door — the token is returned and the line says it could not tighten", (t) => {
  const fichier = webEnvFaitAlaMain(0o644);
  t.mock.method(fs, "chmodSync", () => {
    throw Object.assign(new Error("EPERM: operation not permitted, chmod"), { code: "EPERM" });
  });

  const { valeur, sortie } = avecStderrCapte(() => chargerLeJeton({ fichier, env: {} }));

  assert.equal(valeur, JETON_A_LA_MAIN, "the door still gets its token");
  assert.equal(fs.statSync(fichier).mode & 0o777, 0o644, "SONDE: the mode really was left as it was");
  const lignes = sortie.split("\n").filter(Boolean);
  assert.equal(lignes.length, 1, sortie);
  assert.match(lignes[0], /could not/i, "the line says the file could not be tightened");
  assert.match(lignes[0], /EPERM/, "and why");
  assert.ok(!sortie.includes(JETON_A_LA_MAIN), "the token is not printed");
});
