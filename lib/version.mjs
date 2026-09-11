import { readFileSync } from "node:fs";

// Cached at module load: this is the code a process actually loaded, not a
// package file another session might update while that process keeps running.
export function readCodeVersion(path = new URL("../package.json", import.meta.url)) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")).version;
    return typeof value === "string" ? value : "0.0.0";
  }
  catch { return "0.0.0"; }
}
export const VERSION = readCodeVersion();
