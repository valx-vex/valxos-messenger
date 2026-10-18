// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LES SURFACES LUES PARLENT ANGLAIS (T4b-b, 18/10). Ce que le Messenger dit à
// un humain ou injecte dans un modèle est en anglais ; le code interne
// (identifiants, commentaires, noms de tests) reste en français. Ce module
// sépare les deux : il rend les LITTÉRAUX de chaîne d'un source (ce qui peut
// sortir), sans les commentaires ni les regex (ce qui ne sort jamais).
//
// Un grep de diacritiques ne suffit pas : le moniteur Python écrit son
// français sans accents (« deja », « identite »). D'où le second critère :
// deux mots-outils français dans une même chaîne.
import fs from "node:fs";
import path from "node:path";

// Un « / » ouvre une regex après ces caractères ou ces mots, et divise sinon.
const AVANT_REGEX = new Set("(,=:[!&|?{};+-*%<>~^".split(""));
const MOTS_AVANT_REGEX = new Set(["return", "typeof", "case", "in", "of", "void", "throw", "delete", "new", "else", "do", "yield", "await"]);

// Les littéraux de chaîne d'un source JS : '…', "…" et les parties fixes des
// gabarits `…` (les expressions ${…} sont balayées comme du code, leurs
// propres chaînes comprises). Rend [{ ligne, texte }].
export function litterauxJs(source) {
  const litteraux = [];
  const n = source.length;
  let i = 0;
  let ligne = 1;
  let precedent = "";
  let motPrecedent = "";

  const avancer = (k = 1) => {
    for (let j = 0; j < k && i < n; j += 1) {
      if (source[i] === "\n") ligne += 1;
      i += 1;
    }
  };

  const lireChaine = (guillemet) => {
    const debut = ligne;
    avancer();
    let texte = "";
    while (i < n && source[i] !== guillemet && source[i] !== "\n") {
      if (source[i] === "\\") {
        texte += source.slice(i, i + 2);
        avancer(2);
        continue;
      }
      texte += source[i];
      avancer();
    }
    avancer();
    litteraux.push({ ligne: debut, texte });
  };

  const lireRegex = () => {
    avancer();
    let classe = false;
    while (i < n && source[i] !== "\n") {
      const c = source[i];
      if (c === "\\") {
        avancer(2);
        continue;
      }
      if (classe) {
        if (c === "]") classe = false;
      } else if (c === "[") {
        classe = true;
      } else if (c === "/") {
        avancer();
        break;
      }
      avancer();
    }
    while (i < n && /[a-z]/i.test(source[i])) avancer();
  };

  let balayer;

  const lireGabarit = () => {
    avancer();
    let debut = ligne;
    let texte = "";
    while (i < n && source[i] !== "`") {
      if (source[i] === "\\") {
        texte += source.slice(i, i + 2);
        avancer(2);
        continue;
      }
      if (source[i] === "$" && source[i + 1] === "{") {
        litteraux.push({ ligne: debut, texte });
        texte = "";
        avancer(2);
        balayer(true);
        debut = ligne;
        continue;
      }
      texte += source[i];
      avancer();
    }
    avancer();
    litteraux.push({ ligne: debut, texte });
  };

  balayer = (dansExpression) => {
    let profondeur = 0;
    while (i < n) {
      const c = source[i];
      const s = source[i + 1];
      if (c === "/" && s === "/") {
        while (i < n && source[i] !== "\n") avancer();
        continue;
      }
      if (c === "/" && s === "*") {
        avancer(2);
        while (i < n && !(source[i] === "*" && source[i + 1] === "/")) avancer();
        avancer(2);
        continue;
      }
      if (c === "'" || c === "\"") {
        lireChaine(c);
        precedent = "a";
        motPrecedent = "";
        continue;
      }
      if (c === "`") {
        lireGabarit();
        precedent = "a";
        motPrecedent = "";
        continue;
      }
      if (c === "/" && (precedent === "" || AVANT_REGEX.has(precedent) || MOTS_AVANT_REGEX.has(motPrecedent))) {
        lireRegex();
        precedent = "a";
        motPrecedent = "";
        continue;
      }
      if (dansExpression && c === "{") profondeur += 1;
      if (dansExpression && c === "}") {
        if (profondeur === 0) {
          avancer();
          return;
        }
        profondeur -= 1;
      }
      if (/\s/.test(c)) {
        avancer();
        continue;
      }
      if (/[\p{L}\p{N}_$]/u.test(c)) {
        let mot = "";
        while (i < n && /[\p{L}\p{N}_$]/u.test(source[i])) {
          mot += source[i];
          avancer();
        }
        precedent = "a";
        motPrecedent = mot;
        continue;
      }
      precedent = c;
      motPrecedent = "";
      avancer();
    }
  };

  if (source.startsWith("#!")) while (i < n && source[i] !== "\n") avancer();
  balayer(false);
  return litteraux;
}

// Les littéraux de chaîne d'un source Python, commentaires `#` écartés. Une
// docstring (triple guillemet juste après un « : » ou en tête de fichier) est
// un commentaire : elle ne sort jamais, on l'écarte aussi.
export function litterauxPy(source) {
  const litteraux = [];
  const n = source.length;
  let i = 0;
  let ligne = 1;
  let precedent = "";

  const avancer = (k = 1) => {
    for (let j = 0; j < k && i < n; j += 1) {
      if (source[i] === "\n") ligne += 1;
      i += 1;
    }
  };

  while (i < n) {
    const c = source[i];
    if (c === "#") {
      while (i < n && source[i] !== "\n") avancer();
      continue;
    }
    const prefixe = /^[rRbBuUfF]{0,2}(?=['"])/.exec(source.slice(i, i + 3));
    const motAvant = i > 0 && /[\p{L}\p{N}_]/u.test(source[i - 1]);
    if (prefixe && !motAvant) {
      avancer(prefixe[0].length);
      const triple = source.startsWith("\"\"\"", i) || source.startsWith("'''", i);
      const fin = triple ? source.slice(i, i + 3) : source[i];
      const docstring = triple && (precedent === "" || precedent === ":");
      const debut = ligne;
      avancer(fin.length);
      let texte = "";
      while (i < n && !source.startsWith(fin, i)) {
        if (!triple && source[i] === "\n") break;
        if (source[i] === "\\") {
          texte += source.slice(i, i + 2);
          avancer(2);
          continue;
        }
        texte += source[i];
        avancer();
      }
      avancer(fin.length);
      if (!docstring) litteraux.push({ ligne: debut, texte });
      precedent = "a";
      continue;
    }
    if (!/\s/.test(c)) precedent = c;
    avancer();
  }
  return litteraux;
}

// Une chaîne parle français si elle porte un accent français ou des
// guillemets « », ou deux mots-outils français. Les commentaires SQL (`-- …`)
// d'une requête écrite dans un gabarit ne sortent jamais : on les retire.
const ACCENTS = /[àâçéèêëîïôûùüÿœæÀÂÇÉÈÊËÎÏÔÛÙÜŸŒÆ«»]/;
// « plus » manque exprès : c'est aussi un mot anglais.
const MOTS_OUTILS = /(?<![\p{L}\p{N}_-])(le|la|les|des|une|est|sont|pas|sans|aucun|aucune|pour|avec|dans|qui|que|faut|cette|ce|ces|sur|du|aux?|ou|et|ne|ni|il|elle|nous|vous|mais|rien|son|sa|ses|leur|jamais|deja|vers|chez|n'|l'|d'|qu'|c'est)(?![\p{L}\p{N}_-])/giu;

export function parleFrancais(texte) {
  const sansSql = String(texte).split("\n").map((l) => l.replace(/(^|\s)--\s.*$/, "")).join("\n");
  if (ACCENTS.test(sansSql)) return true;
  if (!/\s/.test(sansSql)) return false;
  return (sansSql.match(MOTS_OUTILS) || []).length >= 2;
}

// Les fichiers d'une surface : tout ce que le paquet embarque comme script
// (src/ et scripts/), sauf le front web, qui a sa propre tâche.
export function fichiersDesSurfaces(racine, { exclus = [] } = {}) {
  const fichiers = [];
  const marcher = (dossier) => {
    for (const entree of fs.readdirSync(path.join(racine, dossier), { withFileTypes: true })) {
      const relatif = path.posix.join(dossier, entree.name);
      if (exclus.some((e) => relatif === e || relatif.startsWith(`${e}/`))) continue;
      if (entree.isDirectory()) marcher(relatif);
      else if (/\.(m?js|py)$/.test(entree.name)) fichiers.push(relatif);
    }
  };
  marcher("src");
  marcher("scripts");
  return fichiers.sort();
}

export function prosesFrancaises(racine, fichier) {
  const source = fs.readFileSync(path.join(racine, fichier), "utf8");
  const litteraux = fichier.endsWith(".py") ? litterauxPy(source) : litterauxJs(source);
  return litteraux.filter((l) => parleFrancais(l.texte)).map((l) => ({ fichier, ...l }));
}
