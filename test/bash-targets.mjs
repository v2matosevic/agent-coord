// detectWriteTargets — conservative shell-write detection. Pure (no store), fast.
// Asserts the real write vectors are caught, that quoted `>` is NOT a redirect,
// and that out-of-repo / fd / /dev paths are ignored.
import { detectWriteTargets } from "../lib/bash-targets.mjs";

const ROOT = "/repo";
let ok = true;
const eq = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
const t = (cmd, expected) => {
  const got = detectWriteTargets(cmd, ROOT).sort();
  const want = expected.slice().sort();
  const pass = eq(got, want);
  if (!pass) ok = false;
  console.log(`  ${pass ? "✓" : "✗"} ${cmd}\n      got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};

// true positives
t("echo hi > config.json", ["config.json"]);
t("cat x >> logs/app.log", ["logs/app.log"]);
t("build 2> err.txt", ["err.txt"]);
t("sed -i 's/a/b/g' src/app.js", ["src/app.js"]);
t("sed -i '' 's/a/b/' src/app.js", ["src/app.js"]); // BSD/macOS form
t("cp dist/a.js dist/b.js", ["dist/b.js"]);
t("mv old.txt sub/new.txt", ["sub/new.txt"]);
t("touch a.txt b.txt", ["a.txt", "b.txt"]);
t("cmd | tee -a out.log", ["out.log"]);
t("sed -i -e 1d file.txt", ["file.txt"]); // -e: the script is the flag's arg, not a file
t("sed -i d notes.log", ["notes.log"]); // no -e: first positional is the script, dropped

// false-positive guards
t("cat <<EOF > out.txt\nrm > evil.txt\nEOF", ["out.txt"]); // heredoc body is data, not commands
t("sed -i p config.json", ["config.json"]); // 'p' is a sed script, not a file
t('echo "use > inside a string" hello', []); // quoted > is literal
t('git commit -m "fix > the bug"', []); // commit message, not a redirect
t("ls -la && grep foo src/app.js", []); // read-only
t("cmd > /dev/null 2>&1", []); // /dev/null + fd dup
t("echo x > ../outside.txt", []); // escapes the repo
t("echo x > /etc/hosts", []); // absolute, outside repo

console.log(ok ? "PASS ✅" : "FAIL ❌");
process.exit(ok ? 0 : 1);
