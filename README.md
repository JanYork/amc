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

First inspect the current state. Listing is read-only and does not create AMC
directories:

```bash
amc list
```

Existing Skills remain where they are until an explicit migration command:

```bash
amc migrate writing-text
```

When valid copies with the same name differ, AMC stops and requires the copy
that should become canonical:

```bash
amc migrate writing-text --source claude
```

AMC moves every adopted original into a unique backup under `~/.amc/backups/`,
then links that Agent to `~/.amc/skills/<skill>`.

## Commands

```text
amc
amc list
amc enable <skill>
amc enable <skill> --target claude|pi|codex
amc disable <skill>
amc disable <skill> --target claude|pi|codex
amc migrate <skill>
amc migrate <skill> --source claude|pi|codex
amc --help
amc --version
```

Enable and disable target all three Agents by default. `--target` narrows the
operation to one Agent. Headless commands never prompt: success exits `0`, a
filesystem or state conflict exits `1`, and invalid usage exits `2`.

## TUI keys

| Key | Action |
| --- | --- |
| `↑` / `↓`, `j` / `k` | Move selection |
| `Space` | Toggle the selected Skill for all Agents |
| `1`, `2`, `3` | Toggle Claude, Pi, or Codex |
| `m` | Review and confirm migration |
| `r` | Refresh filesystem state |
| `q` | Quit |

States are `●` enabled, `○` disabled, `?` unmanaged, and `!` conflict.

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
foreign link, invalid entry, changed migration plan, or differing canonical
copy blocks the operation before replacement. If an unexpected failure needs
manual recovery, AMC prints the exact preserved paths; inspect them and verify
the destination is absent before moving anything back.

V1 intentionally has no registry downloads, project-local Skills, automatic
backup cleanup, Windows junction support, or concurrent-process coordination.

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
