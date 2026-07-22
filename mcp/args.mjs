// Model-supplied MCP arguments go straight into SQL parameters, and
// node:sqlite binds only null/string/number/bigint/TypedArray — anything else
// (undefined from an omitted or misnamed field, a boolean, an object) threw a
// cryptic "Provided value cannot be bound to SQLite parameter N." mid-handler.
// Field-reported seven times across three projects (post_message ×5,
// log_activity, claim_resource): tool schemas are deferred client-side by
// default, so nothing validates a call before it lands here.
//
// normalizeArgs() closes the class at the boundary, driven by the inputSchema
// each tool already declares in tool-defs.mjs: values with one obvious meaning
// are coerced (42 -> "42", ["a","b"] -> "a\nb" for a string field, "x" ->
// ["x"] for an array field), uncoercible values are dropped, and a missing
// required field fails with an error naming the field and the keys actually
// received — so the calling model can self-correct on its next try instead of
// staring at a binding error.

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function coerceString(v) {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "bigint" || typeof v === "boolean") return String(v);
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v.join("\n");
  if (Array.isArray(v) || isPlainObject(v)) {
    try {
      return JSON.stringify(v);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function coerceNumber(v) {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function coerceArray(v) {
  const arr = Array.isArray(v) ? v : [v];
  return arr.map(coerceString).filter((x) => typeof x === "string" && x !== "");
}

export function normalizeArgs(def, raw) {
  const schema = def?.inputSchema || {};
  const props = schema.properties || {};
  const required = schema.required || [];
  const a = isPlainObject(raw) ? { ...raw } : {};
  for (const [key, prop] of Object.entries(props)) {
    if (a[key] === undefined || a[key] === null) {
      delete a[key];
      continue;
    }
    const c = prop.type === "number" ? coerceNumber(a[key]) : prop.type === "array" ? coerceArray(a[key]) : coerceString(a[key]);
    if (c === undefined) delete a[key];
    else a[key] = c;
  }
  const missing = required.filter((k) => a[k] === undefined || a[k] === "");
  if (missing.length) {
    const known = new Set(Object.keys(props));
    const received = Object.keys(isPlainObject(raw) ? raw : {});
    const stray = received.filter((k) => !known.has(k));
    const list = missing.map((k) => `"${k}" (${props[k]?.type || "string"})`).join(", ");
    let msg = `${def?.name || "tool"}: missing required argument${missing.length > 1 ? "s" : ""} ${list}.`;
    if (stray.length) msg += ` Unrecognized key${stray.length > 1 ? "s" : ""} ignored: ${stray.join(", ")} — check the parameter names and retry.`;
    else msg += ` Received: ${received.length ? received.join(", ") : "no arguments"}. Retry with the required field${missing.length > 1 ? "s" : ""}.`;
    throw new Error(msg);
  }
  return a;
}
