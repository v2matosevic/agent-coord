# Release procedure

Releases are MIT-licensed source distributions on GitHub. `package.json` stays
private to prevent accidental npm publication. There is no compiled server or
bundled Node runtime; users need Node 22.13+ (22.x) or Node 24+ and run setup after
extracting/cloning. SQLite became available without an experimental flag in
[Node 22.13](https://nodejs.org/api/sqlite.html).

## Before tagging

1. Review only the intended changes. Leave local stores, logs, `.env`, temporary
   directories, user configuration and unrelated work out of the commit.
2. Keep package and lockfile versions aligned. Update the changelog, installation
   instructions, security limits and versioned release notes.
3. Run `npm ci`, `npm audit`, then `npm test`. Resolve or explicitly document
   dependency advisories. The suite isolates coordination state; global
   installer tests also isolate git configuration. Run `git diff --check`.
4. For an installed machine, run setup and doctor. Record exactly which client
   integrations were configured and what was verified. Never claim that a
   configured Codex hook is trusted or executing.
5. Commit the intended files. Review `pending_push_review`, then push the branch
   and verify the remote SHA equals the tested commit.
6. Wait for CI on that exact SHA: Windows, macOS and Linux, Node 22.13.0 and 24.
   A different revision's green run does not validate this release.
   Linux/Node 24 also installs and smoke-tests a clean source archive without
   checkout metadata, so source-distribution coverage stays in CI.

## Source assets and draft release

Create archives with `git archive` from the release commit, not from the working
directory. This excludes untracked work and local state. Include a top-level
`agent-coord-<version>/` directory in both ZIP and tar.gz, plus `SHA256SUMS`.
Extract one archive into a temporary directory, verify the manifest/version and
required files, install the locked dependencies, and run the MCP smoke test.

Create an annotated `v<version>` tag at the verified commit and push that tag.
Upload the two archives and checksum file to a **draft** GitHub release using
the versioned release notes. Re-read the release metadata and downloaded asset
checksums to verify the result. Never move an already published version tag.

GitHub also offers automatically generated source archives. The uploaded ZIP
and tar.gz are convenient distributions of the same tagged source, with explicit
checksums. Dependencies are installed from the included lockfile, not bundled.

## Publication gate

A draft is prepared work, not a published release. Before marking it latest,
check CI and archive validation, and either complete the native Codex session
smoke check in `docs/CODEX.md` or explicitly document that host-level validation
remains outstanding. Configuration/fixture coverage must not be presented as a
live multi-session test. Keep significant limitations in the release body.

## Upgrade and rollback

Users update/extract the release, rerun setup, restart agent sessions, and review
changed Codex hook definitions in `/hooks`. Do not delete coordination state to
upgrade. Schema changes remain additive unless a migration is explicitly named.

To roll back code, use the previous release and rerun its setup. Remove new
Codex handlers if the previous release does not manage them. Restore backed-up
configuration carefully, preserving changes made by other tools since the
backup. `git-hookspath.prior` records the hook path replaced by setup; a legacy
backup that points to agent-coord itself cannot recover an earlier setting.
