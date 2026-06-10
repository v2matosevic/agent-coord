import { isAbsolute, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { canonicalFilePath } from "./path-canon.mjs";

// Detect the repo files a shell command would WRITE — the gap where `>`/`>>`,
// `tee`, `sed -i`, `cp`/`mv`, `touch`, or the PowerShell file cmdlets
// (Set-Content / Add-Content / Out-File) mutate a file without going through
// the Write/Edit tool (which the PreToolUse guard already covers).
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

export function detectWriteTargets(command, repoRoot, cwd = null) {
  // Relative targets resolve against the command's CWD (often a subdir of the
  // repo — `echo x > out.txt` run inside src/ writes src/out.txt), then filter
  // under the repo root. Resolve BOTH the root and the CWD through realpath so
  // they land in the SAME namespace — a symlinked cwd (macOS $TMPDIR /var →
  // /private/var) or an 8.3 short-name alias (Windows TEMP C:\Users\RUNNER~1)
  // on either side otherwise makes every relative target look "outside the
  // repo" and the claim is silently skipped.
  const norm = (p) => p.replace(/\\/g, "/").replace(/\/$/, "");
  const real = (p) => {
    try {
      return norm(realpathSync.native(p));
    } catch {
      return norm(p); // may not exist (or be unreadable) — fall back to the raw path
    }
  };
  const root = real(repoRoot || process.cwd());
  const base = real(cwd || root);
  // Windows paths are case-insensitive; compare in one case so D:\Repo vs d:\repo
  // (different tools report different casings) can't break the under-root check.
  const cmp = process.platform === "win32" ? (s) => s.toLowerCase() : (s) => s;
  const found = new Set();

  const add = (raw) => {
    if (found.size >= MAX_TARGETS) return;
    let t = String(raw ?? "");
    if (!t || t === "&" || t.startsWith("-")) return; // separators / flags
    if (/^\d+$/.test(t)) return; // bare file descriptor
    if (/^\/dev\//.test(t)) return; // /dev/null, /dev/stderr, …
    if (/^(\$null|nul)$/i.test(t)) return; // PowerShell/cmd null sinks — phantom "$null" file otherwise (Windows)
    if (/[$%`]/.test(t)) return; // unexpandable variable/substitution — can't resolve it safely, skip
    if (SED_SCRIPT.test(t)) return; // a sed s///, not a file
    const abs = isAbsolute(t) ? real(t) : resolve(base, t).replace(/\\/g, "/");
    if (cmp(abs) !== cmp(root) && !cmp(abs).startsWith(cmp(root) + "/")) return; // outside the repo — not our concern
    const canon = canonicalFilePath(abs, root);
    if (canon) found.add(canon);
  };

  // Strip heredoc BODIES (keep the opener line, so `cat <<EOF > f` still counts the
  // redirect) so a `>` inside heredoc data isn't mistaken for a redirect.
  const src = String(command || "").replace(/(<<-?\s*['"]?(\w+)['"]?[^\n]*\n)[\s\S]*?\n[ \t]*\2\b[^\n]*/g, "$1");
  const toks = tokenize(src);
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
    if (/^(set-content|add-content|out-file)$/i.test(t)) {
      // PowerShell file writers: the target is -Path/-FilePath/-LiteralPath's
      // argument, or the first positional. Unknown -Flags are assumed to take an
      // argument and both are skipped — biased to miss (an argless -Force costs
      // us the detection), never to claim a flag's VALUE as a file.
      for (let j = k + 1; j < toks.length && !SEP.has(toks[j]); j++) {
        const a = toks[j];
        if (/^-(literal)?(file)?path$/i.test(a)) {
          add(toks[j + 1]);
          break;
        }
        if (a.startsWith("-")) {
          j++;
          continue;
        }
        add(a);
        break;
      }
      continue;
    }
    if (t === "sed") {
      // Model sed's arg shape so the SCRIPT isn't claimed as a file: with -e/-f
      // the script is that flag's argument and every positional is a file; without
      // it the FIRST positional is the script (dropped), the rest are files.
      let inplace = false;
      let scriptViaFlag = false;
      const files = [];
      for (let j = k + 1; j < toks.length && !SEP.has(toks[j]); j++) {
        const a = toks[j];
        if (a === "-e" || a === "-f" || a === "--expression" || a === "--file") {
          scriptViaFlag = true;
          j++; // skip this flag's argument (the script / script file), not a target
          continue;
        }
        if (a.startsWith("-")) {
          if (/i/.test(a)) inplace = true;
          continue;
        }
        files.push(a);
      }
      if (inplace) for (const a of (scriptViaFlag ? files : files.slice(1))) add(a);
    }
  }
  return [...found];
}
