// Helper: open the store in a fresh process (triggers schema init + guards).
import { getDb } from "../lib/store.mjs";
getDb();
