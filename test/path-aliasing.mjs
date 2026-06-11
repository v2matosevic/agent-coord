// §7.2 — every spelling of the same file under a repo root must collapse to one
// canonical key, or two agents could "lock different files" that are really the
// same file on disk. Path spellings are OS-specific, so the test cases are too:
// Windows has drive letters + backslashes + case-insensitivity; POSIX has none of
// those, so feeding Windows spellings on macOS/Linux is meaningless (they parse as
// odd relative names). Each platform tests the spellings that actually occur on it.
import { canonicalFilePath, isRepoRelative } from "../lib/path-canon.mjs";

const isWin = process.platform === "win32";

const { root, spellings } = isWin
  ? {
      root: "B:/Coding/Version2.0",
      spellings: [
        "B:/Coding/Version2.0/src/app/page.tsx",
        "B:\\Coding\\Version2.0\\src\\app\\page.tsx",
        "src/app/page.tsx",
        "./src/app/page.tsx",
        "src\\app\\page.tsx",
        "b:/coding/version2.0/src/app/page.tsx",
      ],
    }
  : {
      root: "/Users/dev/Coding/project",
      spellings: [
        "/Users/dev/Coding/project/src/app/page.tsx",
        "src/app/page.tsx",
        "./src/app/page.tsx",
        "src//app/page.tsx",
        "sub/../src/app/page.tsx",
      ],
    };

const canon = spellings.map((s) => canonicalFilePath(s, root));
canon.forEach((c, i) => console.log(`  ${spellings[i].padEnd(46)} -> ${c}`));

const uniq = [...new Set(canon)];
console.log("unique keys:", JSON.stringify(uniq));

// Inside-vs-outside: repo-scoped enforcement (duplicate-work stand-down) must
// recognize that an out-of-repo canonical path is none of this repo's business.
const scopeOk =
  isRepoRelative("src/app/page.tsx") &&
  !isRepoRelative("c:/users/someone/.claude/memory/note.md") &&
  !isRepoRelative("/home/someone/.claude/memory/note.md") &&
  !isRepoRelative(null);
console.log(scopeOk ? "  isRepoRelative: in/out classified correctly" : "  isRepoRelative FAILED");

const pass = uniq.length === 1 && uniq[0] === "src/app/page.tsx" && scopeOk;
console.log(pass ? "PASS ✅ all spellings collapse to one key" : "FAIL ❌");
process.exit(pass ? 0 : 1);
