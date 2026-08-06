export const version = '0.1.0'; // x-release-please-version

export const helpText = `AMC — Agent Management CLI

Usage:
  amc
  amc list [--page <n>] [--limit <1-100>] [--search <text>]
  amc list --all [--search <text>]
  amc list --diagnostics [--page <n>] [--limit <1-100>] [--search <text>]
  amc list --diagnostics --all [--search <text>]
  amc enable <skill> [--target claude|pi|codex]
  amc disable <skill> [--target claude|pi|codex]
  amc migrate <skill> [--source claude|pi|codex]
  amc migrate --all [--yes]
  amc reconcile
  amc reconcile --apply --yes
  amc reconcile <skill> --source agents|agent|claude|pi|codex|canonical --apply --yes
  amc search <query> [--source skills.sh|github]
  amc auth github login
  amc auth github set --token-stdin
  amc auth github status
  amc repos list
  amc repos add <owner/repo> [--branch <branch>]
  amc repos refresh <owner/repo>
  amc repos enable|disable <owner/repo>
  amc repos remove <owner/repo>
  amc install <owner/repo> --skill <name> [--branch <branch>]
  amc upgrade <skill>
  amc updates check [<skill>]
  amc delete <skill> --yes --confirm <skill>
  amc plugins list [--page <n>] [--limit <1-100>] [--search <text>] [--all]
  amc plugins enable|disable <plugin-id>
  amc hooks list [--page <n>] [--limit <1-100>] [--search <text>] [--all]
  amc hooks edit <hook-id>
  amc hooks enable|disable <hook-id>
  amc mcp list [--page <n>] [--limit <1-100>] [--search <text>] [--all]
  amc mcp enable|disable <mcp-id>
  amc --help
  amc --version`;

