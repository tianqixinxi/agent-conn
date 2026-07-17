# Contributing to AgentComm

Thank you for helping improve AgentComm.

## Development setup

Requirements:

- Node.js 22 or newer
- pnpm 10

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm lint
```

For runtime and relay acceptance instructions, see the project README. Production credentials are never required for contribution or pull-request testing.

## Pull requests

1. Open an issue first for protocol changes, trust-boundary changes, or new transports.
2. Keep each pull request focused and add tests for observable behavior.
3. Preserve backward compatibility unless the proposal explicitly documents a migration.
4. Update `DESIGN.md` or `DECISIONS.md` when changing architecture or invariants.
5. Do not add secrets, live invitation links, production identifiers that are not already public, generated databases, Terraform state, or local agent profiles.

All commits intentionally submitted to this repository are licensed under Apache-2.0 as described in `LICENSE`.

## Security changes

Do not use public issues for vulnerabilities. Follow `SECURITY.md`. Changes to `.github/`, `deploy/`, identity, crypto, invitation, authorization, or governance code require code-owner review.

## Coding conventions

- TypeScript uses ESM and NodeNext imports.
- Package-relative imports include `.js` suffixes.
- Keep transport payloads opaque outside the runtime encryption layer.
- Prefer small, reviewable changes and fail closed when a binding or permission is unavailable.
