import {
  mkdirSync,
  writeFileSync,
  rmSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { PRESENCE_DIR } from "./identity.mjs";

// One file per agent => last-write-wins per file, no cross-process append
// interleaving (the Windows append-corruption trap the design flags). Readers
// tolerate a partial/garbage read by skipping that file for one tick.

function ensureDir() {
  mkdirSync(PRESENCE_DIR, { recursive: true });
}

function fileFor(agentId) {
  return join(PRESENCE_DIR, `${agentId}.json`);
}

export function writePresence(record) {
  ensureDir();
  writeFileSync(fileFor(record.agentId), JSON.stringify(record, null, 2));
}

export function readExisting(agentId) {
  try {
    return JSON.parse(readFileSync(fileFor(agentId), "utf8"));
  } catch {
    return null;
  }
}

export function removePresence(agentId) {
  try {
    rmSync(fileFor(agentId), { force: true });
  } catch {}
}

export function listPresence() {
  let names;
  try {
    names = readdirSync(PRESENCE_DIR);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const full = join(PRESENCE_DIR, name);
    try {
      const rec = JSON.parse(readFileSync(full, "utf8"));
      out.push({ ...rec, _mtimeMs: statSync(full).mtimeMs });
    } catch {}
  }
  return out;
}

export function prune(maxAgeMs) {
  let names;
  try {
    names = readdirSync(PRESENCE_DIR);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const full = join(PRESENCE_DIR, name);
    try {
      if (now - statSync(full).mtimeMs > maxAgeMs) rmSync(full, { force: true });
    } catch {}
  }
}
