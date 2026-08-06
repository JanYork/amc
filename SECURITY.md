# Security Policy

## Supported versions

Security fixes are provided for the latest published AMC release. AMC supports
macOS and Linux with Node.js 22 or newer.

## Reporting a vulnerability

Report vulnerabilities confidentially with a
[GitHub private security advisory](https://github.com/JanYork/amc/security/advisories/new).
Do not open a public issue for a suspected vulnerability.

Include only the minimum information needed to reproduce the issue: affected
version, impact, prerequisites, and sanitized steps. Do not include live tokens,
credentials, private configuration, or personally identifying paths. You can
expect acknowledgement through the advisory and coordinated discussion of
validation, remediation, and disclosure timing.

## Scope and safety expectations

AMC reads and updates provider-owned local files, symbolic links, backups, and
editor/provider processes. It also reads untrusted public skills.sh and GitHub
metadata and Skill files. Reports involving overwrite protection, repository or
redirect validation, bounded downloads, path containment, backup confidentiality,
permanent-delete or reconciliation journals, shared Skill discovery, symbolic-link handling,
rollback integrity, command execution, or credential exposure are particularly important.

Marketplace support accepts public GitHub repositories only. Optional GitHub authentication uses `GITHUB_TOKEN`, an owner-only AMC Token file, or OAuth credentials obtained from the official `gh` CLI according to the explicitly selected method. Tokens are never accepted as command arguments and Authorization is attached only to `api.github.com` requests. Remote symlinks and submodules are never followed or installed. A candidate Skill containing one is rejected; unsupported entries outside a nested Skill directory are ignored, while a root Skill remains scoped to the whole repository. Permanent
deletion is deliberately irreversible after exact secondary confirmation; an
interrupted operation retains a content-free resume journal rather than a
restorable copy.

Interactive TUI startup may reconcile unambiguous user-level Skills from
`.agent`, `.agents`, Claude, Pi, and Codex roots. Reconciliation uses contained
same-filesystem moves, exact backups, owner-only content-free journals, stale
checks, and verified AMC links. Divergent content, foreign links, invalid paths,
and cross-device moves fail closed. Headless inventory and reconciliation preview
remain read-only.

The project does not promise security support for modified builds, unsupported
platforms, unsupported Node.js versions, or third-party provider behavior.
