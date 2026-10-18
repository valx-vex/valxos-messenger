// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// UN PAPIER QU'ON PEUT REGARDER SANS NAVIGATEUR.
//
// Ce fichier ne porte AUCUN test, et son nom ne finit pas par `.test.js` :
// même raison qu'`aide-porte.js` — le balayage de `garde-bureau.test.js`
// rejoue tout ce qui porte ce suffixe, et un décor rejoué seul ne prouve rien.
//
// ── POURQUOI IL EXISTE ────────────────────────────────────────────────────
// Les fonctions PURES du front (`dessinerPli`, `pied`, `normaliserLettre`…)
// s'éprouvent déjà : elles rendent des chaînes. Mais le défaut du 22/08 n'est
// dans AUCUNE d'elles — il est dans la POSE : `retamponner` refaisait le
// cachet et le pied, et laissait sur le papier le morceau qu'il n'avait pas
// nommé. L'écran affichait donc « Accusée » ET « En souffrance depuis 9 h »
// sur la même lettre, alors que chaque fonction, prise seule, disait vrai.
//
// Une revue de code aurait dit « ça a l'air bon ». Il fallait un INSTRUMENT
// qui pose vraiment le dessin sur un papier et le relise après le geste.
// `jsdom` n'est pas une option (ce dépôt n'a AUCUNE devDependency, et en
// ajouter une pour un défaut d'affichage serait payer très cher un très petit
// besoin). Ce papier-ci suffit : il n'implémente QUE ce que la page appelle
// vraiment sur un pli, et il le dit — tout le reste lève, plutôt que de rendre
// un silence qu'on prendrait pour un pass (trois issues : conforme,
// incohérence, SONDE IMPOSSIBLE).
//
// ⚠️ CE N'EST PAS UN NAVIGATEUR, et ça ne doit jamais prétendre l'être. Il ne
// sait lire qu'un sélecteur de CLASSE (`.pli__tete`), et il le fait par un
// balayage de balises — pas par un vrai analyseur HTML. C'est assez pour le
// dessin du pli, qui est écrit trois fonctions plus haut dans le même dépôt.

// Les balises qui n'ont pas de fermante. `circle`, `path` et `text` viennent du
// cachet (SVG), `br` du corps d'une lettre à plusieurs lignes.
const SANS_FERMANTE = new Set(["br", "hr", "img", "input", "meta", "link", "circle", "path", "rect", "line", "use"]);

// Toutes les balises d'un fragment, dans l'ordre, avec leurs bornes. Le corps
// et les objets sont ÉCHAPPÉS par la page (`echapper`) : aucun `<` ni `>` brut
// ne peut donc apparaître dans du texte, et un balayage naïf est exact ici.
function balises(html) {
  const trouvees = [];
  const motif = /<(\/?)([a-zA-Z][\w:-]*)([^>]*?)(\/?)>/g;
  let m;
  while ((m = motif.exec(html)) !== null) {
    trouvees.push({
      debut: m.index,
      fin: motif.lastIndex,
      fermante: m[1] === "/",
      nom: m[2].toLowerCase(),
      attributs: m[3],
      autoFermante: m[4] === "/" || SANS_FERMANTE.has(m[2].toLowerCase())
    });
  }
  return trouvees;
}

function porteLaClasse(attributs, classe) {
  const m = /class="([^"]*)"/.exec(attributs);
  return Boolean(m) && m[1].split(/\s+/).includes(classe);
}

// La ZONE d'un élément : de sa balise ouvrante à sa fermante, appariées par
// profondeur. Rend `null` quand la classe n'est pas là — et LÈVE quand la
// balise n'est jamais refermée : un fragment mal formé est une sonde
// impossible, jamais un « pas trouvé ».
function zoneDeLaClasse(html, classe) {
  const tags = balises(html);
  for (let i = 0; i < tags.length; i += 1) {
    const ouvrant = tags[i];
    if (ouvrant.fermante || !porteLaClasse(ouvrant.attributs, classe)) continue;
    if (ouvrant.autoFermante) return { debut: ouvrant.debut, fin: ouvrant.fin, ouvrant };
    let profondeur = 1;
    for (let j = i + 1; j < tags.length; j += 1) {
      const t = tags[j];
      if (t.nom !== ouvrant.nom || t.autoFermante) continue;
      profondeur += t.fermante ? -1 : 1;
      if (profondeur === 0) return { debut: ouvrant.debut, fin: t.fin, ouvrant };
    }
    throw new Error(`SONDE IMPOSSIBLE : <${ouvrant.nom} class="…${classe}…"> n'est jamais refermée`);
  }
  return null;
}

// La poignée que la page manipule : `outerHTML`, `remove()`, `classList.add()`.
// Elle recalcule ses bornes à CHAQUE geste — la page enchaîne les écritures, et
// des bornes figées désigneraient du vide au deuxième coup.
function poignee(papier, classe, zoneInitiale) {
  let zone = zoneInitiale;
  const relire = () => {
    const fraiche = zoneDeLaClasse(papier.innerHTML, classe);
    if (fraiche) zone = fraiche;
    return zone;
  };
  return {
    get outerHTML() {
      const z = relire();
      return papier.innerHTML.slice(z.debut, z.fin);
    },
    set outerHTML(neuf) {
      const z = relire();
      papier.innerHTML = papier.innerHTML.slice(0, z.debut) + neuf + papier.innerHTML.slice(z.fin);
    },
    remove() {
      const z = relire();
      papier.innerHTML = papier.innerHTML.slice(0, z.debut) + papier.innerHTML.slice(z.fin);
    },
    classList: {
      add(...classes) {
        const z = relire();
        const balise = papier.innerHTML.slice(z.ouvrant.debut, z.ouvrant.fin);
        const neuve = balise.replace(/class="([^"]*)"/, (_, valeur) => {
          const deja = valeur.split(/\s+/).filter(Boolean);
          for (const c of classes) if (!deja.includes(c)) deja.push(c);
          return `class="${deja.join(" ")}"`;
        });
        papier.innerHTML =
          papier.innerHTML.slice(0, z.ouvrant.debut) + neuve + papier.innerHTML.slice(z.ouvrant.fin);
      }
    }
  };
}

// LE PAPIER. Exactement la surface que la page touche sur un `<article class="pli">` :
// `className`, `innerHTML`, `dataset`, `querySelector`, `insertAdjacentHTML`.
export function papierDeTest(html = "") {
  const papier = {
    className: "",
    innerHTML: html,
    dataset: {},
    querySelector(selecteur) {
      if (!selecteur.startsWith(".") || /[\s>,:[]/.test(selecteur.slice(1))) {
        throw new Error(`SONDE IMPOSSIBLE : ce papier ne lit qu'un sélecteur de classe simple (« ${selecteur} »)`);
      }
      const classe = selecteur.slice(1);
      const zone = zoneDeLaClasse(papier.innerHTML, classe);
      return zone ? poignee(papier, classe, zone) : null;
    },
    insertAdjacentHTML(position, fragment) {
      if (position !== "beforeend") {
        throw new Error(`SONDE IMPOSSIBLE : ce papier ne sait coller qu'en « beforeend » (« ${position} »)`);
      }
      papier.innerHTML += fragment;
    }
  };
  return papier;
}
