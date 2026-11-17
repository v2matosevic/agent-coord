// Marko's hard rule: no AI attribution in git history (no `Co-Authored-By:
// Claude`, no "Generated with Claude Code"). Coding-agent harnesses inject a
// reminder to add exactly that, and agents followed it five times between
// 2026-09-10 and 2026-11-17 despite the rule in CLAUDE.md and memory, once into
// a pushed commit. A rule in prose did not hold, so the global commit-msg hook
// now removes those lines from every message before the commit is written.
//
// Only AI attribution is removed. A human co-author trailer stays.

const AI_LINE = [
  /^co-authored-by:.*(claude|anthropic|openai|codex|chatgpt|copilot|gemini|noreply@anthropic\.com)/i,
  /generated with \[?claude code\]?/i,
  /^🤖\s*generated with/i,
];

export function stripAiAttribution(text) {
  const lines = String(text).split(/\r?\n/);
  const kept = [];
  let removed = 0;
  for (const line of lines) {
    if (!line.startsWith("#") && AI_LINE.some((re) => re.test(line.trim()))) {
      removed++;
      continue;
    }
    kept.push(line);
  }
  if (!removed) return { text: String(text), removed: 0 };
  // Collapse the blank run the removal can leave before the trailer block/end.
  let out = kept.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "\n");
  return { text: out, removed };
}
