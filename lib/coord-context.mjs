import { peekUnread, ackMessages, annotateSenders } from "./messages.mjs";
import { freedFileWaits } from "./leases.mjs";
import { earlierOverlappingPeers, shouldNotifyOverlap, overlapAdvisoryCount, clearOverlapNotice } from "./overlap.mjs";
import { notify } from "./notify.mjs";
import { bytes, headline, clampLines } from "./budget.mjs";
import { MSG_DELIVER_MAX, MSG_BODY_WIDTHS, MSG_DIRECTED_LOOKAHEAD, HOOK_CONTEXT_BUDGET } from "./config.mjs";

// Mid-turn coordination context — the fix for the deaf heads-down agent. The
// old delivery point was UserPromptSubmit only, so an agent building a whole
// feature in ONE long turn never saw a peer's messages until it finished (the
// coral-mole failure). Hooks that fire BETWEEN tool calls (PostToolUse, Bash
// allow) call this to surface, as `additionalContext`, both unread peer messages
// (read-once) and a throttled duplicate-work advisory. Returns null when there's
// nothing new to say, so the common case adds no noise.
//
// EVERYTHING here is assembled against a BYTE budget (issue i-77824feb). Claude
// Code files away hook output over 8192 bytes and shows the model a 2000-char
// preview, silently — and because delivery advances the read pointer, every
// message past that preview used to be marked read and lost for good. Fifteen
// ordinary messages are 12–30 KB, so the old count cap bounded nothing. Callers
// pass `wrap` = the exact transform their hook applies before writing (JSON
// wrapping escapes every newline, so the wire size exceeds string.length); the
// budget is measured against that, not against the raw string.

const HEAD = "📬 agent-coord — peers in this repo:";
const NARROWEST = MSG_BODY_WIDTHS[MSG_BODY_WIDTHS.length - 1];
// Directed before broadcast, then newest first: when the budget forces a choice,
// the thing a peer is blocked on wins over the thing that merely happened.
const byPriority = (a, b) => Number(!!b.to_agent) - Number(!!a.to_agent) || b.seq - a.seq;

// `flat` is the whitespace-collapsed body, computed ONCE per candidate: the fit
// loop below re-renders the whole set at up to five widths, and re-flattening a
// 28 KB body five times is work this hook does on every tool call that has mail.
const msgLine = (m, width) =>
  `• ${m.from_agent}${m.from_live ? "" : " (exited — not live)"}${m.to_agent ? " → you" : ""}: ${headline(m.flat, width)}`;

// Never let a cut be silent — the whole failure this replaces was a silent one.
// The two cuts are NOT the same and must not be described as one: a withheld
// message is still unread and read_messages really does pull it whole, while a
// shortened one has been consumed and only `search` will find it again. Saying
// "read_messages for the full text" of a shortened body would be a fresh lie in
// the place a lie just cost us a day of peer messages.
function cutNotice(shortened, notShown) {
  if (!shortened && !notShown) return null;
  const said = [shortened && `${shortened} message${shortened > 1 ? "s" : ""} shortened`, notShown && `${notShown} not shown`].filter(Boolean).join(", ");
  const how = [
    notShown && `read_messages pulls the ${notShown} not shown in full (they also arrive over your next tool calls)`,
    shortened && `bodies trimmed at ⟨cut⟩, and search finds one again if you need more of it`,
  ]
    .filter(Boolean)
    .join("; ");
  return `…${said} — ${how}.`;
}

export function midTurnContext(db, { agentId, workspaceId: ws, budget = HOOK_CONTEXT_BUDGET, wrap = (s) => s }) {
  // Structural lines that bracket the message list. `before` is cheap and
  // actionable; `after` is advisory. Both are measured with the messages.
  const before = [];
  const after = [];

  // 1) Files I was blocked on that have since freed (holder released / went
  //    cold / died) — closes the loop on an exit-2: no blind retry needed.
  for (const p of freedFileWaits(db, { agentId, workspaceId: ws })) {
    before.push(`✅ "${p}" was free when checked. Reclaim it and re-read the current contents before editing; this notice does not reserve it.`);
  }

  // 3) Duplicate-work advisory — only to the later-starter, throttled. The
  //    escape hatch (announce a narrower lane) is spelled out so a legit
  //    divide-the-work pair clears itself instead of fighting. Computed before
  //    delivery so its cost is inside the budget, not bolted on after it.
  const task = db.prepare("SELECT COALESCE(intent, current_task) AS task FROM agents WHERE agent_id=?").get(agentId)?.task;
  const yieldTo = task ? earlierOverlappingPeers(db, { agentId, workspaceId: ws, task }) : [];
  if (yieldTo.length) {
    if (shouldNotifyOverlap(agentId)) {
      const p = yieldTo[0];
      const n = overlapAdvisoryCount(agentId);
      after.push(
        `⚠ duplicate-work (${n}): your task overlaps ${p.agentId}, who started before you — "${String(p.task).slice(0, 80)}". ` +
          "You're the later starter. Narrow your lane with announce_intent (this clears the flag) or stand down and post_message to hand off. " +
          "If you keep editing this area your next edits will be blocked.",
      );
    }
  } else if (overlapAdvisoryCount(agentId) > 0) {
    clearOverlapNotice(agentId); // overlap resolved (differentiated or peer gone) — reset escalation
  }

  // 2) Unread peer messages — directed-to-me or workspace/global broadcasts.
  //    PEEK, don't consume: what fits is only known after rendering, and the read
  //    pointer must not step over a body no agent ever saw. Tag senders that have
  //    since exited so a backlog author isn't read as a live peer (BUG 2): a
  //    hand-off can't go to an agent that's already gone.
  const peek = peekUnread(db, { agentId, workspaceId: ws, limit: MSG_DELIVER_MAX, directedLookahead: MSG_DIRECTED_LOOKAHEAD });
  const candidates = annotateSenders(db, [...peek.rows, ...peek.stranded]).map((m) => ({ ...m, flat: headline(m.body, Infinity) })); // seq ASC
  const ranked = [...candidates].sort(byPriority);

  // Two dials, in order: shorten every body to a common width (a sender line
  // plus a first line is what lets an agent decide to call read_messages, so
  // keeping all the senders beats keeping a few whole bodies), and only if the
  // narrowest width still overflows, withhold the lowest-priority messages.
  const frame = (lines) => [HEAD, ...before, ...lines, ...after].join("\n");
  const render = (set, width) => {
    const keptSeqs = new Set(set.map((m) => m.seq));
    const chrono = candidates.filter((m) => keptSeqs.has(m.seq));
    const lines = chrono.map((m) => msgLine(m, width));
    const shortened = chrono.filter((m) => m.flat.length > width).length;
    const notShown = peek.total - chrono.length;
    const note = cutNotice(shortened, notShown);
    const text = frame(note ? [...lines, note] : lines);
    return { text, kept: chrono, shortened, notShown, fits: bytes(wrap(text)) <= budget };
  };

  let picked = null;
  for (const width of MSG_BODY_WIDTHS) {
    const r = render(ranked, width);
    if (r.fits) {
      picked = r;
      break;
    }
  }
  for (let n = ranked.length - 1; !picked && n >= 0; n--) {
    const r = render(ranked.slice(0, n), NARROWEST);
    if (r.fits) picked = r;
  }

  // Pathological: the structural lines alone blow the budget (a huge freed-file
  // list). Deliver no messages — nothing is consumed, so nothing is lost — and
  // clamp the frame itself rather than hand Claude Code a payload it will file
  // away whole.
  if (!picked) {
    const lines = clampLines([HEAD, ...before, ...after], { budget, wrap, keep: 1 });
    return lines.length > 1 ? lines.join("\n") : null;
  }
  // Nothing to say at all — the common case, and it must stay silent. Note the
  // `peek.total` term: if mail exists but none of it fit, `picked.text` is the
  // cut notice alone, and swallowing THAT would be the original silent failure
  // in miniature.
  if (!before.length && !after.length && !picked.kept.length && !peek.total) return null;

  // Consume ONLY the delivered prefix. The read pointer is a single seq
  // watermark, so it can advance no further than the last message before the
  // first one we withheld — anything past that would mark an undelivered body
  // read. A high-seq directed message pulled forward is therefore delivered but
  // NOT acked: it may repeat on the next event until the backlog behind it
  // drains. Repeating a yield request is cheap; losing one is not.
  const delivered = new Set(picked.kept.map((m) => m.seq));
  const blocked = candidates.filter((m) => !delivered.has(m.seq)).map((m) => m.seq);
  const firstBlocked = blocked.length ? Math.min(...blocked) : Infinity;
  let ack = 0;
  for (const m of candidates) if (m.seq < firstBlocked && delivered.has(m.seq)) ack = m.seq;
  if (peek.unfetched > 0) ack = Math.min(ack, peek.windowEnd); // never step over rows we never looked at
  if (ack) ackMessages(db, { agentId, seq: ack });

  // Delivery is FIFO by seq, so a message addressed to THIS agent can be stuck
  // behind a broadcast backlog. The lookahead pulls most of those forward; if one
  // still didn't fit, flag it and pull the human alarm now, not N tool calls later.
  const notShownDirected = peek.totalDirected - picked.kept.filter((m) => m.to_agent).length;
  if (notShownDirected > 0) {
    notify({
      title: "📬 direct message waiting",
      message: "A message addressed to you didn't fit this batch — it arrives next event or via read_messages.",
      key: `msg:${ws}`,
      sound: true,
    });
  }
  // Ping the human only for DIRECTED messages — a broadcast is delivered once per
  // receiving agent, so bannering all of them turns one post into N alerts.
  const directed = picked.kept.filter((m) => m.to_agent);
  if (directed.length) {
    const last = directed[directed.length - 1];
    notify({
      title: directed.length > 1 ? `📬 ${directed.length} new messages` : `📬 ${last.from_agent}`,
      message: headline(directed.length > 1 ? `${last.from_agent}: ${last.body}` : last.body, 200),
      key: `msg:${ws}`,
      sound: true,
    });
  }

  return picked.text;
}

// PostToolUse JSON: inject context after a tool ran, without blocking and
// WITHOUT touching the permission decision. Delivery rides PostToolUse (not a
// PreToolUse forced-"allow") precisely so it can never bypass a Bash/edit
// permission prompt — it only ever adds context to a tool that already ran.
// `eventName` must echo the firing event (PostToolUseFailure rides this too).
export function postToolContextJson(ctx, eventName = "PostToolUse") {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext: ctx } });
}

// The whole PostToolUse payload, budgeted against ITS OWN wire size. Hooks call
// this instead of pairing midTurnContext + postToolContextJson by hand: the JSON
// wrapper escapes every newline, so measuring the bare string would under-count
// exactly the payloads closest to the cliff. Returns null when there's nothing
// to say.
export function postToolContext(db, { agentId, workspaceId, eventName = "PostToolUse", budget = HOOK_CONTEXT_BUDGET }) {
  const wrap = (s) => postToolContextJson(s, eventName);
  const ctx = midTurnContext(db, { agentId, workspaceId, budget, wrap });
  return ctx === null ? null : wrap(ctx);
}
