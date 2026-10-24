# Native Kimi Code in ADE

2026-10-24, Athena-i804. Kimi Code 2.3.1 supports native ACP and Claude-shaped
hook events. ADE supplies a unique `ade-terminal-<uuid>` capture for each launch.
It passes that capture as `AGENT_COORD_SESSION_ID`, with
`AGENT_COORD_TOOL=kimi-code`, to the terminal and its child tools.

`hooks/kimi.mjs` maps SessionStart, UserPromptSubmit, tool events, heartbeat and
SessionEnd to the existing coordination handlers. Hooks and the MCP server use
the same capture, including after Kimi changes its own conversation through a
resume. Explicit Kimi context takes precedence over inherited outer client IDs.
The shared name-claim store remains the authority for animal names.

ADE adds its cockpit MCP entry and, when this checkout is already registered,
the coordination MCP entry to Kimi's existing `mcp.json`. It appends a marked
hook block to Kimi's existing `config.toml`. Other settings, hooks, providers,
credentials and disabled user entries remain owned by the user. No setup or
global shell/PATH change is required. Update this source on each machine before
the corresponding ADE native acceptance check. Existing processes retain their
loaded modules; this change does not restart them.

Validation on Olympus: all 65 isolated test files passed, including
`test/kimi-integration.mjs`, Claude/Codex identity isolation, lifecycle, file
claims and messaging. `node cli/doctor.mjs` passed 10/10. This establishes the
coordination adapter contract, not an installed ADE peer-prompt acceptance.

Kimi's file fields and recognized shell writes use the existing fail-open hook
guards. MCP claims and the global commit guard remain separate. Do not describe
hooks as a complete filesystem sandbox.

Protocol sources:

- [Kimi hook events](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/customization/hooks.md)
- [Kimi MCP configuration](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/customization/mcp.md)
