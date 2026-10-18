#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 VALXOS contributors
# SPDX-License-Identifier: AGPL-3.0-only
# Licence complète : voir LICENSE à la racine du dépôt.
"""VALXOS Messenger Claude plugin monitor.

The monitor binds the selected VALXOS Messenger runtime socket, waits for wake signals,
prints one CC2CC_EVENT line per pending message, marks messages injected, and
removes its socket on SIGINT/SIGTERM.

Propriete du socket: le moniteur ne vole jamais le socket d'un frere vivant.
Au demarrage il essaie de se connecter au socket existant; si quelqu'un
ecoute, il refuse de demarrer. A l'arret il ne supprime que le fichier qu'il a
lui-meme cree, identifie par son inode.
"""

from __future__ import annotations

import argparse
import errno
import hashlib
import json
import os
import pwd
import signal
import socket
import sqlite3
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

EXIT_ALREADY_RUNNING = 3
LEGACY_FALLBACKS_ANNOUNCED: set[Path] = set()


class MonitorAlreadyRunning(RuntimeError):
    """Un moniteur vivant tient deja le socket de cette identite."""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def socket_has_listener(path: Path, timeout: float = 0.5) -> bool:
    """True si quelqu'un ecoute vraiment sur ce socket unix.

    Trois issues, jamais deux: connexion acceptee (vivant), connexion refusee
    ou fichier absent (orphelin), timeout (on suppose vivant - on ne detruit
    jamais sur un doute).
    """
    probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    probe.settimeout(timeout)
    try:
        probe.connect(str(path))
        return True
    except socket.timeout:
        return True
    except OSError:
        return False
    finally:
        probe.close()


def pid_alive(pid: object) -> bool:
    try:
        value = int(pid)
    except (TypeError, ValueError):
        return False
    if value <= 0:
        return False
    try:
        os.kill(value, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False


def process_start_time(pid: object) -> str | None:
    """Miroir EXACT de `procStartOf` (src/lib/postbox.js).

    Les deux implementations doivent produire la MEME chaine pour le meme
    processus: c'est ce croisement qui distingue un pid vivant d'un pid recycle.
    Si elles divergent, chaque chaise vivante passe pour recyclee: la moisson
    de l'operateur tuerait le registre entier, et la garde du jumeau de ce
    moniteur (`decider_la_chaise`) prendrait un jumeau vivant pour un mort.

    Deux pieges, tous deux payes par le cote Node et repris ici tels quels:
      - `LC_ALL=C TZ=UTC`: sans ca, `ps` rend l'heure dans la langue et le
        fuseau du shell. Ecrite en UTC et relue en heure locale, la meme
        seconde donne deux chaines differentes.
      - PAS de branche `/proc/PID/stat`: elle rend des jiffies depuis le boot,
        un format que le cote Node n'ecrit JAMAIS. La lire sur Linux, ce serait
        comparer une date a un compteur.
    """
    try:
        value = int(pid)
    except (TypeError, ValueError):
        return None
    if value <= 1:
        return None
    try:
        done = subprocess.run(
            ["/bin/ps", "-o", "lstart=", "-p", str(value)],
            capture_output=True,
            text=True,
            timeout=5,
            env={**os.environ, "LC_ALL": "C", "TZ": "UTC"},
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return done.stdout.strip() or None


def normaliser_naissance(valeur: str) -> str:
    return " ".join(str(valeur).split()).strip()


def peer_liveness(pid: object, proc_start: object) -> tuple[str, str]:
    """TROIS issues, jamais deux — le miroir de `verdictDeChaise` (registry.js).

    « Je n'ai pas pu savoir » n'est PAS « elle est morte »: une sonde qui n'a
    pas pu tourner ne condamne personne.
      vivante     -> la chaise reste en service
      morte       -> le processus est parti, avec sa raison (ce moniteur ne
                     moissonne jamais: la chaise ne compte simplement plus
                     comme jumeau vivant)
      indecidable -> on S'ABSTIENT, et on la compte a part
    """
    try:
        value = int(pid)
    except (TypeError, ValueError):
        return "indecidable", "sans-pid"
    # Sans numero utilisable on ne conclut pas: une fiche heritee de v1 n'a
    # jamais porte de PID, et la declarer morte retirerait de la circulation
    # une adresse dont on ne sait rien.
    if value <= 1:
        return "indecidable", "sans-pid"
    if not pid_alive(value):
        return "morte", "processus-parti"
    # Le numero vit — mais est-ce le MEME processus ? Sans heure de naissance
    # inscrite, la question n'a pas de reponse et on GARDE la chaise.
    inscrite = str(proc_start).strip() if proc_start else ""
    if not inscrite:
        return "vivante", "pid-vivant"
    observee = process_start_time(value)
    if not observee:
        return "indecidable", "sonde-impossible"
    if normaliser_naissance(observee) == normaliser_naissance(inscrite):
        return "vivante", "meme-incarnation"
    return "morte", "pid-recycle"


# ── LA CHAISE RECEPTRICE (Run 6, Task 6, 27/09) ────────────────────────────
# Miroir EXACT de `deciderLaChaise` (src/lib/identity.js). Un test joue le meme
# tableau des deux cotes (test/monitor.test.js, « PARITE ») : toucher l'une sans
# l'autre, c'est un moniteur qui sert une lettre que les hooks refusent.
#   agent_id present                   -> sous-agent                 (refus)
#   pas de session                     -> sans-session               (recoit)
#   ma fiche porte une autre session   -> fiche-d-une-autre-session  (refus)
#   chaise a un AUTRE pid, vivant ET confirme (meme-incarnation) -> jumeau (refus)
#   sinon                              -> chaise                     (recoit)
def _meme_nombre(a: object, b: object) -> bool:
    # `Number(a) === Number(b)` cote Node : null vaut 0, un texte non numerique
    # vaut NaN (jamais egal a rien, pas meme a lui-meme).
    def nombre(v: object) -> float:
        if v is None:
            return 0.0
        if isinstance(v, bool):
            return float(v)
        try:
            return float(str(v).strip() or 0)
        except ValueError:
            return float("nan")
    x, y = nombre(a), nombre(b)
    return x == y


def decider_la_chaise(agent_id: object, session_id: object, fiche_session_id: object,
                      pid: object, chaise: dict | None) -> dict:
    if agent_id:
        return {"recoit": False, "raison": "sous-agent"}
    if not session_id:
        return {"recoit": True, "raison": "sans-session"}
    if fiche_session_id and fiche_session_id != session_id:
        return {"recoit": False, "raison": "fiche-d-une-autre-session"}
    # Jumeau seulement sur une identite CONFIRMEE (fix 1) : jamais sur
    # l'optimiste « pid-vivant » (pid vivant, aucune naissance inscrite).
    if (chaise and not _meme_nombre(chaise.get("pid"), pid) and chaise.get("etat") == "vivante"
            and chaise.get("raison") == "meme-incarnation"):
        return {"recoit": False, "raison": "jumeau"}
    return {"recoit": True, "raison": "chaise"}


# LA COPIE CC (Run 6, Task 7, 27/09) — miroir de `deciderLaCopie`
# (src/lib/registry.js). Une lettre a la LIGNEE est a la chaise que le guichet
# designe ; chaque autre chaise vivante en voit une copie (une fois, jamais
# livree). Lignee ambigue (aucune designee, ou designee morte) : la lettre est
# tenue, chaque chaise voit la copie avec le drapeau sans-chaise-designee.
# test/monitor.test.js joue le meme tableau des deux cotes (« PARITE : la regle
# de la copie cc »). Toucher l'un sans l'autre, c'est un moniteur qui montre ce
# que les hooks taisent.
def decider_la_copie(lignee: object, session_id: object, resolution: dict | None) -> dict:
    def non(raison: str, designee: object = None) -> dict:
        return {"copie": False, "raison": raison, "chaise_designee": designee, "sans_chaise_designee": False}
    nom = str(lignee or "").strip()
    if not session_id:
        return non("sans-session")
    cibles = (resolution or {}).get("targets") or []
    de_ma_lignee = bool(nom) and len(cibles) > 0 and all((c or {}).get("lineage") == nom for c in cibles)
    if not de_ma_lignee:
        return non("hors-lignee")
    kind = resolution.get("kind")
    if kind == "lineage" and len(cibles) == 1:
        cible = cibles[0]
        if cible.get("instance_session_id") == session_id:
            return non("destinataire", cible.get("id") or None)
        return {"copie": True, "raison": "cc", "chaise_designee": cible.get("id") or None, "sans_chaise_designee": False}
    if kind == "ambigu":
        return {"copie": True, "raison": "sans-chaise-designee", "chaise_designee": None, "sans_chaise_designee": True}
    return non("hors-lignee")


# Meme clef que `cleDeRefus` (identity.js) : un refus se dit UNE fois par
# (raison, session, sous-agent, pid), que ce soit un hook ou le moniteur.
def cle_de_refus(raison: str, session_id: object = None, agent_id: object = None, pid: object = None) -> str:
    brut = f"{raison}|{session_id or ''}|{agent_id or ''}|{'' if pid is None else pid}"
    return hashlib.sha256(brut.encode("utf-8")).hexdigest()[:32]


# = MAISONS_PAR_DEFAUT (src/lib/config.js) : `~/.claude` seulement, plus la
# maison designee (`CLAUDE_CONFIG_DIR`) quand elle en est une autre (18/10) ;
# le reste se declare (`VALXOS_MAISONS`). Voir known_houses ci-dessous.
HOUSES_DEFAULT = [".claude"]


def parent_pid(pid: int) -> int | None:
    try:
        out = subprocess.run(
            ["/bin/ps", "-o", "ppid=", "-p", str(pid)], capture_output=True, text=True, timeout=2
        ).stdout.strip()
        return int(out) if out else None
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def session_fiche_of_ancestors(max_depth: int = 4) -> tuple[int, str] | None:
    """(pid, session_id) de la premiere fiche de session trouvee en remontant.

    Le moniteur est lance par le harnais : la session est un de ses ancetres.
    On ne lit que la fiche AU NUMERO de chaque ancetre, dans la maison declaree
    (`CLAUDE_CONFIG_DIR`) sinon dans les maisons connues — jamais tout un
    registre. Inconnu se dit None.
    """
    declared = os.environ.get("CLAUDE_CONFIG_DIR")
    houses = [Path(declared)] if declared else known_houses()
    pid: int | None = os.getppid()
    for _ in range(max_depth):
        if not pid or pid <= 1:
            return None
        for house in houses:
            try:
                entry = json.loads((house / "sessions" / f"{pid}.json").read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if isinstance(entry, dict) and entry.get("sessionId"):
                return pid, str(entry["sessionId"])
        pid = parent_pid(pid)
    return None


def known_houses() -> list[Path]:
    """Mirrors maisonsConnues (src/lib/config.js), case for case.

    Review M2: the declared houses first (VALXOS_MAISONS, legacy
    CC2CC_MAISONS); a declaration replaces the default entirely. Otherwise
    `~/.claude`, plus the designated house (`CLAUDE_CONFIG_DIR`) when it is
    another one. test/facteur.test.js compares both sides.
    """
    listed = [h.strip() for h in str(env_value("CC2CC_MAISONS") or "").split(os.pathsep) if h.strip()]
    if listed:
        return [Path(h) for h in listed]
    houses = [home_dir() / h for h in HOUSES_DEFAULT]
    designated = (os.environ.get("CLAUDE_CONFIG_DIR") or "").strip()
    if designated and all(os.path.abspath(str(h)) != os.path.abspath(designated) for h in houses):
        houses.append(Path(os.path.abspath(designated)))
    return houses


def session_of_ancestors(max_depth: int = 4) -> str | None:
    found = session_fiche_of_ancestors(max_depth)
    return found[1] if found else None


def safe_agent_file_name(agent_id: str) -> str:
    return "".join(ch if ch.isalnum() or ch in "_.-" else "_" for ch in agent_id)[:64]


def valxos_key(legacy_key: str) -> str:
    if legacy_key == "CC2CC_V2_HOME":
        return "VALXOS_MESSENGER_HOME"
    return legacy_key.replace("CC2CC_", "VALXOS_", 1)


def env_value(legacy_key: str) -> str | None:
    new_key = valxos_key(legacy_key)
    if new_key in os.environ:
        return os.environ.get(new_key)
    return os.environ.get(legacy_key)


# The marker migrate-home writes into a COMPLETE new office. Without it (or a
# symlink to the legacy office) an existing ~/.valxos-messenger proves nothing.
# Mirrors MARQUEUR_BUREAU in src/lib/config.js; a test holds the parity.
MARKER = ".valxos-messenger-home"


def home_dir_line() -> str:
    """Mirrors ligneDomicileIntrouvable in src/lib/config.js."""
    return "VALXOS Messenger: HOME is empty or relative and the account has no absolute home; set HOME to an absolute path. Nothing was done."


def home_dir() -> Path:
    """Mirrors domicile() in src/lib/config.js (N5): an absolute HOME wins;
    empty or relative, the account's passwd home; neither, one line, exit 2."""
    declared = os.environ.get("HOME") or ""
    if declared and os.path.isabs(declared):
        return Path(declared)
    try:
        account = pwd.getpwuid(os.getuid()).pw_dir or ""
    except (KeyError, OSError):
        account = ""
    if account and os.path.isabs(account):
        return Path(account)
    sys.stderr.write(home_dir_line() + "\n")
    sys.exit(2)


def relative_office_line(key: str, value: str) -> str:
    """Mirrors ligneBureauRelatif in src/lib/config.js; a test holds the parity."""
    return f"VALXOS Messenger: {key}={value} is not an absolute path; set an absolute path (or ~/...). Nothing was done."


EMPTY_NEW_OFFICE_ANNOUNCED = False


def empty_new_office_line(legacy_value: str) -> str:
    """Mirrors ligneBureauNeufVide in src/lib/config.js; a test holds the parity."""
    return f"VALXOS Messenger: VALXOS_MESSENGER_HOME is set but empty; using CC2CC_V2_HOME={legacy_value}."


def explicit_office() -> Path | None:
    """Mirrors bureauExplicite (src/lib/config.js, F2): `~` and `~/...` expand
    against HOME, an absolute path is kept, anything else is refused with one
    stderr line naming the variable and exit 2 - never resolved against cwd."""
    global EMPTY_NEW_OFFICE_ANNOUNCED
    new_key = valxos_key("CC2CC_V2_HOME")
    new_value = str(os.environ.get(new_key) or "").strip() if new_key in os.environ else None
    legacy_value = str(os.environ.get("CC2CC_V2_HOME") or "").strip()
    key, value = new_key, new_value
    if not new_value:
        # F9: an empty new key counts as absent (mirrors bureauExplicite).
        key, value = "CC2CC_V2_HOME", legacy_value
        if new_value == "" and legacy_value and not EMPTY_NEW_OFFICE_ANNOUNCED:
            EMPTY_NEW_OFFICE_ANNOUNCED = True
            sys.stderr.write(empty_new_office_line(legacy_value) + "\n")
    if not value:
        return None
    home = home_dir()
    # M-4: the same string as bureauExplicite (Node) - normalised, and `~//x`
    # like `~/x` (what a shell does).
    if value == "~":
        return Path(os.path.normpath(str(home)))
    if value.startswith("~/"):
        return Path(os.path.normpath(os.path.join(str(home), value[2:].lstrip("/"))))
    if os.path.isabs(value):
        # POSIX normpath keeps exactly two leading slashes (`//x`); Node's
        # path.resolve folds them to one. Fold here too (review M-3).
        return Path(os.path.normpath("/" + value.lstrip("/")))
    sys.stderr.write(relative_office_line(key, value) + "\n")
    sys.exit(2)


def base_dir() -> Path:
    explicit = explicit_office()
    if explicit is not None:
        return explicit
    new = home_dir() / ".valxos-messenger"
    legacy = home_dir() / ".cc2cc-v2"  # legacy (cc2cc-v2 era)
    is_link = new.is_symlink()
    if is_link:
        try:
            if new.resolve(strict=True) == legacy.resolve(strict=True):
                return new
        except OSError:
            pass  # broken link or no legacy office: not a proof
    if (new / MARKER).is_file():  # a directory named like the marker proves nothing
        return new
    if legacy.exists():
        if legacy not in LEGACY_FALLBACKS_ANNOUNCED:
            LEGACY_FALLBACKS_ANNOUNCED.add(legacy)
            if is_link or new.exists():
                sys.stderr.write(
                    f"VALXOS Messenger: unproven office ignored - {new} is neither a symlink to {legacy} "
                    f"nor marked {MARKER}; using historical runtime {legacy}.\n"
                )
            else:
                sys.stderr.write(
                    f"VALXOS Messenger: compatibility - using historical runtime {legacy}; "
                    f"the new default is {new}. Run valxos-migrate-home to copy explicitly.\n"
                )
        return legacy
    return new


def self_id() -> str:
    value = env_value("CC2CC_SELF") or env_value("CC2CC_SESSION_NAME")
    if value:
        return safe_agent_file_name(value.strip())
    return safe_agent_file_name(socket.gethostname().split(".")[0] or "valxos-agent")


class Monitor:
    def __init__(self) -> None:
        self.root = base_dir()
        self.agent_id = self_id()
        self.run_dir = self.root / "run"
        self.status_dir = self.root / "status"
        self.logs_dir = self.root / "logs"
        self.db_path = self.root / "broker.db"
        self.sock_path = self.run_dir / f"{safe_agent_file_name(self.agent_id)}.sock"
        self.pid_path = self.run_dir / f"{safe_agent_file_name(self.agent_id)}.pid"
        self.server: socket.socket | None = None
        self.sock_inode: int | None = None
        self.running = True
        # La session dont ce moniteur releve le courrier, et le pid qui la
        # porte (la fiche de session d'un ancetre). None : aucune lettre de
        # lignee n'est relevee ici — les hooks et le Facteur la portent (A9).
        found = session_fiche_of_ancestors()
        self.session_pid: int | None = found[0] if found else None
        self.session_id: str | None = found[1] if found else None

    def ensure_dirs(self) -> None:
        # 0700, comme `ensureRuntimeDirs` cote Node (config.js) : le moniteur est un
        # processus automatique du plugin, il peut naitre le premier sur un bureau
        # neuf, et un dossier cree sans mode sous l'umask 022 exposait le courrier de
        # la maison a tout compte de la machine (revue securite F1, 18/10).
        for directory in (self.root, self.run_dir, self.status_dir, self.logs_dir):
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)

    def sibling_pid(self) -> int | None:
        try:
            return int(self.pid_path.read_text(encoding="utf-8").strip())
        except (OSError, ValueError):
            return None

    def describe_sibling(self) -> str:
        pid = self.sibling_pid()
        if pid is None:
            return "PID unknown"
        return f"PID {pid}" if pid_alive(pid) else f"PID {pid} (stale .pid file)"

    def claim_socket(self) -> None:
        """Ne prendre le socket que s'il n'appartient a personne de vivant."""
        if not os.path.lexists(self.sock_path):
            return
        if socket_has_listener(self.sock_path):
            raise MonitorAlreadyRunning(
                f"POLITE REFUSAL (intended behaviour, not a failure): a monitor "
                f"{self.agent_id} is already listening on {self.sock_path} "
                f"({self.describe_sibling()}); this monitor refuses to start "
                "rather than steal a live monitor's socket. Nothing to repair: "
                "the doorbell stays with the first monitor, and the Facteur keeps serving "
                "this session through the native mailbox."
            )
        self.log("orphan socket replaced", socket=str(self.sock_path))
        try:
            self.sock_path.unlink()
        except FileNotFoundError:
            pass

    def setup(self) -> None:
        self.ensure_dirs()
        self.claim_socket()
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            self.server.bind(str(self.sock_path))
        except OSError as exc:
            self.server.close()
            self.server = None
            # SEUL EADDRINUSE veut dire « quelqu'un a pris le socket pendant
            # qu'on demarrait ». Un chemin trop long pour AF_UNIX, un repertoire
            # absent, un droit refuse: ce sont des pannes A NOUS. Les faire
            # passer pour un frere vivant envoie l'operateur chercher un
            # moniteur qui n'existe pas, et rend un code de sortie qui dit
            # « tout va bien, un autre tourne » — le reveil ne marche plus et
            # personne ne sait pourquoi.
            if exc.errno != errno.EADDRINUSE:
                raise
            # Course entre deux demarrages simultanes: l'autre a gagne le bind.
            raise MonitorAlreadyRunning(
                f"a monitor {self.agent_id} took {self.sock_path} during startup "
                f"({self.describe_sibling()}): {exc}"
            ) from exc
        # L'inode fait foi: a l'arret on ne supprime que ce fichier-la. On le
        # releve AVANT listen(): entre bind() et listen(), un frere qui sonde
        # recoit ECONNREFUSED, croit a un orphelin et prend la place. Relever
        # l'inode apres, ce serait memoriser le SIEN et l'effacer a notre sortie.
        self.sock_inode = os.stat(self.sock_path).st_ino
        pause_ms = env_value("CC2CC_MONITOR_DEBUG_PAUSE_AFTER_BIND_MS")
        if pause_ms:  # crochet de TEST uniquement: elargit la fenetre bind->listen
            time.sleep(int(pause_ms) / 1000.0)
        self.server.listen(8)
        self.server.settimeout(1.0)
        try:
            present = os.stat(self.sock_path).st_ino
        except FileNotFoundError:
            present = None
        if present != self.sock_inode:
            # Le fichier n'est plus le notre: un frere l'a pris pendant la
            # fenetre. Continuer ferait de nous un fantome; nous retirer laisse
            # UN moniteur vivant, le sien — c'est l'invariant qui compte.
            self.server.close()
            self.server = None
            self.sock_inode = None
            self.log("socket taken during startup", socket=str(self.sock_path))
            raise MonitorAlreadyRunning(
                f"a monitor {self.agent_id} took {self.sock_path} during startup "
                f"({self.describe_sibling()}); this monitor withdraws without touching it"
            )
        self.write_pid_file()
        self.write_heartbeat("active")
        # Dire qu'on DEMARRE, et avec quoi. Sept semaines de log ne portaient que
        # des arrets: impossible de savoir quel PID tenait quel socket, et le
        # fichier de statut est ecrase par un autre ecrivain. Cette ligne est la
        # seule trace durable du bind.
        self.log(
            "monitor started",
            pid=os.getpid(),
            agent=self.agent_id,
            socket=str(self.sock_path),
            inode=self.sock_inode,
        )

    def write_pid_file(self) -> None:
        tmp = self.run_dir / f"{safe_agent_file_name(self.agent_id)}.pid.tmp.{os.getpid()}"
        tmp.write_text(f"{os.getpid()}\n", encoding="utf-8")
        tmp.replace(self.pid_path)

    def remove_pid_file(self) -> None:
        if self.sibling_pid() != os.getpid():
            return
        try:
            self.pid_path.unlink()
        except OSError:
            pass

    def connect_db(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path), timeout=3)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=3000")
        self.ensure_schema(conn)
        return conn

    def ensure_schema(self, conn: sqlite3.Connection) -> None:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS messages (
              seq INTEGER PRIMARY KEY AUTOINCREMENT,
              msg_id TEXT UNIQUE NOT NULL,
              sender TEXT NOT NULL,
              recipient TEXT NOT NULL,
              thread_id TEXT,
              subject TEXT,
              body TEXT NOT NULL,
              priority TEXT NOT NULL DEFAULT 'normal',
              msg_type TEXT NOT NULL DEFAULT 'message',
              created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
              delivered_at TEXT,
              injected_at TEXT,
              acked_at TEXT,
              source TEXT,
              raw_json TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_messages_recipient_injected
              ON messages(recipient, injected_at, seq);
            CREATE TABLE IF NOT EXISTS delivery_events (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              msg_id TEXT,
              agent_id TEXT,
              event_type TEXT NOT NULL,
              event_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
              detail_json TEXT
            );
            """
        )
        conn.commit()

    def write_heartbeat(self, status: str) -> None:
        payload = {
            "agent": self.agent_id,
            "timestamp": now_iso(),
            "pid": os.getpid(),
            "status": status,
            "socket": str(self.sock_path),
        }
        tmp = self.status_dir / f"{self.agent_id}.json.tmp.{os.getpid()}"
        target = self.status_dir / f"{self.agent_id}.json"
        tmp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        tmp.replace(target)

    def log(self, message: str, **data: object) -> None:
        payload = {"ts": now_iso(), "message": message, **data}
        with (self.logs_dir / f"{self.agent_id}.log").open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(payload) + "\n")

    def log_once(self, motif: str, message: str, **data: object) -> None:
        """Un refus se dit UNE fois — meme marque que les hooks (identity.js)."""
        try:
            folder = self.run_dir / "chaises-refusees"
            folder.mkdir(parents=True, exist_ok=True, mode=0o700)
            marque = folder / cle_de_refus(motif, data.get("session_id"), data.get("agent_id"), data.get("pid"))
            fd = os.open(str(marque), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            os.close(fd)
        except FileExistsError:
            return
        except OSError:
            return
        self.log(message, **data)

    def chaise(self, conn: sqlite3.Connection) -> dict:
        """La regle de la chaise, appliquee a la session de ce moniteur."""
        ligne = None
        try:
            ligne = conn.execute(
                "SELECT pid, proc_start FROM peers WHERE instance_session_id = ?",
                (self.session_id,),
            ).fetchone()
        except sqlite3.OperationalError:
            ligne = None
        chaise = None
        if ligne is not None:
            etat, raison = peer_liveness(ligne["pid"], ligne["proc_start"])
            chaise = {"pid": ligne["pid"], "etat": etat, "raison": raison}
        # Un moniteur n'est jamais un sous-agent, et sa session VIENT de la
        # fiche : ni agent_id, ni fiche d'une autre session ne peuvent jouer.
        return decider_la_chaise(None, self.session_id, self.session_id, self.session_pid, chaise)

    def may_drain_lineage(self, conn: sqlite3.Connection) -> bool:
        """Miroir de `resoudreNomVivant` marche 2 : la lignee revient-elle a MOI ?"""
        if not self.session_id:
            return False
        try:
            rows = conn.execute(
                "SELECT instance_session_id, is_primary, pid, proc_start FROM peers "
                "WHERE lineage = ? AND instance_session_id IS NOT NULL "
                "AND status NOT IN ('offline', 'dead')",
                (self.agent_id,),
            ).fetchall()
        except sqlite3.OperationalError:
            return False
        if len(rows) == 1:
            return rows[0]["instance_session_id"] == self.session_id
        designees = [r for r in rows if r["is_primary"] is not None and int(r["is_primary"]) == 1]
        # I1: a designee whose process is dead holds nothing (mirrors resoudreNomVivant).
        if len(designees) == 1 and peer_liveness(designees[0]["pid"], designees[0]["proc_start"])[0] == "morte":
            return False
        return len(designees) == 1 and designees[0]["instance_session_id"] == self.session_id

    def resolution_de_lignee(self, conn: sqlite3.Connection) -> dict:
        """Miroir de `resoudreNomVivant` marche 2, pour le nom de lignee de ce moniteur."""
        try:
            rows = conn.execute(
                "SELECT id, instance_session_id, lineage, is_primary, pid, proc_start FROM peers "
                "WHERE lineage = ? AND instance_session_id IS NOT NULL "
                "AND status NOT IN ('offline', 'dead') "
                "ORDER BY registered_at ASC, id ASC",
                (self.agent_id,),
            ).fetchall()
        except sqlite3.OperationalError:
            return {"kind": "unknown", "targets": []}
        chaises = [{"id": r["id"], "instance_session_id": r["instance_session_id"], "lineage": r["lineage"],
                    "is_primary": r["is_primary"], "pid": r["pid"], "proc_start": r["proc_start"]} for r in rows]
        if len(chaises) == 1:
            return {"kind": "lineage", "targets": chaises}
        if len(chaises) > 1:
            designees = [c for c in chaises if c["is_primary"] is not None and int(c["is_primary"]) == 1]
            if len(designees) == 1:
                # I1: a designee whose process is dead (not reaped) holds nothing:
                # the letter is held (mirrors resoudreNomVivant, read-only).
                if peer_liveness(designees[0]["pid"], designees[0]["proc_start"])[0] == "morte":
                    return {"kind": "ambigu", "targets": [c for c in chaises if c["id"] != designees[0]["id"]]}
                return {"kind": "lineage", "targets": designees}
            return {"kind": "ambigu", "targets": chaises}
        return {"kind": "unknown", "targets": []}

    def montrer_les_copies(self, conn: sqlite3.Connection) -> int:
        """La copie cc : visible une fois (marque `cc_vu`, la meme que les hooks), jamais livree."""
        chaise_id = f"{self.agent_id}#{self.session_id}"
        try:
            ligne = conn.execute(
                "SELECT lineage, status FROM peers WHERE id = ? AND instance_session_id = ?",
                (chaise_id, self.session_id),
            ).fetchone()
        except sqlite3.OperationalError:
            return 0
        if ligne is None or ligne["lineage"] != self.agent_id or ligne["status"] in ("offline", "dead"):
            return 0
        verdict = decider_la_copie(self.agent_id, self.session_id, self.resolution_de_lignee(conn))
        if not verdict["copie"]:
            return 0
        rows = conn.execute(
            """
            SELECT m.* FROM messages m
            WHERE m.recipient = ? AND m.acked_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM delivery_events e
                WHERE e.msg_id = m.msg_id AND e.agent_id = ? AND e.event_type = 'cc_vu'
              )
            ORDER BY m.seq ASC
            LIMIT 50
            """,
            (self.agent_id, chaise_id),
        ).fetchall()
        for row in rows:
            event = {
                "type": row["msg_type"],
                "seq": row["seq"],
                "msg_id": row["msg_id"],
                "from": row["sender"],
                "to": row["recipient"],
                "subject": row["subject"],
                "body": row["body"],
                "thread_id": row["thread_id"],
                "priority": row["priority"],
                "created_at": row["created_at"],
                "cc": True,
                "chaise_designee": verdict["chaise_designee"],
                "sans_chaise_designee": verdict["sans_chaise_designee"],
                "note": "Copy for your information, NOT addressed to this session: do not ack it and do not answer as its recipient.",
            }
            print("CC2CC_EVENT " + json.dumps(event, ensure_ascii=False), flush=True)
            conn.execute(
                """
                INSERT INTO delivery_events (msg_id, agent_id, event_type, detail_json)
                VALUES (?, ?, 'cc_vu', ?)
                """,
                (row["msg_id"], chaise_id, json.dumps({"lignee": row["recipient"], "via": "monitor"})),
            )
        return len(rows)

    def drain(self) -> int:
        conn = self.connect_db()
        try:
            if not self.session_id:
                self.log_once(
                    "session-inconnue",
                    "unknown session: no lineage mail",
                    agent=self.agent_id,
                    pid=os.getppid(),
                )
                return 0
            qui = self.chaise(conn)
            if not qui["recoit"]:
                self.log_once(
                    qui["raison"],
                    "chaise_refusee",
                    raison=qui["raison"],
                    session_id=self.session_id,
                    agent_id=None,
                    pid=self.session_pid,
                )
                return 0
            recipients = [f"{self.agent_id}#{self.session_id}"]
            if self.may_drain_lineage(conn):
                recipients.append(self.agent_id)
            holes = ", ".join("?" for _ in recipients)
            rows = conn.execute(
                f"""
                SELECT * FROM messages
                WHERE recipient IN ({holes})
                  AND acked_at IS NULL
                  AND injected_at IS NULL
                ORDER BY seq ASC
                LIMIT 50
                """,
                tuple(recipients),
            ).fetchall()
            for row in rows:
                event = {
                    "type": row["msg_type"],
                    "seq": row["seq"],
                    "msg_id": row["msg_id"],
                    "from": row["sender"],
                    "to": row["recipient"],
                    "subject": row["subject"],
                    "body": row["body"],
                    "thread_id": row["thread_id"],
                    "priority": row["priority"],
                    "created_at": row["created_at"],
                }
                print("CC2CC_EVENT " + json.dumps(event, ensure_ascii=False), flush=True)
                conn.execute(
                    "UPDATE messages SET injected_at = COALESCE(injected_at, ?) WHERE seq = ?",
                    (now_iso(), row["seq"]),
                )
                conn.execute(
                    """
                    INSERT INTO delivery_events (msg_id, agent_id, event_type, detail_json)
                    VALUES (?, ?, 'monitor_injected', ?)
                    """,
                    (row["msg_id"], self.agent_id, "{}"),
                )
            self.montrer_les_copies(conn)
            conn.commit()
            return len(rows)
        finally:
            conn.close()

    def serve(self) -> None:
        self.drain()
        while self.running:
            assert self.server is not None
            try:
                client, _ = self.server.accept()
            except socket.timeout:
                continue
            except OSError:
                if self.running:
                    raise
                break
            with client:
                try:
                    client.recv(1024)
                except OSError:
                    pass
            self.drain()

    def shutdown(self, signum: int | None = None, _frame: object | None = None) -> None:
        self.running = False
        self.write_heartbeat("offline")
        if self.server is not None:
            try:
                self.server.close()
            except OSError:
                pass
        self.release_socket()
        self.remove_pid_file()
        if signum is not None:
            self.log("monitor stopped", signal=signum)

    def release_socket(self) -> None:
        """Ne supprimer que le socket qu'on a soi-meme cree.

        Si le fichier a change d'inode entre-temps, il appartient a quelqu'un
        d'autre: on le laisse en place. C'est exactement le scenario qui a
        casse le reveil d'une autre instance lors de l'incident qui a cree cette garde.
        """
        if self.sock_inode is None:
            return
        try:
            current = os.stat(self.sock_path).st_ino
        except FileNotFoundError:
            return
        except OSError as exc:
            self.log("socket cleanup failed", error=str(exc))
            return
        if current != self.sock_inode:
            self.log("socket not ours, left in place", socket=str(self.sock_path))
            return
        try:
            self.sock_path.unlink()
        except OSError as exc:
            self.log("socket cleanup failed", error=str(exc))


def parse_args(argv: list[str]) -> argparse.Namespace:
    """La ligne de commande, lue AVANT de construire ou d'ouvrir quoi que ce soit.

    `-h`/`--help` imprime l'aide et sort 0 ; un drapeau ou un mot inconnu sort 2
    (argparse). Avant, `valxos-monitor --help` construisait le moniteur, liait son
    socket et attendait : la commande publiee executait le programme au lieu de
    l'expliquer (revue finale, 18/10). Les abreviations sont refusees, comme dans
    les commandes Node : un drapeau s'ecrit en entier.
    """
    parser = argparse.ArgumentParser(
        prog="valxos-monitor",
        allow_abbrev=False,
        description=(
            "Wake-up monitor of VALXOS Messenger. Started by the Claude Code plugin, it takes no "
            "argument: it binds this session's Unix socket, waits for a wake signal, prints one "
            "CC2CC_EVENT line per pending letter and marks it injected. It never harvests chairs."
        ),
    )
    parser.add_argument(
        "--reap-only",
        action="store_true",
        help="no longer harvests: refuses (exit 2) and names the commands that do",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    # Tout ce que ce processus cree est prive a son compte : la base et ses
    # compagnons WAL (sqlite3.connect cree sous l'umask), les .pid, les fiches de
    # statut, le journal et le socket. Sans cela, sous un umask 022, un bureau ne
    # par le moniteur etait lisible par tout compte de la machine (revue securite
    # F1, 18/10) alors que SECURITY.md promet « readable by the account that owns it ».
    os.umask(0o077)
    args = parse_args(list(sys.argv[1:] if argv is None else argv))

    # --reap-only ne moissonne plus (Run 6, Task 8, fix round 2). Le moniteur
    # est un processus automatique du plugin : la regle de Task 6 le lie, et
    # les deux seuls gestes qui marquent des chaises mortes sont
    # `valxos-doctor --reap` et `valxos-chaise moissonner`. Le drapeau reste
    # connu pour rediriger BRUYAMMENT une vieille habitude, jamais pour etre
    # une troisieme porte silencieuse.
    if args.reap_only:
        sys.stderr.write(
            "valxos-monitor no longer harvests: run  valxos-chaise moissonner  (or valxos-doctor --reap)\n"
        )
        return 2

    monitor = Monitor()
    signal.signal(signal.SIGTERM, monitor.shutdown)
    signal.signal(signal.SIGINT, monitor.shutdown)
    try:
        monitor.setup()
    except MonitorAlreadyRunning as exc:
        sys.stderr.write(f"{exc}\n")
        monitor.log("monitor refused to start", error=str(exc))
        return EXIT_ALREADY_RUNNING
    # Aucune moisson au demarrage : un processus automatique ne marque jamais
    # une chaise morte (Task 6 ; Task 8, fix round 2).
    try:
        monitor.serve()
    except Exception as exc:  # noqa: BLE001 - monitor must log and exit cleanly
        monitor.log("monitor crashed", error=str(exc))
        return 1
    finally:
        monitor.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
