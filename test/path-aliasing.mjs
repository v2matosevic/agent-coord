// §7.2 — every spelling of the same file under a repo root must collapse to one
// canonical key, or two agents could "lock different files" that are really the
// same file on disk.
import { canonicalFilePath } from "../lib/path-canon.mjs";

const root = "B:/Coding/Version2.0";
const spellings = [
  "B:/Coding/Version2.0/src/app/page.tsx",
  "B:\\Coding\\Version2.0\\src\\app\\page.tsx",
  "src/app/page.tsx",
  "./src/app/page.tsx",
  "src\\app\\page.tsx",
  "b:/coding/version2.0/src/app/page.tsx",
];

const canon = spellings.map((s) => canonicalFilePath(s, root));
canon.forEach((c, i) => console.log(`  ${spellings[i].padEnd(46)} -> ${c}`));

const uniq = [...new Set(canon)];
console.log("unique keys:", JSON.stringify(uniq));
const pass = uniq.length === 1 && uniq[0] === "src/app/page.tsx";
console.log(pass ? "PASS ✅ all spellings collapse to one key" : "FAIL ❌");
process.exit(pass ? 0 : 1);
