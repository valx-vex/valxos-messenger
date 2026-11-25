// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
//
// The Codex wiring of VALXOS Messenger — what `install --codex` puts in a
// Codex home: `[features] hooks = true` and the MCP server entry in
// config.toml, and the four lifecycle hooks in hooks.json, rendered from
// hooks.template.json next to this file.  This module DECIDES (renders,
// plans a merge, names a backup, draws a diff); it never reads or writes a
// file of the user's.  scripts/install.js reads, prints and writes — the
// split of scripts/launchd/plists.js.
//
// The merge only ever ADDS: a missing table, a missing key in one of our two
// tables.  A value already there that differs from ours is a CONFLICT, named,
// and the installer then writes nothing at all.  Every other table — other
// MCP servers, Codex's own [hooks.state] approvals, comments — stays byte for
// byte.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CODEX_EVENTS = ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"];
// The script every hook command runs; also how a hook of ours (this install's
// or an earlier one's) is recognised in a hooks.json.
export const HOOK_MARKER = "src/hooks/codex/codex-hook.js";
// The key of the 1.0.0 docs (docs/MCP_CLIENTS.md, "Codex CLI"): a user who
// followed them must not end up with two Messenger servers in Codex.
export const MCP_SERVER_KEY = "valxos_messenger";
export const FEATURES_BLOCK = "[features]\nhooks = true";
// The doors an install can pin (`--porte`): the desktop app, or the terminal.
// `exec` is a chair's door too (src/lib/chaise-codex.js), but nobody installs
// hooks for a one-shot `codex exec` alone.
export const INSTALL_DOORS = ["app", "cli"];
const PLACEHOLDERS = ["__PAQUET__", "__SELF__", "__BUREAU__", "__PORTE__", "__NODE__"];
// The door is OPTIONAL (round 1): unpinned, the command sets no
// VALXOS_CODEX_PORTE, and each session keeps the one its own environment
// gives (a terminal launcher sets cli; the desktop app has no launcher, and
// the hook reads an unset door as app).  `__PORTE__` then renders to nothing,
// its leading space included.
const OPTIONAL_PLACEHOLDERS = ["__PORTE__"];

export function hooksTemplatePath() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "hooks.template.json");
}

// Codex runs a hook's `command` through a shell: each value we put in it must
// stay ONE shell word.  A plain path or name stays bare (readable); anything
// else is single-quoted.
export function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

// A TOML basic string.  JSON's escapes are TOML's; TOML also refuses a raw
// DEL (U+007F), which JSON lets through.
export function tomlString(value) {
  return JSON.stringify(String(value)).replace(/\u007f/g, "\\u007F");
}

// The hooks.json object for one identity.  The identity and the office ride
// IN the command (`env VALXOS_SELF=… VALXOS_MESSENGER_HOME=… <node> …`), and
// so does an ABSOLUTE node: the Codex desktop app has no launcher to export
// them and not the shell's PATH, and the hook refuses to run without both its
// identity and `--serves`.  The door rides there only when pinned (`porte`,
// from --porte): `VALXOS_CODEX_PORTE=<door>` then wins over every session's.
export function renderHooks(templateText, { packageRoot, self, office, node, porte = null }) {
  const template = JSON.parse(templateText);
  const events = Object.keys(template?.hooks ?? {});
  if (events.join(",") !== CODEX_EVENTS.join(",")) {
    throw new Error(`hooks template: expected the events ${CODEX_EVENTS.join(", ")}, found ${events.join(", ") || "none"}`);
  }
  if (porte !== null && porte !== undefined && !INSTALL_DOORS.includes(porte)) {
    throw new Error(`hooks template: the door "${porte}" is not one an install pins (${INSTALL_DOORS.join(" or ")})`);
  }
  const raw = { __PAQUET__: packageRoot, __SELF__: self, __BUREAU__: office, __PORTE__: porte, __NODE__: node };
  const values = {};
  for (const marker of PLACEHOLDERS) {
    if (OPTIONAL_PLACEHOLDERS.includes(marker) && (raw[marker] === null || raw[marker] === undefined)) {
      values[marker] = "";
      continue;
    }
    if (typeof raw[marker] !== "string" || raw[marker] === "") throw new Error(`hooks template: no value for ${marker}`);
    values[marker] = marker === "__PORTE__" ? `VALXOS_CODEX_PORTE=${shellQuote(raw[marker])}` : shellQuote(raw[marker]);
  }
  const rendered = { hooks: {} };
  for (const event of CODEX_EVENTS) {
    rendered.hooks[event] = template.hooks[event].map((group) => ({
      ...group,
      hooks: group.hooks.map((hook) => ({
        ...hook,
        // One pass over the template, never over a value already put in: a
        // path that happens to contain `__NODE__` stays what it is.  A marker
        // that renders to nothing takes its leading space with it.
        command: String(hook.command).replace(/( ?)(__[A-Z]+__)/g, (_, space, marker) => {
          if (!PLACEHOLDERS.includes(marker)) throw new Error(`hooks template: unknown placeholder ${marker}`);
          return values[marker] === "" ? "" : `${space}${values[marker]}`;
        })
      }))
    }));
  }
  return rendered;
}

// What our two tables must hold.  `identity` keys decide who speaks and where
// the mail lives: a different value there is a conflict.  The others are
// written when missing and left alone when present (the 1.0.0 docs let users
// put their own node in `command`; the approval mode is theirs to keep).
// `aliases`: the historical names the product still reads for the same thing.
function mcpExpectations({ packageRoot, self, office, node }) {
  return {
    server: [
      { key: "command", value: node, identity: false },
      { key: "args", value: [path.join(packageRoot, "src", "mcp-server", "server.js")], identity: true },
      { key: "default_tools_approval_mode", value: "approve", identity: false }
    ],
    env: [
      { key: "VALXOS_SELF", value: self, identity: true, aliases: ["CC2CC_SELF"] },
      { key: "VALXOS_MESSENGER_HOME", value: office, identity: true, aliases: ["CC2CC_V2_HOME"] }
    ]
  };
}

function tomlValue(value) {
  return Array.isArray(value) ? `[${value.map(tomlString).join(", ")}]` : tomlString(value);
}

function keyLine({ key, value }) {
  return `${key} = ${tomlValue(value)}`;
}

const SERVER_PATH = ["mcp_servers", MCP_SERVER_KEY];
const ENV_PATH = [...SERVER_PATH, "env"];
const SERVER_TABLE = SERVER_PATH.join(".");
const ENV_TABLE = ENV_PATH.join(".");

// The MCP server entry, as the 1.0.0 docs write it, plus the office and an
// absolute node (the desktop app starts the server without the shell's
// PATH).  Never the live-office guard: that is a test-suite setting, not a
// user's.
export function mcpServerBlock(values) {
  const { server, env } = mcpExpectations(values);
  return [`[${SERVER_TABLE}]`, ...server.map(keyLine), "", `[${ENV_TABLE}]`, ...env.map(keyLine)].join("\n");
}

// ── config.toml ──────────────────────────────────────────────────────────

// Two keys are one key when their parts are (`a . "b"` is `a.b`; a quoted dot
// is a character of its part, never a separator).
const samePath = (parts, other) => parts.length === other.length && parts.every((part, n) => part === other[n]);
// `parts` names `prefix` itself or something inside it (`a.b` for `a`).
const within = (parts, prefix) => parts.length >= prefix.length && prefix.every((part, n) => parts[n] === part);

// The file as tables: `[{ name, parts, array, lines, keys }]`, the top of the
// file (before any header) first, with `name: null`.  Joining every `lines`
// with "\n" gives the file back byte for byte: the merge edits a table's
// lines, it never re-renders one.  `keys` are the table's own `key = value`
// statements: their `parts`, `raw` (the value's exact text) and `index` (the
// line they start on, in `lines`).
// The split IS the validator's reading (S2, S13): a header or a key is where
// the TOML 1.0 lexer below found one — never a second scanner that could
// disagree with it about where a string ends (a `\"""` inside `"""…"""`), or
// miss a header followed by a comment in a CRLF file.  A file the validator
// refuses is not split: it throws.
export function splitToml(text) {
  const source = String(text ?? "");
  let statements;
  try {
    ({ statements } = readToml(source));
  } catch (error) {
    throw new Error(`this config.toml cannot be merged: it is ${describeTomlError(source, error)}`);
  }
  const sections = [{ name: null, parts: null, array: false, lines: [], keys: [] }];
  let next = 0;
  let offset = 0;
  for (const line of source.split("\n")) {
    const end = offset + line.length;
    // One statement at most starts on a line: each one ends its line.
    while (next < statements.length && statements[next].start <= end) {
      const statement = statements[next];
      next += 1;
      if (statement.type === "header") {
        sections.push({ name: statement.parts.join("."), parts: statement.parts, array: statement.array, lines: [], keys: [] });
      } else {
        const section = sections[sections.length - 1];
        section.keys.push({
          index: section.lines.length,
          name: statement.parts.join("."),
          parts: statement.parts,
          raw: source.slice(statement.valueStart, statement.valueEnd)
        });
      }
    }
    sections[sections.length - 1].lines.push(line);
    offset = end + 1;
  }
  return sections;
}

// Why this config.toml cannot be completed, or null: the WHOLE file is
// validated as TOML 1.0 (A1) by the reading that also splits it (S2).  A file
// that ends inside a multi-line string or a multi-line array is refused there
// (the tables we append would land INSIDE it), and so is what this validator
// cannot read: the installer never merges into a file it has not understood.
export function tomlProblem(text) {
  return tomlSyntaxError(text);
}

// ── TOML 1.0 validation (A1) ─────────────────────────────────────────────
// A validator, not a parser: it reads the whole file against the TOML 1.0
// grammar (keys, the four strings, integers, floats, booleans, dates and
// times, arrays, inline tables, the two headers) and its rules on keys and
// tables (a key defined once, a table defined once, an inline table or a
// static array never extended), and decodes no value: a value is where it
// starts and ends in the text.  What it records — each header and each
// top-level `key = value`, with where it starts — is what splitToml cuts the
// file with (S2): one lexer for the validation and the split.  No dependency: the
// installer ships what it runs.  A TOML 1.1 form (a newline inside an inline
// table, a time without seconds, \e or \x escapes) is refused: a syntax this
// installer cannot validate is a refusal, never a guess.

// La phrase du refus d'une marque d'ordre ; `estUnBOM` la reconnaît pour le motif `bom` du rapport.
export const BOM_MOTIF = "the file starts with a UTF-8 byte-order mark (TOML 1.0 is UTF-8 without one): remove the UTF-8 byte-order mark";
export function commenceParUnBOM(text) {
  return String(text ?? "").charCodeAt(0) === 0xfeff;
}

class TomlSyntax extends Error {
  constructor(index, message) {
    super(message);
    this.index = index;
  }
}

// `line L, column C` of an index, both counted from 1, the column in code points.
function tomlPosition(text, index) {
  const before = text.slice(0, index);
  const lineStart = before.lastIndexOf("\n") + 1;
  return { line: before.split("\n").length, column: Array.from(text.slice(lineStart, index)).length + 1 };
}

// The character found, said without echoing more than itself.
function tomlFound(text, index) {
  if (index >= text.length) return "the end of the file";
  if (text[index] === "\n" || text[index] === "\r") return "the end of the line";
  const code = text.codePointAt(index);
  return code < 0x20 || code === 0x7f ? `the control character U+${code.toString(16).toUpperCase().padStart(4, "0")}` : JSON.stringify(String.fromCodePoint(code));
}

const TOML_BARE_KEY = /[A-Za-z0-9_-]/;
const TOML_DATE = /(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-](\d{2}):(\d{2}))?)?/y;
const TOML_TIME = /(\d{2}):(\d{2}):(\d{2})(\.\d+)?/y;
const TOML_WORD = /[0-9A-Za-z_.+-]+/y;
const TOML_INTEGER = /^(?:[+-]?(?:0|[1-9](?:_?\d)*)|0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*|0o[0-7](?:_?[0-7])*|0b[01](?:_?[01])*)$/;
const TOML_FLOAT = /^[+-]?(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?$/;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

function daysInMonth(year, month) {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

// The tree of keys, as the rules on tables need it.  A table is `explicit`
// once a [header] names it, `dotted` when dotted keys created it, `inline`
// when it was written as { … } (closed for good); `aot` is an array of
// tables; a `value` is everything else (a static array included), with the
// span of its text (`start`, `end`).
function tomlTable(flags = {}) {
  return { kind: "table", explicit: false, dotted: false, inline: false, children: new Map(), ...flags };
}

// `{ statements, root }`, or a TomlSyntax thrown at the first fault.
function readToml(src) {
  let i = 0;
  const fail = (at, message) => {
    throw new TomlSyntax(at, message);
  };
  // S13 (troisième passe adverse) : TOML 1.0 est de l'UTF-8 SANS marque d'ordre, et `tomllib` la
  // refuse. Elle était sautée en silence, puis le fichier sauvegardé et réécrit avec elle : c'est
  // un refus, en entrée comme à la relecture de la fusion.
  if (src.charCodeAt(0) === 0xfeff) fail(0, BOM_MOTIF);
  const isEol = () => src[i] === "\n" || (src[i] === "\r" && src[i + 1] === "\n");
  const skipWs = () => {
    while (src[i] === " " || src[i] === "\t") i += 1;
  };
  // A control character other than the tab never sits in a comment or a string.
  const checkChar = (at) => {
    const code = src.charCodeAt(at);
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) fail(at, `${tomlFound(src, at)} is not allowed here`);
  };
  const newline = () => {
    if (src[i] === "\n") i += 1;
    else if (src[i] === "\r" && src[i + 1] === "\n") i += 2;
    else return false;
    return true;
  };
  const comment = () => {
    i += 1;
    while (i < src.length && !isEol()) {
      if (src[i] === "\r") fail(i, "a carriage return without a line feed");
      checkChar(i);
      i += 1;
    }
  };
  // After an expression: blanks, perhaps a comment, then the end of the line.
  const endOfLine = (after) => {
    skipWs();
    if (src[i] === "#") comment();
    if (i >= src.length || newline()) return;
    fail(i, `expected the end of the line after ${after}, found ${tomlFound(src, i)}`);
  };
  // Inside an array: blanks, comments and newlines, in any number.
  const skipBlankLines = () => {
    for (;;) {
      skipWs();
      if (src[i] === "#") comment();
      if (newline()) continue;
      if (src[i] === "\r") fail(i, "a carriage return without a line feed");
      return;
    }
  };

  const escape = () => {
    const at = i;
    const e = src[i + 1];
    if (e !== undefined && 'btnfr"\\'.includes(e)) {
      i += 2;
      return;
    }
    if (e === "u" || e === "U") {
      const width = e === "u" ? 4 : 8;
      const hex = src.slice(i + 2, i + 2 + width);
      if (hex.length !== width || !/^[0-9A-Fa-f]+$/.test(hex)) fail(at, `the escape \\${e} needs ${width} hexadecimal digits`);
      const code = Number.parseInt(hex, 16);
      if ((code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff) fail(at, `the escape \\${e}${hex} is not a Unicode scalar value`);
      i += 2 + width;
      return;
    }
    fail(at, `an invalid escape in a string (\\${e === undefined ? "" : e})`);
  };
  const basicString = () => {
    const start = i;
    i += 1;
    for (;;) {
      if (i >= src.length || src[i] === "\n" || src[i] === "\r") fail(start, "a string that is never closed on its line");
      if (src[i] === '"') {
        i += 1;
        return;
      }
      if (src[i] === "\\") escape();
      else {
        checkChar(i);
        i += 1;
      }
    }
  };
  const literalString = () => {
    const start = i;
    i += 1;
    for (;;) {
      if (i >= src.length || src[i] === "\n" || src[i] === "\r") fail(start, "a literal string that is never closed on its line");
      if (src[i] === "'") {
        i += 1;
        return;
      }
      checkChar(i);
      i += 1;
    }
  };
  // """…""" and '''…''': a newline right after the opening is dropped; up to
  // two quotes may close the content just before the delimiter.
  const multiString = (quote) => {
    const start = i;
    const delimiter = quote.repeat(3);
    i += 3;
    for (;;) {
      if (i >= src.length) fail(start, `the file ends inside a multi-line string (${delimiter} never closed)`);
      if (src.startsWith(delimiter, i)) {
        let run = 3;
        while (src[i + run] === quote) run += 1;
        if (run > 5) fail(i, `too many ${quote} in a row in a multi-line string`);
        i += run;
        return;
      }
      if (newline()) continue;
      if (src[i] === "\r") fail(i, "a carriage return without a line feed");
      if (quote === '"' && src[i] === "\\") {
        // A line-ending backslash eats the newline and every blank after it.
        let j = i + 1;
        while (src[j] === " " || src[j] === "\t") j += 1;
        if (src[j] === "\n" || (src[j] === "\r" && src[j + 1] === "\n")) {
          i = j;
          while (src[i] === " " || src[i] === "\t" || newline()) if (src[i] === " " || src[i] === "\t") i += 1;
          continue;
        }
        escape();
        continue;
      }
      checkChar(i);
      i += 1;
    }
  };

  const simpleKey = () => {
    if (src[i] === '"') {
      if (src.startsWith('"""', i)) fail(i, "a multi-line string cannot be a key");
      const start = i;
      basicString();
      return src.slice(start, i);
    }
    if (src[i] === "'") {
      if (src.startsWith("'''", i)) fail(i, "a multi-line string cannot be a key");
      const start = i;
      literalString();
      return src.slice(start, i);
    }
    const start = i;
    while (i < src.length && TOML_BARE_KEY.test(src[i])) i += 1;
    if (i === start) fail(i, `expected a key, found ${tomlFound(src, i)}`);
    return src.slice(start, i);
  };
  // A key's parts, for the rules on keys: a quoted part is told apart from a
  // bare one by its quotes, and two spellings of one name are one key.
  const simple = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
  const keyName = (raw) => {
    if (raw.startsWith("'")) return raw.slice(1, -1);
    if (!raw.startsWith('"')) return raw;
    // Already validated by basicString: only the escapes it accepts are left.
    return raw.slice(1, -1).replace(/\\(?:u([0-9A-Fa-f]{4})|U([0-9A-Fa-f]{8})|(.))/g,
      (_, u4, u8, one) => (one !== undefined ? simple[one] : String.fromCodePoint(Number.parseInt(u4 ?? u8, 16))));
  };
  const key = () => {
    const parts = [keyName(simpleKey())];
    for (;;) {
      const save = i;
      skipWs();
      if (src[i] !== ".") {
        i = save;
        return parts;
      }
      i += 1;
      skipWs();
      parts.push(keyName(simpleKey()));
    }
  };
  const said = (parts) => parts.map((part) => (/^[A-Za-z0-9_-]+$/.test(part) ? part : JSON.stringify(part))).join(".");

  // `parts = value` in `table`: dotted keys create (or walk through) tables
  // they created themselves, never one a header defined, an inline table or a value.
  const assign = (table, parts, value, at) => {
    let node = table;
    for (let n = 0; n < parts.length - 1; n += 1) {
      let child = node.children.get(parts[n]);
      if (child === undefined) {
        child = tomlTable({ dotted: true });
        node.children.set(parts[n], child);
      } else if (child.kind !== "table" || child.inline || child.explicit) {
        fail(at, `the key ${said(parts.slice(0, n + 1))} is already defined: a dotted key cannot add to it`);
      }
      node = child;
    }
    const last = parts[parts.length - 1];
    if (node.children.has(last)) fail(at, `the key ${said(parts)} is defined twice`);
    node.children.set(last, value);
  };
  // The tables a header walks through on its way to the one it names.
  const walk = (parts, at) => {
    let node = root;
    for (let n = 0; n < parts.length - 1; n += 1) {
      let child = node.children.get(parts[n]);
      if (child === undefined) {
        child = tomlTable();
        node.children.set(parts[n], child);
      } else if (child.kind === "aot") {
        child = child.items[child.items.length - 1];
      } else if (child.kind !== "table" || child.inline) {
        fail(at, `the key ${said(parts.slice(0, n + 1))} is already a value: no table goes under it`);
      }
      node = child;
    }
    return node;
  };
  const openTable = (parts, at) => {
    const parent = walk(parts, at);
    const last = parts[parts.length - 1];
    const existing = parent.children.get(last);
    if (existing === undefined) {
      const table = tomlTable({ explicit: true });
      parent.children.set(last, table);
      return table;
    }
    if (existing.kind === "table" && !existing.explicit && !existing.dotted && !existing.inline) {
      existing.explicit = true;
      return existing;
    }
    return fail(at, `the table [${said(parts)}] is defined twice`);
  };
  const openArrayTable = (parts, at) => {
    const parent = walk(parts, at);
    const last = parts[parts.length - 1];
    const existing = parent.children.get(last);
    const table = tomlTable({ explicit: true });
    if (existing === undefined) parent.children.set(last, { kind: "aot", items: [table] });
    else if (existing.kind === "aot") existing.items.push(table);
    else fail(at, `[[${said(parts)}]] names a key already defined as something else than an array of tables`);
    return table;
  };

  const terminator = (at) => at >= src.length || " \t\n\r#,]}".includes(src[at]);
  const dateTime = () => {
    const at = i;
    TOML_DATE.lastIndex = i;
    const m = TOML_DATE.exec(src);
    if (m === null) fail(at, "an invalid date");
    const [, year, month, day, hour, minute, second, , , offHour, offMinute] = m;
    if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > daysInMonth(Number(year), Number(month))) {
      fail(at, `the date ${year}-${month}-${day} does not exist`);
    }
    if (hour !== undefined && (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 60)) fail(at, "an invalid time of day");
    if (offHour !== undefined && (Number(offHour) > 23 || Number(offMinute) > 59)) fail(at, "an invalid time offset");
    i = TOML_DATE.lastIndex;
  };
  const timeOfDay = () => {
    const at = i;
    TOML_TIME.lastIndex = i;
    const m = TOML_TIME.exec(src);
    if (m === null) fail(at, "an invalid time of day (TOML 1.0 needs the seconds)");
    if (Number(m[1]) > 23 || Number(m[2]) > 59 || Number(m[3]) > 60) fail(at, "an invalid time of day");
    i = TOML_TIME.lastIndex;
  };
  const word = () => {
    const at = i;
    TOML_WORD.lastIndex = i;
    const m = TOML_WORD.exec(src);
    if (m === null) fail(at, `expected a value, found ${tomlFound(src, at)}`);
    const text = m[0];
    i = TOML_WORD.lastIndex;
    if (text === "true" || text === "false" || /^[+-]?(?:inf|nan)$/.test(text)) return;
    if (TOML_INTEGER.test(text)) {
      const digits = text.replace(/_/g, "");
      const value = BigInt(/^[+-]?0[xob]/.test(digits) ? digits : digits.replace(/^\+/, ""));
      if (value < INT64_MIN || value > INT64_MAX) fail(at, `the integer ${text} does not fit in 64 bits`);
      return;
    }
    if (TOML_FLOAT.test(text) && /[.eE]/.test(text)) return;
    fail(at, `${JSON.stringify(text.slice(0, 40))} is not a TOML value`);
  };
  const array = () => {
    const start = i;
    i += 1;
    for (;;) {
      skipBlankLines();
      if (i >= src.length) fail(start, "the file ends inside an array (a [ never closed)");
      if (src[i] === "]") {
        i += 1;
        return;
      }
      value();
      skipBlankLines();
      if (src[i] === ",") {
        i += 1;
        continue;
      }
      if (src[i] === "]") {
        i += 1;
        return;
      }
      if (i >= src.length) fail(start, "the file ends inside an array (a [ never closed)");
      fail(i, `expected "," or "]" in an array, found ${tomlFound(src, i)}`);
    }
  };
  // TOML 1.0: one line, no trailing comma (a value inside may span lines).
  const inlineTable = () => {
    const start = i;
    const table = tomlTable();
    i += 1;
    skipWs();
    if (src[i] === "}") {
      i += 1;
      table.inline = true;
      return table;
    }
    for (;;) {
      skipWs();
      const at = i;
      const parts = key();
      skipWs();
      if (src[i] !== "=") fail(i, `expected "=" after the key ${said(parts)}, found ${tomlFound(src, i)}`);
      i += 1;
      skipWs();
      assign(table, parts, value(), at);
      skipWs();
      if (src[i] === ",") {
        i += 1;
        skipWs();
        if (src[i] === "}") fail(i, "a trailing comma in an inline table (TOML 1.0 has none)");
        continue;
      }
      if (src[i] === "}") {
        i += 1;
        table.inline = true;
        return table;
      }
      if (i >= src.length || src[i] === "\n" || src[i] === "\r") fail(start, "an inline table that is not closed on its line");
      fail(i, `expected "," or "}" in an inline table, found ${tomlFound(src, i)}`);
    }
  };
  const value = () => {
    const at = i;
    const c = src[i];
    if (c === '"') {
      if (src.startsWith('"""', i)) multiString('"');
      else basicString();
    } else if (c === "'") {
      if (src.startsWith("'''", i)) multiString("'");
      else literalString();
    } else if (c === "[") {
      array();
      return { kind: "value", start: at, end: i };
    } else if (c === "{") {
      return inlineTable();
    } else if (i >= src.length || c === "\n" || c === "\r" || c === "#") {
      fail(at, "a value is missing");
    } else if (/^\d{4}-/.test(src.slice(i, i + 5))) {
      dateTime();
    } else if (/^\d{2}:/.test(src.slice(i, i + 3))) {
      timeOfDay();
    } else {
      word();
    }
    if (!terminator(i)) fail(i, `unexpected ${tomlFound(src, i)} after a value`);
    return { kind: "value", start: at, end: i };
  };

  const root = tomlTable({ explicit: true });
  const statements = [];
  let current = root;
  while (i < src.length) {
    skipWs();
    if (i >= src.length) break;
    if (newline()) continue;
    const at = i;
    if (src[i] === "#" || src[i] === "\r") {
      endOfLine("a comment");
    } else if (src[i] === "[") {
      const arrayHeader = src[i + 1] === "[";
      i += arrayHeader ? 2 : 1;
      skipWs();
      const parts = key();
      skipWs();
      const close = arrayHeader ? "]]" : "]";
      if (!src.startsWith(close, i)) {
        const rest = src.slice(i, (src.indexOf("\n", i) + 1 || src.length + 1) - 1);
        fail(i, `${rest.includes(close) ? "" : "a [ never closed on its line: "}expected "${close}" to close the header, found ${tomlFound(src, i)}`);
      }
      i += close.length;
      current = arrayHeader ? openArrayTable(parts, at) : openTable(parts, at);
      statements.push({ type: "header", array: arrayHeader, parts, start: at });
      endOfLine("a table header");
    } else {
      const parts = key();
      skipWs();
      if (src[i] !== "=") fail(i, `expected "=" after the key ${said(parts)}, found ${tomlFound(src, i)}`);
      i += 1;
      skipWs();
      const valueStart = i;
      const node = value();
      statements.push({ type: "key", parts, start: at, valueStart, valueEnd: i });
      assign(current, parts, node, at);
      endOfLine("a value");
    }
  }
  return { statements, root };
}

// What a failed reading says: `not valid TOML at line L, column C: …`.  A file
// this validator cannot finish (a nesting too deep for its stack) is refused
// like an invalid one: never merged on a guess.
function describeTomlError(source, error) {
  if (error instanceof TomlSyntax) {
    const { line, column } = tomlPosition(source, error.index);
    return `not valid TOML at line ${line}, column ${column}: ${error.message}`;
  }
  return `TOML this installer cannot validate (${String(error?.message || error).slice(0, 120)})`;
}

// Why `text` is not TOML 1.0 this installer can validate, or null.
export function tomlSyntaxError(text) {
  const source = String(text ?? "");
  try {
    readToml(source);
    return null;
  } catch (error) {
    return `it is ${describeTomlError(source, error)}`;
  }
}

// The values this merge compares: booleans, strings, arrays of strings.
// Anything else reads as `undefined`: unreadable, so never "the same".
function parseTomlValue(raw) {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^'[^']*'$/.test(raw)) return raw.slice(1, -1);
  if (raw.startsWith('"') || raw.startsWith("[")) {
    try {
      return JSON.parse(raw.startsWith("[") ? raw.replace(/'([^']*)'/g, (_, s) => JSON.stringify(s)) : raw);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

// New lines go after the table's last non-blank line: the blank lines that
// separate it from the next table stay where they were.  They take the line
// ending of the line they follow (S13: a CRLF file stays CRLF).  In a CRLF file
// whose last line has no line ending, that line gets one and the last line
// added has none, like it had.
function insertAtEnd(section, lines, crlf) {
  let last = section.lines.length - 1;
  while (last > 0 && section.lines[last].trim() === "") last -= 1;
  const anchor = section.lines[last];
  let added = lines;
  if (anchor.endsWith("\r")) {
    added = lines.map((line) => `${line}\r`);
  } else if (crlf) {
    section.lines[last] = `${anchor}\r`;
    added = lines.map((line, n) => (n < lines.length - 1 ? `${line}\r` : line));
  }
  section.lines.splice(last + 1, 0, ...added);
}

// New tables go at the end of the file, after one blank line, in the file's
// line ending.  Nothing before them moves: the old file is a prefix of the new one.
function appendBlocks(text, blocks, crlf) {
  if (blocks.length === 0) return text;
  const eol = crlf ? "\r\n" : "\n";
  const addition = `${blocks.join("\n\n")}\n`.replace(/\n/g, eol);
  if (text === "") return addition;
  return text.endsWith("\n") ? `${text}${eol}${addition}` : `${text}${eol}${eol}${addition}`;
}

function mergeKeys(section, expected, table, result, crlf) {
  const present = new Map(section.keys.filter((key) => key.parts.length === 1).map((key) => [key.parts[0], key]));
  const missing = [];
  for (const want of expected) {
    const found = [want.key, ...(want.aliases ?? [])].map((name) => present.get(name)).find(Boolean);
    if (!found) {
      missing.push(keyLine(want));
      result.added.push(`${table}.${want.key}`);
      continue;
    }
    if (!want.identity) continue;
    const value = parseTomlValue(found.raw);
    if (value === undefined || JSON.stringify(value) !== JSON.stringify(want.value)) {
      result.conflicts.push(
        `config.toml [${table}] ${found.name} is ${found.raw}, this install writes ${tomlValue(want.value)}: change one of them by hand`
      );
    }
  }
  if (missing.length > 0) insertAtEnd(section, missing, crlf);
}

// The merge plan of config.toml.  `features` and `mcp` say what happens to
// each piece: "write" (the table is added), "update" (keys added to it, named
// in `added`), "unchanged", or "conflict" (named in `conflicts`; the installer
// then writes nothing).  `text` is the file after the merge — which the
// installer reads again (mergedConfigProblem) before writing it.  A file that
// is not valid TOML is not planned: it throws (tomlProblem refuses it first).
export function planCodexConfig(text, values) {
  const before = String(text ?? "");
  const sections = splitToml(before);
  // The file's line ending: CRLF when every line break is one.
  const crlf = before.includes("\r\n") && !/(?:^|[^\r])\n/.test(before);
  const table = (parts) => sections.find((s) => s.parts !== null && !s.array && samePath(s.parts, parts)) ?? null;
  const topKeys = sections[0].keys;
  const conflicts = [];
  const appends = [];

  // ① [features] hooks = true — Codex runs no hook without it.  A `features`
  // defined at the top (dotted key or inline table) cannot take a [features]
  // header any more: that one is merged by hand.
  let features;
  const featuresTable = table(["features"]);
  if (topKeys.some((k) => within(k.parts, ["features"]))) {
    features = { status: "conflict" };
    conflicts.push("config.toml sets features with a dotted key or an inline table at the top: add hooks = true to it by hand");
  } else if (featuresTable === null) {
    features = { status: "write" };
    appends.push(FEATURES_BLOCK);
  } else {
    const hooks = featuresTable.keys.find((k) => samePath(k.parts, ["hooks"]));
    if (!hooks) {
      insertAtEnd(featuresTable, ["hooks = true"], crlf);
      features = { status: "update", added: ["features.hooks"] };
    } else if (parseTomlValue(hooks.raw) === true) {
      features = { status: "unchanged" };
    } else {
      features = { status: "conflict" };
      conflicts.push(`config.toml [features] hooks = ${hooks.raw}: Codex runs no hook until it is true; change it by hand`);
    }
  }

  // ② [mcp_servers.valxos_messenger] and its env table.  Our server written
  // another way — an inline table, dotted keys, an inline `env` — is merged by
  // hand.  Another server, however it is written, does not concern us.
  const { server, env } = mcpExpectations(values);
  const serverTable = table(SERVER_PATH);
  const envTable = table(ENV_PATH);
  const serversTable = table(["mcp_servers"]);
  const inline = topKeys.some((k) => samePath(k.parts, ["mcp_servers"]) || within(k.parts, SERVER_PATH))
    || (serversTable !== null && serversTable.keys.some((k) => within(k.parts, [MCP_SERVER_KEY])))
    || (serverTable !== null && serverTable.keys.some((k) => within(k.parts, ["env"])));
  let mcp;
  if (inline) {
    mcp = { status: "conflict" };
    conflicts.push(`config.toml defines ${SERVER_TABLE} (or its env) with a dotted key or an inline table: merge the block above by hand`);
  } else if (serverTable === null && envTable === null) {
    mcp = { status: "write" };
    appends.push(mcpServerBlock(values));
  } else {
    const result = { added: [], conflicts: [] };
    if (serverTable !== null) {
      mergeKeys(serverTable, server, SERVER_TABLE, result, crlf);
    } else {
      appends.push([`[${SERVER_TABLE}]`, ...server.map(keyLine)].join("\n"));
      result.added.push(SERVER_TABLE);
    }
    if (envTable !== null) {
      mergeKeys(envTable, env, ENV_TABLE, result, crlf);
    } else {
      appends.push([`[${ENV_TABLE}]`, ...env.map(keyLine)].join("\n"));
      result.added.push(ENV_TABLE);
    }
    conflicts.push(...result.conflicts);
    mcp = result.conflicts.length > 0
      ? { status: "conflict" }
      : result.added.length > 0 ? { status: "update", added: result.added } : { status: "unchanged" };
  }

  return { text: appendBlocks(sections.flatMap((s) => s.lines).join("\n"), appends, crlf), features, mcp, conflicts };
}

// Why the merged config.toml must not be written, or null (S13).  The text the
// merge produced is read again, whole, by the validator that read the user's
// file: a merge that would write invalid TOML is a refusal (`fusion-invalide`),
// never a backup and a broken file.  Then what this install is for is looked
// up in it as TOML reads it — not where the merge put its lines: features.hooks
// is true, and our server's two tables hold every key this install writes, the
// identity keys with this install's values.
export function mergedConfigProblem(text, values) {
  const source = String(text ?? "");
  let root;
  try {
    ({ root } = readToml(source));
  } catch (error) {
    return `the merged file would be ${describeTomlError(source, error)}`;
  }
  const node = (parts) => {
    let current = root;
    for (const part of parts) {
      if (current?.kind !== "table") return undefined;
      current = current.children.get(part);
    }
    return current;
  };
  const raw = (found) => (found?.kind === "value" ? source.slice(found.start, found.end) : "");
  if (raw(node(["features", "hooks"])) !== "true") return "after the merge, features.hooks is not true: Codex would run no hook";
  const { server, env } = mcpExpectations(values);
  for (const [parts, wants] of [[SERVER_PATH, server], [ENV_PATH, env]]) {
    const name = parts.join(".");
    const found = node(parts);
    if (found?.kind !== "table") return `after the merge, there is no [${name}] table`;
    for (const want of wants) {
      const key = [want.key, ...(want.aliases ?? [])].map((k) => found.children.get(k)).find((n) => n !== undefined);
      if (key === undefined) return `after the merge, ${name}.${want.key} is missing`;
      if (want.identity && JSON.stringify(parseTomlValue(raw(key))) !== JSON.stringify(want.value)) {
        return `after the merge, ${name}.${want.key} is not ${tomlValue(want.value)}`;
      }
    }
  }
  return null;
}

// ── hooks.json ───────────────────────────────────────────────────────────

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isOurGroup(group) {
  return isPlainObject(group) && Array.isArray(group.hooks)
    && group.hooks.some((hook) => String(hook?.command ?? "").includes(HOOK_MARKER));
}

// The merge plan of hooks.json (`existingText` null: no file yet).  Per event:
// "appended" (our group goes AFTER the groups already there, so their indexes
// — and Codex's approvals, keyed by them — do not move), "unchanged" (our
// exact group is there), or "conflict" (a group of ours that differs: another
// identity, office, door, node or package path — never rewritten).  A file
// with nothing to append keeps its exact text.
export function planCodexHooks(existingText, ours) {
  if (existingText === null || existingText === undefined) {
    return {
      text: `${JSON.stringify(ours, null, 2)}\n`,
      status: "write",
      events: Object.fromEntries(CODEX_EVENTS.map((event) => [event, "appended"])),
      conflicts: []
    };
  }
  let existing;
  try {
    existing = JSON.parse(existingText);
  } catch {
    existing = undefined;
  }
  if (!isPlainObject(existing) || (existing.hooks !== undefined && !isPlainObject(existing.hooks))) {
    return {
      text: existingText,
      status: "conflict",
      events: {},
      conflicts: ['hooks.json is not a JSON object with a "hooks" table: merge the hooks above by hand']
    };
  }
  const merged = { ...existing, hooks: { ...(existing.hooks ?? {}) } };
  const events = {};
  const conflicts = [];
  for (const event of CODEX_EVENTS) {
    const group = ours.hooks[event][0];
    const current = merged.hooks[event];
    if (current === undefined) {
      merged.hooks[event] = [group];
      events[event] = "appended";
    } else if (!Array.isArray(current)) {
      events[event] = "conflict";
      conflicts.push(`hooks.json: ${event} is not a list: merge it by hand`);
    } else {
      const mine = current.filter(isOurGroup);
      if (mine.length === 0) {
        merged.hooks[event] = [...current, group];
        events[event] = "appended";
      } else if (mine.length === 1 && JSON.stringify(mine[0]) === JSON.stringify(group)) {
        events[event] = "unchanged";
      } else {
        events[event] = "conflict";
        conflicts.push(
          `hooks.json: ${event} already runs a VALXOS Messenger hook that differs from this one (another identity, office, door, node or package path): merge it by hand`
        );
      }
    }
  }
  const changed = Object.values(events).includes("appended");
  return {
    text: changed ? `${JSON.stringify(merged, null, 2)}\n` : existingText,
    status: conflicts.length > 0 ? "conflict" : changed ? "update" : "unchanged",
    events,
    conflicts
  };
}

// ── backups and diff ─────────────────────────────────────────────────────

// `AAAAMMJJ-HHMM`, local time: the backup a person looks for is named after
// the minute on their own clock.
export function timestampShort(date = new Date()) {
  const two = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}`;
}

// `<file>.bak-AAAAMMJJ-HHMM`, then `-2`, `-3`… when that minute already has
// one: a backup is never overwritten.
export function backupName(file, { exists = fs.existsSync, date = new Date() } = {}) {
  const base = `${file}.bak-${timestampShort(date)}`;
  if (!exists(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!exists(candidate)) return candidate;
  }
}

// A line diff (longest common subsequence) for the operator to read: the
// lines removed (-) and added (+), each run under `@@ line N @@`, N counted
// in the new file.  The trailing newline is not a line.
export function lineDiff(before, after, label) {
  const lines = (text) => (text === "" ? [] : text.replace(/\n$/, "").split("\n"));
  const a = lines(before);
  const b = lines(after);
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out = [`--- ${label}`, `+++ ${label}`];
  let i = 0;
  let j = 0;
  let open = false;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i += 1;
      j += 1;
      open = false;
      continue;
    }
    if (!open) {
      out.push(`@@ line ${j + 1} @@`);
      open = true;
    }
    if (j < b.length && (i >= a.length || lcs[i][j + 1] >= lcs[i + 1][j])) {
      out.push(`+${b[j]}`);
      j += 1;
    } else {
      out.push(`-${a[i]}`);
      i += 1;
    }
  }
  return `${out.join("\n")}\n`;
}
