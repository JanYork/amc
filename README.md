# AMC — Agent Management CLI

AMC keeps one canonical copy of each Agent Skill in `~/.amc/skills/` and
connects it to Claude Code, Pi, and Codex with symbolic links. Run `amc` for
the Ink terminal UI, or use subcommands in scripts and shell workflows.

## Requirements

- macOS or Linux
- Node.js 22 or newer

## Install from this repository

```bash
npm install
npm run build
npm install --global .
```

The global install creates the `amc` command. During development, replace it
with `node dist/src/main.js` after `npm run build`.

## Start safely

First inspect the current state. Both commands are read-only:

```bash
amc list
amc migrate --all
```

`amc list` shows 20 rows by default. `amc migrate --all` prints a bounded dry
run with ready, managed, divergent, blocked, and warning counts. Neither command
creates or moves anything.

Apply every unambiguous Skill only after reviewing that dry run:

```bash
amc migrate --all --yes
```

Bulk apply skips differing copies. Resolve each one explicitly:

```bash
amc migrate writing-text --source claude
```

Every Skill is its own transaction. AMC stops on the first unexpected failure,
keeps completed Skills managed, lists pending names, and supports rerunning from
fresh filesystem state. Every replaced entry is preserved under a reported
per-Skill root in `~/.amc/backups/`.

## Commands

```text
amc
amc list [--page <n>] [--limit <1-100>] [--search <text>]
amc list --all [--search <text>]
amc list --diagnostics [--page <n>] [--limit <1-100>] [--search <text>]
amc list --diagnostics --all [--search <text>]
amc enable <skill>
amc enable <skill> --target claude|pi|codex
amc disable <skill>
amc disable <skill> --target claude|pi|codex
amc migrate <skill>
amc migrate <skill> --source claude|pi|codex
amc migrate --all
amc migrate --all --yes
amc plugins list [--page <n>] [--limit <1-100>] [--search <text>] [--all]
amc plugins enable <plugin-id>
amc plugins disable <plugin-id>
amc hooks list [--page <n>] [--limit <1-100>] [--search <text>] [--all]
amc hooks edit <hook-id>
amc mcp list [--page <n>] [--limit <1-100>] [--search <text>] [--all]
amc mcp enable <mcp-id>
amc mcp disable <mcp-id>
amc --help
amc --version
```

`list` is an aligned table with 20 rows per page by default; use `--all` only
when intentionally producing the complete stream. Diagnostics are a separate,
paginated view. Search is case-insensitive; Skill mode searches names, while
diagnostic mode searches messages and paths. Redirected output contains full
names and no terminal color codes.

Enable and disable target all three Agents by default. `--target` narrows an
operation to one Agent. Headless commands never prompt: success exits `0`, a
filesystem or state conflict exits `1`, and invalid usage exits `2`.

Plugin inventory comes from each provider's public CLI. Claude Code plugins
use their native headless commands. Codex plugins use the documented
`plugins.<id>.enabled` setting in `~/.codex/config.toml`; AMC backs up the file,
writes it atomically, verifies the resulting inventory, and restores the
original on failed verification. Pi package resources still require `pi config`.

MCP inventory combines Claude Code's user, local, and project definitions with
Codex's native JSON inventory. `mcp enable` and `mcp disable` preserve the
server definition: Codex uses `mcp_servers.<id>.enabled`, while Claude records
the current project's enablement state in `~/.claude.json`. AMC never prints
MCP environment values, headers, OAuth tokens, or credentials. Pi deliberately
has no native MCP registry; extension-provided MCP support is outside AMC's
native MCP view.

Hook inventory is read-only, and `hooks edit` opens the selected
provider-owned source with `$VISUAL` or `$EDITOR`. AMC never executes a Hook
while inspecting it; if neither variable is set, it reports how to configure one.

## TUI keys

| Key | Action |
| --- | --- |
| `Tab` | Switch Skills, Hooks, Plugins, and MCP |
| `↑` / `↓`, `j` / `k` | Move selection |
| `Page Up` / `Page Down` | Move one visible page |
| `Home` / `End` | Jump to first or last result |
| `←` / `→` | Choose All, Claude, Pi, or Codex action scope |
| `Space` | Toggle the selected Skill in the current scope |
| `1`, `2`, `3` | Toggle Claude, Pi, or Codex |
| `/` | Start live, case-insensitive name search |
| `Enter` | Keep the current search |
| `Esc` | Close help, cancel a modal, or clear search |
| `m` | Review migration; use `1`/`2`/`3` for a divergent source and `y`/`n` to confirm or cancel |
| `r` | Refresh filesystem state |
| `?` | Open or close keyboard help |
| `q` | Quit |

In Hooks, press `e` to leave AMC and open the selected source file. In Plugins,
press `Space` to toggle a Claude Code or Codex plugin; Pi shows its required
interactive command. In MCP, press `Space` to toggle a Claude Code or Codex
server without removing its definition. All four views cap the visible list at
20 rows and support `/` search, arrows, `j`/`k`, `r`, and `q`.

AMC renders at most 20 Skill rows and keeps the selection visible while
scrolling. The actual row count shrinks with terminal height. Below 44 columns
or 10 rows it shows a bounded resize message instead of wrapping the list;
only `q` remains active until the terminal is resized.

When the terminal is at least 16 rows tall, AMC shows the selected Skill's
description and source `SKILL.md` path below the table. Long descriptions wrap
across two lines. Descriptions come from frontmatter, with the first body
paragraph as a fallback.

The bordered table highlights the selected scope and row. States use green
`●` enabled, dim `○` disabled, yellow `◇` unmanaged, and red `!` conflict.

AMC detects dark and light terminal backgrounds when `COLORFGBG` is available.
Override detection when needed:

```bash
AMC_THEME=dark amc
AMC_THEME=light amc
AMC_THEME=mono amc
```

Valid themes are `dark`, `light`, and `mono`. `NO_COLOR` always selects mono,
and redirected command output never contains ANSI color escapes.

## Filesystem layout

```text
~/.amc/
├── skills/<skill>/
├── backups/<operation>/<target>/<skill>/
├── backups/<operation>/links/<target>/<skill>
├── backups/<operation>/staging/<skill>/
├── disabled-links/<target>/<skill>
├── staging/<operation>/<skill>/
└── failed/<operation>/
```

AMC links the canonical store to:

| Agent | Skill directory |
| --- | --- |
| Claude Code | `~/.claude/skills/` |
| Pi | `~/.pi/agent/skills/` |
| Codex | `~/.codex/skills/` |

AMC does not delete originals, backups, parked links, or failed artifacts. A
valid foreign link is adoptable: AMC copies its resolved Skill into the
canonical store, archives only the Agent-facing link, and leaves the external
source unchanged. A broken link is archived only when another valid same-name
Skill is being adopted into that target. Broken-only links and invalid entries
remain untouched diagnostics.

Predictable paths are created exclusively. If filesystem state changes after
planning, AMC stops instead of overwriting it. If recovery also meets a new
object, AMC preserves both sides and prints the exact manual recovery paths.

AMC intentionally has no registry downloads, project-local Skills, automatic
backup cleanup, Windows junction support, or global process lock.

## Architecture

```text
src/tui/   Ink rendering and keyboard state
src/cli/   argument parsing and headless text output
src/core/  scanning, fingerprints, links, backups, and recovery
```

Only the core layer performs filesystem operations. Both frontends receive the
same typed results and call the same core functions.

## Development

```bash
npm test
npm run typecheck
npm run build
npm pack --dry-run
```

Tests use isolated temporary home directories and do not write to the current
user's AMC, Claude, Pi, or Codex Skill directories.
