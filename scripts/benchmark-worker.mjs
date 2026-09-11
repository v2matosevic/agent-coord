// Disposable child used by benchmark.mjs. Never points at the live store.
import { performance } from "node:perf_hooks";
import { getDb } from "../lib/store.mjs";

if (!process.env.AGENT_COORD_BENCHMARK || !process.env.AGENT_COORD_HOME) throw new Error("benchmark isolation required");
const start = performance.now();
getDb();
process.stdout.write(JSON.stringify({ storeOpenMs: performance.now() - start }));
