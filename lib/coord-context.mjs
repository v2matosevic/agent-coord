import { readMessages, annotateSenders } from "./messages.mjs";
import { freedFileWaits } from "./leases.mjs";
import { earlierOverlappingPeers, shouldNotifyOverlap, overlapAdvisoryCount, clearOverlapNotice } from "./overlap.mjs";
import { notify } from "./notify.mjs";
import { MSG_DELIVER_MAX } from "./config.mjs";

// Mid-turn coordination context — the fix for the deaf heads-down agent. The
// old delivery point was UserPromptSubmit only, so an agent building a whole
// feature in ONE long turn never saw a peer's messages until it finished (the
// coral-mole failure). Hooks that fire BETWEEN tool calls (PostToolUse, Bash
// allow) call this to surface, as `additionalContext`, both unread peer messages
// (read-once) and a throttled duplicate-work advisory. Returns null when there's
// nothing new to say, so the common case adds no noise.

export function midTurnContext(db, { agentId, workspaceId: ws }) {
  const lines = [];

  // 1) Files I was blocked on that have since freed (holder released / went
  //    cold / died) — closes the loop on an exit-2: no blind retry needed.
  for (const p of freedFileWaits(db, { agentId, workspaceId: ws })) {
    lines.push(`✅ "${p}" is free now (the peer who held it moved on) — you can edit it.`);
  }

  // 2) Unread peer messages — directed-to-me or workspace/global broadcasts. Tag
  //    senders that have since exited so a backlog author isn't read as a live peer
  //    (BUG 2): a hand-off can't go to an agent that's already gone. Capped per
  //    event (a resumed session can face a day's backlog); the read pointer only
  //    advanced past what we deliver, so the rest arrives on the next event.
  const { messages: raw, remaining, remainingDirected } = readMessages(db, { agentId, workspaceId: ws, limit: MSG_DELIVER_MAX });
  const msgs = annotateSenders(db, raw);
  for (const m of msgs) lines.push(`• ${m.from_agent}${m.from_live ? "" : " (exited — not live)"}${m.to_agent ? " → you" : ""}: ${m.body}`);
  if (remaining > 0) {
    lines.push(`…and ${remaining} more unread — arriving over your next tool calls (or read_messages to pull them now).`);
    // Delivery is FIFO, so a message addressed to THIS agent (a yield request,
    // an ask, a hand-off) can be stuck behind a broadcast backlog. Don't let it
    // wait its turn silently — flag it now and pull the human alarm the moment
    // it exists, not N tool calls later.
    if (remainingDirected > 0) {
      lines.push(
        `⚠ ${remainingDirected} of them ${remainingDirected > 1 ? "are" : "is"} addressed directly to YOU — call read_messages now; it may be a yield request or a question a peer is waiting on.`,
      );
      notify({
        title: "📬 direct message waiting",
        message: "A message addressed to you is queued behind the backlog — it arrives next event or via read_messages.",
        key: `msg:${ws}`,
        sound: true,
      });
    }
  }
  // Ping the human only for DIRECTED messages — a broadcast is delivered once per
  // receiving agent, so bannering all of them turns one post into N alerts.
  const directed = msgs.filter((m) => m.to_agent);
  if (directed.length) {
    const last = directed[directed.length - 1];
    notify({
      title: directed.length > 1 ? `📬 ${directed.length} new messages` : `📬 ${last.from_agent}`,
      message: directed.length > 1 ? `${last.from_agent}: ${last.body}` : last.body,
      key: `msg:${ws}`,
      sound: true,
    });
  }

  // 3) Duplicate-work advisory — only to the later-starter, throttled. The
  //    escape hatch (announce a narrower lane) is spelled out so a legit
  //    divide-the-work pair clears itself instead of fighting.
  const task = db.prepare("SELECT COALESCE(intent, current_task) AS task FROM agents WHERE agent_id=?").get(agentId)?.task;
  const yieldTo = task ? earlierOverlappingPeers(db, { agentId, workspaceId: ws, task }) : [];
  if (yieldTo.length) {
    if (shouldNotifyOverlap(agentId)) {
      const p = yieldTo[0];
      const n = overlapAdvisoryCount(agentId);
      lines.push(
        `⚠ duplicate-work (${n}): your task overlaps ${p.agentId}, who started before you — "${String(p.task).slice(0, 80)}". ` +
          "You're the later starter. Narrow your lane with announce_intent (this clears the flag) or stand down and post_message to hand off. " +
          "If you keep editing this area your next edits will be blocked.",
      );
    }
  } else if (overlapAdvisoryCount(agentId) > 0) {
    clearOverlapNotice(agentId); // overlap resolved (differentiated or peer gone) — reset escalation
  }

  if (!lines.length) return null;
  return "📬 agent-coord — peers in this repo:\n" + lines.join("\n");
}

// PostToolUse JSON: inject context after a tool ran, without blocking and
// WITHOUT touching the permission decision. Delivery rides PostToolUse (not a
// PreToolUse forced-"allow") precisely so it can never bypass a Bash/edit
// permission prompt — it only ever adds context to a tool that already ran.
// `eventName` must echo the firing event (PostToolUseFailure rides this too).
export function postToolContextJson(ctx, eventName = "PostToolUse") {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext: ctx } });
}
