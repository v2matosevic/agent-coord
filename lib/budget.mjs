// Context-byte budgeting for anything this system writes INTO a model's context.
//
// Claude Code persists any hook's stdout over 8192 bytes to a temp file and shows
// the model only the first 2000 characters (`length>8192`, `Y5=2000`, verified in
// the 2.1.245 bundle on 2026-08-26). The hook is not told. Nothing exits non-zero.
// So an over-budget hook does not look broken — it looks like it worked, while
// most of what it said reached nobody. Coordination that is silently discarded is
// worse than no coordination, because everyone believes the message landed.
//
// The rule that follows: assemble against a budget, measure the EXACT bytes the
// hook will write (postToolContextJson escapes every newline, so the wire size
// exceeds string.length), and always SAY what was cut. See lib/coord-context.mjs.

export const bytes = (s) => Buffer.byteLength(s, "utf8");

// Cut to `max` characters on a word boundary, marking the cut so a reader can
// tell a truncated body from a terse one. Whitespace is flattened first: a
// multi-line body inside a bullet list is unreadable anyway, and a predictable
// single line is what makes the byte arithmetic below hold.
export function headline(text, max) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!Number.isFinite(max) || flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + " …⟨cut⟩";
}

// Drop whole lines off the END until the wrapped payload fits, and say how many
// went. `keep` lines at the front are structural (a header) and never dropped.
export function clampLines(lines, { budget, wrap = (s) => s, keep = 0, note = (n) => `  ⋯ ${n} line(s) trimmed to fit the hook context limit` }) {
  let out = [...lines];
  let dropped = 0;
  while (out.length > keep && bytes(wrap([...out, ...(dropped ? [note(dropped)] : [])].join("\n"))) > budget) {
    out.pop();
    dropped++;
  }
  return dropped ? [...out, note(dropped)] : out;
}
