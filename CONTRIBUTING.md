# Contributing to AMC

Thank you for improving AMC. By participating, you agree to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Before opening a change

- Search existing issues and pull requests.
- Use an issue for behavior, public API, or scope proposals before implementation.
- Report vulnerabilities through the private process in [SECURITY.md](SECURITY.md),
  not through a public issue.
- Never include credentials, tokens, private configuration, or sensitive paths.

## Development setup

AMC supports development on macOS and Linux with Node.js 22 or newer.

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run coverage
npm run build
npm pack --dry-run
```

Tests must use isolated temporary homes. Do not point tests at real Claude Code,
Pi, Codex, or AMC directories.

## Pull requests

Keep changes focused and preserve the safety model: read-only planning first,
exclusive destinations, verified backups, rollback paths, runtime injection,
and credential-safe output. Add or update tests for observable behavior. Use ESM
`.js` import specifiers in TypeScript and keep strict type checks green.

Describe the motivation, behavior, validation, risks, and recovery implications
in the pull request. Documentation should be concise and update both READMEs
when user-facing instructions change substantially.

Contributions are submitted under the [Apache License 2.0](LICENSE).
