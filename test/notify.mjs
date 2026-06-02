// notify.mjs: the command is planned correctly, deduped within the throttle
// window, and suppressed when there's nothing to say. Force-on + dry-run so it
// never fires a real banner; AGENT_COORD_HOME (set by the runner) isolates the
// throttle file. Env is set before the dynamic import so config picks it up.
process.env.AGENT_COORD_NOTIFY = "1";
process.env.AGENT_COORD_NOTIFY_DRYRUN = "1";
const { notify } = await import("../lib/notify.mjs");

let ok = true;
const check = (cond, msg) => {
  if (!cond) ok = false;
  console.log(`  ${cond ? "✓" : "✗"} ${msg}`);
};

const a = notify({ title: "t", message: "hello", key: "k1" });
check(a && a.args.join(" ").includes("hello"), "fires for a new key, carries the message");

const b = notify({ title: "t", message: "again", key: "k1" });
check(b === null, "same key within the window is throttled");

const c = notify({ title: "t", message: "other", key: "k2" });
check(c && c.args.join(" ").includes("other"), "a different key still fires");

const d = notify({ key: "k3" });
check(d === null, "no message => no notification");

console.log(ok ? "PASS ✅" : "FAIL ❌");
process.exit(ok ? 0 : 1);
