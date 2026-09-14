// Global commit-msg body: stamp `Machine: <name>` on each commit so a repo
// shared between machines shows which one made it (GitHub renders the trailer
// on the commit page; `git log --grep "Machine: olympus"` filters by it).
//
// Never blocks: every failure exits 0 and leaves the message as written.
// Leaves alone: an empty message (git must still abort it), a message that
// already names a machine (amend/cherry-pick keep the original), and public
// GitHub repos, which keep a clean single-author history. A GitHub remote whose
// visibility is unknown (offline, never cached) is also left alone: a missing
// stamp costs nothing, a stray one in a public repo is permanent.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { machineName, isEmptyMessage } from "../lib/machine.mjs";
import { parseGitHubRepo, isPublicGitHubRemote } from "../lib/public-remote.mjs";

async function shouldStamp() {
  let origin = "";
  try {
    origin = execFileSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {}
  if (!parseGitHubRepo(origin)) return true;
  return (await isPublicGitHubRemote(origin)) === false;
}

const file = process.argv[2];
try {
  if (file && !isEmptyMessage(readFileSync(file, "utf8")) && (await shouldStamp())) {
    execFileSync(
      "git",
      ["interpret-trailers", "--in-place", "--if-exists", "doNothing", "--trailer", `Machine: ${machineName()}`, file],
      { stdio: "ignore" },
    );
  }
} catch {}
process.exit(0);
