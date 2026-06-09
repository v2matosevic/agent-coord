// detectWriteTargets — conservative shell-write detection. Pure (no store), fast.
// Asserts the real write vectors are caught, that quoted `>` is NOT a redirect,
// and that out-of-repo / fd / /dev paths are ignored.
import { detectWriteTargets } from "../lib/bash-targets.mjs";

// Drive-prefixed root on Windows: path.resolve("/repo", x) prefixes the current
// drive there, which would put every resolved path "outside" a bare "/repo".
const ROOT = process.platform === "win32" ? "C:/repo" : "/repo";
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

// PowerShell write vectors (Windows agents route shell work through the
// PowerShell tool — same guard, same detector)
t("Set-Content src/config.json 'x'", ["src/config.json"]);
t('"text" | Out-File -FilePath notes.md', ["notes.md"]);
t('Add-Content -Path readme.md "line"', ["readme.md"]);
t('echo x > "my file.txt"', ["my file.txt"]); // quoted target with a space

// false-positive guards
t("cat <<EOF > out.txt\nrm > evil.txt\nEOF", ["out.txt"]); // heredoc body is data, not commands
t("sed -i p config.json", ["config.json"]); // 'p' is a sed script, not a file
t('echo "use > inside a string" hello', []); // quoted > is literal
t('git commit -m "fix > the bug"', []); // commit message, not a redirect
t("ls -la && grep foo src/app.js", []); // read-only
t("cmd > /dev/null 2>&1", []); // /dev/null + fd dup
t("echo x > ../outside.txt", []); // escapes the repo
t("echo x > /etc/hosts", []); // absolute, outside repo
t("node x.mjs > $null", []); // PowerShell null sink, not a file
t("script > nul", []); // cmd.exe null sink
t("echo x > $env:TEMP/out.txt", []); // unexpandable variable — skip, never claim
t('echo "use Set-Content x.json for this"', []); // cmdlet named in prose

// cwd resolution: relative target in a subdir maps to the subdir's repo path
{
  const got = detectWriteTargets("echo x > out.txt", ROOT, ROOT + "/src");
  const pass = got.length === 1 && got[0] === "src/out.txt";
  if (!pass) ok = false;
  console.log(`  ${pass ? "✓" : "✗"} cwd-relative resolve\n      got=${JSON.stringify(got)} want=["src/out.txt"]`);
}

console.log(ok ? "PASS ✅" : "FAIL ❌");
process.exit(ok ? 0 : 1);
