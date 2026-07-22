// The MCP arg-normalization boundary (mcp/args.mjs): model-supplied values
// must never reach a SQL bind in a form node:sqlite rejects (undefined /
// boolean / object / array), and a missing required field must fail with an
// error that names the field and the keys actually received — the
// field-reported "Provided value cannot be bound to SQLite parameter 5" class
// (post_message ×5, log_activity, claim_resource).
import { normalizeArgs } from "../mcp/args.mjs";
import { TOOL_DEFS } from "../mcp/tool-defs.mjs";

const def = (n) => TOOL_DEFS.find((d) => d.name === n);
let fails = 0;
const check = (label, cond) => {
  console.log((cond ? "ok " : "FAIL") + "  " + label);
  if (!cond) fails++;
};
const throwsWith = (fn, ...needles) => {
  try {
    fn();
    return false;
  } catch (e) {
    return needles.every((n) => e.message.includes(n));
  }
};

// The exact field failure: body misnamed -> friendly error naming both sides.
check(
  "post_message without body names the field AND the stray key",
  throwsWith(() => normalizeArgs(def("post_message"), { message: "hi there" }), '"body"', "message"),
);
check(
  "post_message with no args says so",
  throwsWith(() => normalizeArgs(def("post_message"), {}), '"body"', "no arguments"),
);
check(
  "empty-string required field counts as missing",
  throwsWith(() => normalizeArgs(def("post_message"), { body: "" }), '"body"'),
);
check(
  "claim_resource without resource_id fails friendly",
  throwsWith(() => normalizeArgs(def("claim_resource"), { reason: "dev server" }), '"resource_id"'),
);
check(
  "log_activity without event fails friendly",
  throwsWith(() => normalizeArgs(def("log_activity"), { detail: "x" }), '"event"'),
);

// Coercions: everything that comes out must be SQL-bindable.
const a1 = normalizeArgs(def("post_message"), { body: ["line1", "line2"], to: 7, scope: "workspace" });
check("array-of-strings body joins to one string", a1.body === "line1\nline2");
check("number 'to' coerces to string", a1.to === "7");

const a2 = normalizeArgs(def("post_message"), { body: { text: "hi" } });
check("object body serializes to JSON string", a2.body === '{"text":"hi"}');

const a3 = normalizeArgs(def("log_activity"), { event: "deploy", detail: true });
check("boolean detail coerces to string", a3.detail === "true");

const a4 = normalizeArgs(def("claim_files"), { paths: "src/x.ts" });
check("bare string paths wraps to array", Array.isArray(a4.paths) && a4.paths[0] === "src/x.ts");

const a5 = normalizeArgs(def("query_history"), { path: "src", days: "7" });
check("numeric string days coerces to number", a5.days === 7);

const a6 = normalizeArgs(def("query_history"), { path: "src", days: "soon" });
check("unparseable optional number is dropped", !("days" in a6));

const a7 = normalizeArgs(def("update_task"), { task_id: "t-1", summary: null });
check("explicit null optional is dropped, not bound", !("summary" in a7) && a7.task_id === "t-1");

const a8 = normalizeArgs(def("read_messages"), undefined);
check("non-object raw args normalize to {}", typeof a8 === "object" && Object.keys(a8).length === 0);

console.log(fails === 0 ? "PASS ✅ MCP arg normalization holds" : `FAIL ❌ ${fails} check(s) failed`);
process.exit(fails ? 1 : 0);
