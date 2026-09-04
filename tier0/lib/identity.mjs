import { claimSessionName } from "./name-claims.mjs";
import { homedir } from "node:os";
import { join } from "node:path";

// Speakable, single-word agent names. Words are deliberately common,
// easy-to-say English — the operator often addresses agents through voice
// transcription — and the list must stay in sync with lib/identity.mjs so
// both tiers name a session identically.
//
// Keep existing names owned. Exhaustion uses a stable session suffix; aliases
// cannot recycle while historical mail and provenance still use their keys.
const NAMES = [
  "fox", "wolf", "bear", "hawk", "owl", "deer", "duck", "frog",
  "crab", "seal", "goat", "horse", "mouse", "otter", "rabbit", "tiger",
  "lion", "panda", "eagle", "shark", "whale", "snake", "swan", "crow",
  "robin", "badger", "beaver", "bison", "camel", "dolphin", "falcon", "gecko",
  "koala", "llama", "monkey", "moose", "penguin", "turtle", "zebra", "puma",
  "rhino", "hippo", "gorilla", "jaguar", "leopard", "cheetah", "donkey", "ferret",
  "heron", "lobster", "octopus", "parrot", "pelican", "pigeon", "pony", "raccoon",
  "salmon", "sparrow", "squid", "toad", "trout", "walrus", "weasel", "yak",
];

export const COORD_HOME = process.env.AGENT_COORD_HOME || join(homedir(), ".agent-coord");
export const PRESENCE_DIR = join(COORD_HOME, "presence");

export function agentIdFromSession(sessionId) {
  return claimSessionName(COORD_HOME, NAMES, sessionId);
}
