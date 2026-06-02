import { isAbsolute, resolve } from "node:path";
import { canonicalFilePath } from "./path-canon.mjs";

// Detect the repo files a shell command would WRITE — the gap where `>`/`>>`,
// `tee`, `sed -i`, `cp`/`mv`, or `touch` mutate a file without going through the
// Write/Edit tool (which the PreToolUse guard already covers).
//
// Bias HARD toward false negatives. A missed write is just the pre-existing
// behaviour; a false positive could needlessly block a legit command. Two
// safeguards keep it honest: (1) a quote-aware tokenizer, so a `>` inside an echo
// string or a commit message is literal text, never a redirect; (2) only paths
// that resolve UNDER the repo root are returned — system files and out-of-tree
// paths aren't our concern. Best-effort by design (see DESIGN.md §9).

const MAX_TARGETS = 20; // backstop against a pathological command
const SEP = new Set([";", "|", "&", "&&", "||", "(", ")", "<", ">", ">>"]);
// reject sed/y in-place SCRIPTS like s/a/b/ or y/a/b/ — two delimiters after [sy]
const SED_SCRIPT = /^[sy]\W.*\W/;

// Quote-aware tokenizer: quoted spans collapse into the current word (so operators
// inside quotes stay literal), redirations and separators become their own tokens.
function tokenize(cmd) {
  const toks = [];
  let cur = "";
  let has = false;
  const push = () => {
    if (has) toks.push(cur);
    cur = "";
    has = false;
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "'" || c === '"') {
      const q = c;
      i++;
      while (i < cmd.length && cmd[i] !== q) cur += cmd[i++];
      has = true; // even an empty quoted string is a real (empty) word
      continue;
    }
    if (/\s/.test(c)) {
      push();
      continue;
    }
    if (c === ">") {
      push();
      if (cmd[i + 1] === ">") {
        toks.push(">>");
        i++;
      } else toks.push(">");
      continue;
    }
    if (c === "|" || c === ";" || c === "&" || c === "<" || c === "(" || c === ")") {
      push();
      toks.push(c);
      continue;
    }
    cur += c;
    has = true;
  }
  push();
  return toks;
}

export function detectWriteTargets(command, repoRoot) {
  const root = (repoRoot || process.cwd()).replace(/\\/g, "/").replace(/\/$/, "");
  const found = new Set();

  const add = (raw) => {
    if (found.size >= MAX_TARGETS) return;
    let t = String(raw ?? "");
    if (!t || t === "&" || t.startsWith("-")) return; // separators / flags
    if (/^\d+$/.test(t)) return; // bare file descriptor
    if (/^\/dev\//.test(t)) return; // /dev/null, /dev/stderr, …
    if (SED_SCRIPT.test(t)) return; // a sed s///, not a file
    const abs = isAbsolute(t) ? t.replace(/\\/g, "/") : resolve(root, t).replace(/\\/g, "/");
    if (abs !== root && !abs.startsWith(root + "/")) return; // outside the repo — not our concern
    const canon = canonicalFilePath(t, root);
    if (canon) found.add(canon);
  };

  const toks = tokenize(String(command || ""));
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t === ">" || t === ">>") {
      add(toks[k + 1]);
      continue;
    }
    if (t === "tee" || t === "touch") {
      for (let j = k + 1; j < toks.length && !SEP.has(toks[j]); j++) add(toks[j]);
      continue;
    }
    if (t === "cp" || t === "mv") {
      const args = [];
      for (let j = k + 1; j < toks.length && !SEP.has(toks[j]); j++) if (!toks[j].startsWith("-")) args.push(toks[j]);
      if (args.length >= 2) add(args[args.length - 1]); // destination
      continue;
    }
    if (t === "sed") {
      let inplace = false;
      const args = [];
      for (let j = k + 1; j < toks.length && !SEP.has(toks[j]); j++) {
        const a = toks[j];
        if (a.startsWith("-")) inplace ||= /i/.test(a);
        else args.push(a);
      }
      if (inplace) for (const a of args) add(a); // SED_SCRIPT filter drops the s/// arg
    }
  }
  return [...found];
}
