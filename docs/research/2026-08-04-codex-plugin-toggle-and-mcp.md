# Codex plugin toggle and MCP notes

Date: 2026-08-04

Only first-party docs and official repositories are used below.

## Executive conclusion

- Codex has no `plugin enable` or `plugin disable` subcommand, but its official open-source configuration schema defines `plugins.<id>.enabled`. That makes a backed-up, transactional config edit a supported headless AMC path.
- Codex does officially expose config-level MCP enable/disable controls: top-level `mcp_servers.<id>.enabled` and plugin-bundled `plugins.<plugin>.mcp_servers.<server>.enabled` in `config.toml`.
- Claude Code officially supports headless plugin enable/disable and headless MCP add/list/get/remove flows, with `user`, `project`, and `local` scopes.
- Pi officially does not ship MCP. Its official resource-management model is packages plus extensions, with interactive `pi config` for enable/disable.

## Codex

### Plugin enable/disable

- Interactive toggle is official: Codex CLI uses `/plugins`, and pressing Space on an installed plugin turns it on or off.
- The plugin CLI itself covers `add`, `list`, and `remove`, but not enable/disable.
- `codex plugin list --json` includes `enabled`, so enabled state is observable.
- The official Codex config schema defines user-level `plugins` entries whose `PluginConfig.enabled` field defaults to `true`. AMC can therefore update `plugins."<id>".enabled`, then confirm the result through the JSON inventory.

Sources:

- Codex plugins docs: <https://learn.chatgpt.com/docs/plugins>
- Codex developer commands: <https://learn.chatgpt.com/docs/developer-commands?surface=cli>
- Codex config reference: <https://learn.chatgpt.com/docs/config-file/config-reference>
- Codex official config schema: <https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json>

### MCP

- Official headless CLI exists: `codex mcp` manages MCP server entries stored in `~/.codex/config.toml`.
- Official config keys include `mcp_servers.<id>.enabled`, `mcp_servers.<id>.scopes`, `mcp_servers.<id>.enabled_tools`, and `mcp_servers.<id>.disabled_tools`.
- Official config also supports plugin-bundled server controls under `plugins.<plugin>.mcp_servers.<server>.enabled`.

Sources:

- Codex developer commands: <https://learn.chatgpt.com/docs/developer-commands?surface=cli>
- Codex config reference: <https://learn.chatgpt.com/docs/config-file/config-reference>

## Claude Code

### Plugins

- Official headless plugin management exists: `claude plugin install`, `list`, `enable`, `disable`, `update`, `uninstall`, `prune`.
- Official docs/repo also indicate scoped operations and `enabledPlugins` settings behavior.
- `/reload-plugins` is the official interactive reload path for pending plugin changes.

Sources:

- Plugin docs: <https://code.claude.com/docs/en/plugins-reference>
- Discover/install plugins: <https://code.claude.com/docs/en/discover-plugins>
- Official repository changelog: <https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md>

### MCP

- Official MCP management exists in both interactive and headless forms.
- Official docs/repo cover `claude mcp add`, `list`, `get`, `remove`, `add-json`, and `add-from-claude-desktop`.
- Official scopes are `local`, `project`, and `user`.
- Official config surfaces include project `.mcp.json` plus settings-backed scope hierarchy.
- Official docs also cover disabling a server without removing it and managed MCP policy controls.

Sources:

- MCP docs: <https://code.claude.com/docs/en/mcp>
- Managed MCP docs: <https://code.claude.com/docs/en/managed-mcp>
- Official repository changelog: <https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md>

## Pi

### Plugins/extensions

- Pi’s official model is packages plus TypeScript extensions, not Codex/Claude-style installable plugins with separate headless enable/disable commands.
- Official package commands are `pi install`, `pi remove`, `pi update`, and `pi list`.
- Official enable/disable surface is the interactive `pi config` TUI.
- Official extension locations are `~/.pi/agent/extensions/` and `.pi/extensions/`, and auto-discovered extensions can be hot-reloaded with `/reload`.

Sources:

- Pi README: <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md>
- Pi packages docs: <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md>
- Pi extensions docs: <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md>
- Pi settings docs: <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md>

### MCP

- Pi’s official README explicitly says “No MCP.”
- Any MCP support in Pi would have to come from a custom extension or external package, not a built-in official MCP management surface.

Source:

- Pi README: <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md>

## AMC safety matrix

| Surface | Official headless read | Official headless write | Official interactive toggle | Official config/file toggle | Safe AMC stance |
| --- | --- | --- | --- | --- | --- |
| Codex plugin | Yes | Add/remove via CLI; enable/disable via config | Yes | Yes, `plugins.<id>.enabled` | Back up, atomically update, and verify the documented config state |
| Codex MCP server | Yes | Yes | Yes | Yes | Safe to automate within documented keys/commands |
| Claude plugin | Yes | Yes | Yes | Yes | Safe to automate |
| Claude MCP server | Yes | Yes | Yes | Yes | Safe to automate |
| Pi package/extension | Yes | Install/remove only | Yes via `pi config` | Settings/package filters exist, but no dedicated documented headless toggle command | Read/install/remove safely; leave enable/disable to `pi config` unless AMC later does explicit settings-file edits |
