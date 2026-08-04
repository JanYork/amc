# Hooks and plugins across Codex, Claude Code, and Pi

Date: 2026-08-04

This note uses only first-party product documentation, the official Pi
repository, and read-only checks against the locally installed CLIs.

## Executive conclusion

AMC can manage these resources, but they do not share one native model:

- Codex and Claude Code both expose declarative hooks and installable plugins.
- Pi exposes extension event handlers and packages, not standalone hooks and
  plugins with the same semantics.
- A safe AMC implementation must expose provider capabilities instead of
  pretending every resource supports the same operations.

## Codex

### Hooks

Codex discovers `hooks.json` and inline `[hooks]` tables from active config
layers. Common user locations are `~/.codex/hooks.json` and
`~/.codex/config.toml`; project-local equivalents live under `.codex/`.
Installed plugins can also contribute hooks.

The `/hooks` browser can inspect sources, review trust, and disable or re-enable
individual non-managed hooks. `[features] hooks = false` disables hooks as a
feature. Managed hooks cannot be disabled by a user.

Editing is file-based; the official docs do not expose a stable headless
command for adding or editing hook definitions.

Source: [Codex Hooks](https://learn.chatgpt.com/docs/hooks)

### Plugins

`/plugins` provides an interactive browser. Space toggles an installed plugin.
The stable `codex plugin` command supports add, list, and remove; `list --json`
returns installed and enabled state. The current command surface does not
provide headless enable/disable subcommands.

Sources:

- [Codex Plugins](https://learn.chatgpt.com/docs/plugins)
- [Codex developer commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli#cli-codex-plugin)

## Claude Code

### Hooks

Claude Code stores hooks in `~/.claude/settings.json`, project
`.claude/settings.json`, project-local `.claude/settings.local.json`, managed
settings, plugin hook files, and active skill or agent frontmatter.

`/hooks` is explicitly read-only. Definitions are edited in JSON or in their
own component files and are normally reloaded by the settings watcher.
`disableAllHooks: true` temporarily disables all non-managed hooks. Claude Code
does not support disabling one configured hook while leaving its definition in
place; individual removal means deleting its configuration entry.

Sources:

- [Claude Code Hooks reference](https://code.claude.com/docs/en/hooks)
- [Claude Code Hooks guide](https://code.claude.com/docs/en/hooks-guide)

### Plugins

Claude Code provides both an interactive `/plugin` manager and scriptable shell
commands. `claude plugin list --json` reports installed state. `claude plugin
enable` and `claude plugin disable` operate at user, project, or local scope;
install, update, details, and uninstall are also documented. Running sessions
can apply changes with `/reload-plugins`.

Sources:

- [Discover and install Claude Code plugins](https://code.claude.com/docs/en/discover-plugins)
- [Claude Code plugins reference](https://code.claude.com/docs/en/plugins-reference)

## Pi

### Extension hooks

Pi calls the extension unit an **extension**. A TypeScript extension subscribes
to lifecycle events with `pi.on(...)` and can intercept or modify tool calls,
inject context, and customize compaction. Auto-discovered extensions live in
`~/.pi/agent/extensions/` or project `.pi/extensions/` and can be hot-reloaded
with `/reload`.

Pi has no separate declarative hook registry or hook-level enable flag. The
manageable unit is the extension file or package resource, not each `pi.on`
handler inside source code.

Source: [Pi extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)

### Packages

Pi packages bundle extensions, skills, prompt templates, and themes. `pi
install`, `pi remove`, `pi update`, and `pi list` manage package installation.
`pi config` is an interactive TUI that enables or disables individual package
resources at global or project scope. The documented settings schema supports
resource filters, but there is no documented non-interactive JSON enable or
disable command.

Sources:

- [Pi packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
- [Pi CLI usage](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/usage.md)
- [Pi settings](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md)

## Local CLI verification

The installed versions checked on 2026-08-04 were Codex CLI `0.146.0`, Claude
Code `2.1.212`, and Pi `0.80.6`.

- `codex plugin` exposed add/list/marketplace/remove, but no headless toggle.
- `claude plugin` exposed list/details/install/enable/disable/update/uninstall.
- `pi` exposed install/remove/update/list and interactive `pi config`.

## Recommended AMC boundary

### Hooks view

- Inventory definitions from every documented source and show provider, scope,
  event, matcher, handler type, source path, and native management capability.
- Open the owning file in `$EDITOR` for editing; do not rewrite arbitrary user
  hook files in the first release.
- Offer native global toggles for Codex and Claude Code.
- Offer individual toggles only where the provider has a supported mechanism.
  For Claude Code, an AMC-owned disabled store could be added later, but moving
  entries out of user JSON must be transactional and explicitly opt-in.
- Model Pi event handlers as extensions. Do not claim to toggle individual
  hooks inside TypeScript source.

### Plugins view

- Call Claude Code's JSON/list and enable/disable commands directly.
- Use Codex JSON listing for inventory and the native `/plugins` browser for
  toggles until a documented headless toggle exists. Directly editing private
  plugin state would couple AMC to an unstable implementation detail.
- Model Pi packages and their resources separately. Delegate interactive
  resource toggling to `pi config` initially; add settings-file automation only
  after defining lossless JSON edits and rollback behavior.

### Product model

Use three top-level views: `Skills`, `Hooks`, and `Plugins`. In the provider
adapter layer, represent operations as capabilities such as `native-headless`,
`native-interactive`, `config-edit`, and `unsupported`. The TUI should disable
unsupported actions and explain why instead of silently approximating them.

