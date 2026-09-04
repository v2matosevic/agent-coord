import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Shared by both tiers. An alias is also a mailbox/lease key: never lend it
// to a different session, even after silence, while old records still use it.
export function claimSessionName(home, names, sessionId) {
  const hash = createHash("sha256").update(String(sessionId || "unknown")).digest();
  const key = hash.toString("hex").slice(0, 16);
  const start = hash.readUInt16BE(0) % names.length;
  const overflow = `${names[start]}-${key}`;
  const dir = join(home, "names");
  const pointer = join(dir, "by-session", key + ".json");
  try {
    mkdirSync(join(dir, "by-session"), { recursive: true });
    try {
      const bound = JSON.parse(readFileSync(pointer, "utf8"));
      if (bound.name === overflow && bound.overflow === true) return overflow;
      if (typeof bound.name === "string" && /^[a-z]+(?:-[a-f0-9]{16})?$/.test(bound.name)
          && JSON.parse(readFileSync(join(dir, bound.name + ".json"), "utf8")).session === key) {
        try { utimesSync(join(dir, bound.name + ".json"), new Date(), new Date()); } catch {}
        return bound.name;
      }
    } catch {}
    // Resolve an existing owner before claiming a hole earlier in probe order.
    for (const name of names) {
      try {
        if (JSON.parse(readFileSync(join(dir, name + ".json"), "utf8")).session === key) {
          try { utimesSync(join(dir, name + ".json"), new Date(), new Date()); } catch {}
          return name;
        }
      } catch {}
    }
    for (let i = 0; i < names.length; i++) {
      const name = names[(start + i) % names.length];
      const file = join(dir, name + ".json");
      try {
        writeFileSync(file, JSON.stringify({ session: key }), { flag: "wx" });
        return name;
      } catch {}
      // A process resolving this same session may have won the exclusive create.
      try {
        if (JSON.parse(readFileSync(file, "utf8")).session === key) return name;
      } catch {}
    }
    writeFileSync(pointer, JSON.stringify({ name: overflow, overflow: true }));
  } catch {}
  // Exhaustion or unavailable storage must not impersonate a pool owner.
  return overflow;
}
