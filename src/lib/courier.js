// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LE DÉPÔT — porter une lettre jusqu'à la boîte aux lettres d'une session vivante.
//
// ⚠️ VOCABULAIRE (amendement A1) — cette pièce ne rend JAMAIS « livré ».
// Son seul succès possible s'appelle « REMIS AU GUICHET » : la boîte a accepté les
// octets. Rien de plus. Le portier du destinataire peut jeter la lettre EN SILENCE
// juste après (limiteur de rafale, dédoublonnage sur corps identique, gate qui
// parque) : « remis au guichet » ne prouve donc ni que la lettre est arrivée dans la
// conversation, ni qu'elle a été vue. La seule preuve d'arrivée est l'ACCUSÉ que le
// destinataire renvoie lui-même. C'est pourquoi les deux états de succès s'appellent
// `remis-au-guichet` et `remis-au-guichet-fermeture-subie` — ils disent QUI a refermé
// la porte, jamais que la lettre est arrivée. Aucune fonction d'ici ne rend, ni ne
// signifie, « livré ».
//
// ⚠️ LA PROMESSE (amendement A8) — livraison AU MOINS UNE FOIS. On préfère un doublon
// à une lettre perdue. Toutes les frontières douteuses de ce module se tranchent dans
// ce sens-là, et jamais dans l'autre.
//
// ⚠️ VERROU D'INCARNATION (amendement A3) — l'enveloppe porte TOUJOURS `session_id`,
// et cela s'exige aux DEUX bouts : `buildEnvelope` lève sans lui, `remettreAuGuichet`
// refuse de porter sans lui (`defautDEnveloppe`). Une promesse tenue au seul
// constructeur n'est pas tenue : le Facteur peut fabriquer une enveloppe ailleurs.
// Le protocole jette en silence une lettre dont le `session_id` ne correspond pas à
// la session assise dans la boîte : c'est précisément la garde qu'on veut. Sans
// elle, une fiche de registre périmée plus un PID recyclé remettent le courrier à la
// MAUVAISE PERSONNE. Une lettre jetée pour incarnation périmée n'est pas une perte :
// elle n'est pas accusée, donc elle repart à la tournée suivante.

import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";

const FERMETURE = "</cross-session-message>";
const FERMETURE_NEUTRALISEE = "<\\/cross-session-message>";
// La balise OUVRANTE se neutralise comme la fermante (revue sécurité F4/F7, 18/10) :
// un corps qui portait `<cross-session-message from="operateur">` ouvrait un second
// pli, avec l'expéditeur de son choix, à l'intérieur du premier. Même geste : un
// antislash après le chevron — la balise reste lisible dans le texte, elle n'ouvre rien.
const OUVERTURE = "<cross-session-message";
const OUVERTURE_NEUTRALISEE = "<\\cross-session-message";

// Un attribut du pli ne peut porter ni guillemet, ni chevron, ni saut de ligne :
// le destinataire re-sérialise l'en-tête et le compare au sien à l'octet près.
const CARACTERES_INTERDITS_EN_ATTRIBUT = /["<>\r\n]/g;

export function nettoyerAttribut(valeur) {
  return String(valeur ?? "").replace(CARACTERES_INTERDITS_EN_ATTRIBUT, "");
}

// L'ORDRE DES ATTRIBUTS EST STRICT (recon-socket-natif §4) : from, from-session,
// hop-chain, from-name, from-mode. Un seul octet d'écart et le destinataire
// abandonne toutes les métadonnées de la lettre — sans le dire.
export function buildWrapper({ from, fromSession, hopChain, fromName, fromMode, text }) {
  const corps = String(text ?? "")
    .split(FERMETURE).join(FERMETURE_NEUTRALISEE)
    .split(OUVERTURE).join(OUVERTURE_NEUTRALISEE);
  return (
    `<cross-session-message from="${nettoyerAttribut(from)}"` +
    ` from-session="${nettoyerAttribut(fromSession)}"` +
    ` hop-chain="${nettoyerAttribut(hopChain)}"` +
    ` from-name="${nettoyerAttribut(fromName)}"` +
    ` from-mode="${nettoyerAttribut(fromMode)}">\n` +
    `${corps}\n${FERMETURE}`
  );
}

// Le Facteur porte en "next" et ne promet rien d'autre : "now" ne court-circuite
// qu'une partie de la chaîne du destinataire, ce n'est PAS « vu tout de suite ».
const PRIORITES = new Set(["now", "next", "later"]);

export function buildEnvelope({ msgId, content, priority = "next", from, sessionId }) {
  if (typeof content !== "string" || content.length === 0) {
    throw new TypeError(
      "courier: the letter body is empty or not text; the recipient would lose it silently"
    );
  }
  if (typeof from !== "string" || from.trim() === "") {
    throw new TypeError(
      "courier: envelope without a return address (from); the recipient would have nowhere to send its acknowledgement"
    );
  }
  if (typeof sessionId !== "string" || sessionId.trim() === "") {
    throw new TypeError(
      "courier: envelope without session_id; the incarnation lock is mandatory (amendment A3)"
    );
  }
  if (!PRIORITES.has(priority)) {
    throw new TypeError(`courier: unknown priority "${priority}"; expected now, next or later`);
  }
  return {
    msgV: 1,
    msg_id: msgId || `facteur-${crypto.randomUUID()}`,
    type: "user",
    message: { role: "user", content },
    priority,
    from,
    // Le verrou d'incarnation : la lettre n'entre que si la bonne personne est assise
    // dans la boîte. Sinon elle est jetée en silence — et repart, faute d'accusé.
    session_id: sessionId
  };
}

// LA GARDE DU SAC — ce qui rend une enveloppe irrecevable au guichet.
//
// ⚠️ Cette garde existe parce que le verrou d'incarnation (A3) doit se tenir au point
// de SORTIE, pas seulement chez le constructeur. `buildEnvelope` protège qui l'appelle ;
// `remettreAuGuichet` sera appelée par le Facteur avec une enveloppe qui n'est pas
// forcément passée par lui (reprise sur disque, rejeu d'une tournée, appel direct).
// Sans elle, `JSON.stringify(undefined)` porte la chaîne littérale « undefined »
// jusqu'à la boîte et le verdict rend « remis au guichet » — après quoi T4 poserait
// `carried_at` sur une lettre qui n'est jamais partie. C'est A7 appliqué à notre
// propre code : on n'affirme jamais une remise qu'on n'a pas faite.
//
// ⚠️ Elle exige les MÊMES QUATRE champs que `buildEnvelope`, `from` compris : une
// lettre sans adresse de retour ne peut recevoir AUCUN accusé, et sous A9 (« accusé
// nul ⇒ la lettre revient ») elle repartirait à chaque tournée, éternellement. La
// laisser partir serait affirmer une remise dont on sait déjà qu'elle ne sera jamais
// confirmée.
//
// Rend `null` si l'enveloppe est portable, sinon la phrase qui NOMME le défaut.
export function defautDEnveloppe(envelope) {
  if (!envelope || typeof envelope !== "object") {
    return "envelope missing, or not an envelope";
  }
  if (typeof envelope.session_id !== "string" || envelope.session_id.trim() === "") {
    return "session_id missing; the incarnation lock is mandatory (A3)";
  }
  if (typeof envelope.msg_id !== "string" || envelope.msg_id.trim() === "") {
    return "msg_id missing; without an identifier neither the acknowledgement nor the marking can find the letter";
  }
  if (typeof envelope.from !== "string" || envelope.from.trim() === "") {
    return "return address (from) missing; the recipient would have nowhere to send its acknowledgement";
  }
  const corps = envelope.message?.content;
  if (typeof corps !== "string" || corps.length === 0) {
    return "letter body empty or not text (message.content)";
  }
  return null;
}

// Une adresse de boîte s'écrit "uds:" + le chemin absolu percent-encodé (recon §4).
export function adresseUds(socketPath) {
  return `uds:${encodeURIComponent(path.resolve(socketPath))}`;
}

// L'adresse où le Facteur reçoit ses reçus. Amendement A5 : JAMAIS un répertoire en
// dur — il se déduit de celui de la boîte du destinataire (qui peut vivre sous
// /tmp/cc-socks, $XDG_RUNTIME_DIR/cc-socks ou /tmp/cc-socks-<uid>). Le destinataire
// ne renvoie ses reçus qu'à une adresse du MÊME répertoire que sa propre boîte.
export function adresseDeRecu(socketDestinataire, nomDuSocketFacteur) {
  const repertoire = path.dirname(path.resolve(socketDestinataire));
  return adresseUds(path.join(repertoire, nomDuSocketFacteur));
}

// La ligne exacte qui part sur le fil : une enveloppe, un JSON, un saut de ligne
// (NDJSON). UNE SEULE expression de cette forme dans tout le module — la remise
// écrit ce que la garde a mesuré, jamais autre chose (correctif m3).
export function ligneDEnveloppe(envelope) {
  return `${JSON.stringify(envelope)}\n`;
}

// La taille d'un pli se compte en UNITÉS UTF-16 (amendement A5) : c'est ce que
// compte le destinataire après décodage. « é » et les emoji ne pèsent pas ce qu'ils
// mesurent — un compte d'octets se tromperait dans les deux sens.
// ⚠️ C'est la SEULE mesure du module : la garde de taille appelle cette fonction,
// elle ne recalcule rien de son côté (sinon une mutation n'en touche qu'une moitié).
export function mesurerPli(envelope) {
  return ligneDEnveloppe(envelope).length;
}

// Au-delà de ce tampon de ligne, le destinataire détruit la connexion (recon §1).
// ⚠️ L'UNITÉ DE CE PLAFOND N'EST PAS MESURÉE (correctif m4) : A5 dit que le
// destinataire compte des unités UTF-16 après décodage, la recon décrit un tampon de
// LIGNE dont l'unité n'a jamais été observée. Le nom ne tranche donc pas — il dit
// « ligne », ce qui est vrai sous les deux lectures. Épreuve de banc.
export const PLAFOND_DESTINATAIRE_LIGNE = 1048576;
// Notre garde, posée AVEC MARGE et la marge est CHOISIE, pas subie : un quart du
// plafond. Au pire de l'encodage une unité UTF-16 coûte 3 octets — le facteur 4 tient
// donc sous la lecture « octets » ET laisse de la place pour ce qu'on ne sait pas
// encore (la ligne d'authentification compte-t-elle dans le même tampon ? inconnu).
export const LIMITE_PLI_UNITES_UTF16 = 262144;
// Refermer la porte trop tôt PERD la lettre sur cette plateforme (recon §5.7).
export const LINGER_MS_DEFAUT = 150;
export const DELAI_MAX_MS_DEFAUT = 5000;

// Les deux façons de remettre au guichet. Les deux sont des SUCCÈS (`ok: true`) :
// elles ne se distinguent que par QUI a refermé la porte — une donnée que le banc
// doit pouvoir mesurer sans relire le code.
export const ETAT_REMIS_AU_GUICHET = "remis-au-guichet";
export const ETAT_REMIS_FERMETURE_SUBIE = "remis-au-guichet-fermeture-subie";
export const ETAT_NON_REMIS = "non-remis";

// UN ÉCHEC DÉFINITIF NE SE RÉESSAIE PAS (correctif I4). Ces deux motifs-là ne
// cesseront jamais d'être vrais tant que la lettre elle-même ne change pas : les
// rejouer à chaque tournée est du bruit pur, et sous « rien ne se perd » la lettre
// boucle éternellement au lieu d'être orientée vers le repli. Tous les autres motifs
// sont TRANSITOIRES : la boîte peut rouvrir, le destinataire peut se libérer.
// Le Facteur lit `permanent` sur le verdict — il n'a aucune table à connaître.
export const MOTIFS_DEFINITIFS = new Set(["enveloppe-irrecevable", "pli-trop-gros"]);

// Porter une lettre jusqu'à une boîte et rendre un verdict TYPÉ — jamais une
// exception, jamais une promesse qui pend.
//
// Succès  : { ok: true,  etat: "remis-au-guichet" | "remis-au-guichet-fermeture-subie" }
// Échec   : { ok: false, etat: "non-remis", reason: <motif>, permanent: <bool>,
//             detail?: <indice> }
//
// Motifs, avec leur permanence :
//   DÉFINITIFS (ne plus jamais réessayer, orienter vers le repli) :
//     enveloppe-irrecevable · pli-trop-gros
//   TRANSITOIRES (la tournée suivante peut réussir) :
//     boite-injoignable · delai-depasse · depot-refuse · boite-fermee-avant-remise
//
// Rappel du contrat (A1) : « remis au guichet » ne veut PAS dire « arrivé ». Le
// portier du destinataire jette en silence. Un échec, lui, est franc : la lettre
// n'est pas marquée, elle reste rattrapable par le canal de repli — au pire elle
// est lente, jamais perdue.
export function remettreAuGuichet(
  {
    socketPath,
    token,
    envelope,
    lingerMs = LINGER_MS_DEFAUT,
    timeoutMs = DELAI_MAX_MS_DEFAUT,
    maxUnitesUtf16 = LIMITE_PLI_UNITES_UTF16
  },
  { connect = net.connect, schedule = setTimeout, cancel = clearTimeout } = {}
) {
  return new Promise((resolve) => {
    let regle = false;
    // Les deux minuteries de la remise. Elles sont ANNULABLES : sur un chemin
    // d'échec, une minuterie de fermeture orpheline rappellerait `end()` sur une
    // boîte déjà relâchée — un rappel fantôme par lettre ratée dans un démon qui
    // tourne des semaines (correctif m2).
    let minuteurDelai = null;
    let minuteurFermeture = null;
    const annuler = (minuteur) => {
      if (minuteur === null || minuteur === undefined) return;
      try {
        cancel(minuteur);
      } catch {
        /* une minuterie déjà écoulée n'est pas une panne */
      }
    };
    const arreterLesMinuteurs = () => {
      annuler(minuteurDelai);
      minuteurDelai = null;
      annuler(minuteurFermeture);
      minuteurFermeture = null;
    };

    const conclure = (verdict) => {
      if (!regle) {
        regle = true;
        arreterLesMinuteurs();
        resolve(verdict);
      }
    };
    const remis = (etat) => conclure({ ok: true, etat });
    const nonRemis = (reason, detail) =>
      conclure({
        ok: false,
        etat: ETAT_NON_REMIS,
        reason,
        // La permanence se DÉRIVE du motif : elle ne peut pas diverger de la table.
        permanent: MOTIFS_DEFINITIFS.has(reason),
        ...(detail ? { detail } : {})
      });

    // LA GARDE DU SAC (A3 au point de sortie) : une enveloppe irrecevable ne part
    // pas. On ne dérange même pas la boîte — la connexion n'est pas tentée.
    const defaut = defautDEnveloppe(envelope);
    if (defaut) {
      return nonRemis("enveloppe-irrecevable", defaut);
    }

    // La taille se compte en unités UTF-16, après décodage (A5) : un pli trop gros
    // ferait détruire la connexion sans un mot. On ne dérange même pas la boîte.
    const unites = mesurerPli(envelope);
    if (unites > maxUnitesUtf16) {
      return nonRemis("pli-trop-gros", `${unites}/${maxUnitesUtf16} UTF-16 units`);
    }
    const ligneEnveloppe = ligneDEnveloppe(envelope);

    let boite;
    try {
      boite = connect({ path: socketPath });
    } catch (erreur) {
      return nonRemis("boite-injoignable", erreur?.code || erreur?.message);
    }

    let octetsAcceptes = false; // la boîte a pris les octets : la lettre est partie

    minuteurDelai = schedule(() => {
      try {
        boite.destroy();
      } catch {
        /* une boîte déjà relâchée n'est pas une panne */
      }
      nonRemis("delai-depasse");
    }, timeoutMs);

    boite.on("error", (erreur) => {
      const code = erreur?.code;
      const injoignable = code === "ENOENT" || code === "ECONNREFUSED" || code === "EACCES";
      nonRemis(injoignable ? "boite-injoignable" : "depot-refuse", code || erreur?.message);
    });

    boite.on("close", () => {
      // ⚠️ LA FRONTIÈRE (correctif I1) : elle n'est PAS « qui a refermé la porte »,
      // elle est « les octets étaient-ils partis ». Le destinataire qui lit sa
      // lettre puis referme sa boîte est le cas NOMINAL, pas une avarie : traiter
      // cette fermeture comme un échec rendait `ok:false` sur 100 % des remises
      // RÉUSSIES. Le Facteur ne posait alors jamais `carried_at`, la même lettre
      // repartait à CHAQUE tournée et la rafale se faisait manger par le limiteur
      // du destinataire — le courrier n'avançait jamais.
      //
      // Et poser `carried_at` ici ne perd rien : sous A9, `carried_at` n'est PAS
      // terminal — une lettre non accusée revient dès la fenêtre de grâce écoulée.
      // Le seul marqueur terminal reste l'accusé du destinataire. On préfère donc
      // un doublon retardé à un courrier qui n'avance jamais (A8).
      //
      // L'anti-patron A7 (« je ferme donc c'est livré ») reste tenu par la garde
      // qui suit : sans octets partis, une fermeture ne vaut RIEN.
      if (octetsAcceptes) return remis(ETAT_REMIS_FERMETURE_SUBIE);
      nonRemis("boite-fermee-avant-remise");
    });

    boite.on("connect", () => {
      // Un seul write : la ligne d'authentification PUIS l'enveloppe, en NDJSON.
      // L'authentification est optionnelle ici, mais on présente le jeton quand on
      // l'a — c'est le geste propre.
      const aEcrire =
        (token ? `${JSON.stringify({ type: "auth", token })}\n` : "") + ligneEnveloppe;
      boite.write(aEcrire, (erreur) => {
        if (erreur) {
          return nonRemis("depot-refuse", erreur?.code || erreur?.message);
        }
        octetsAcceptes = true;
        // Le délai de fermeture n'est pas une politesse : refermer trop tôt PERD
        // la lettre (recon §5.7). On attend, puis on referme, puis seulement là on
        // se dit « remis au guichet ».
        minuteurFermeture = schedule(() => {
          boite.end(() => {
            remis(ETAT_REMIS_AU_GUICHET);
            try {
              boite.destroy();
            } catch {
              /* la porte est déjà refermée */
            }
          });
        }, lingerMs);
      });
    });
  });
}
