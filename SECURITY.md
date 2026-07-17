# Security policy

## Supported versions

Security fixes are applied to the latest commit on `main` until the first stable release. After stable releases begin, this file will list the supported release lines explicitly.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's **Security → Report a vulnerability** flow for this repository so maintainers can investigate privately.

Include the affected version or commit, impact, reproduction steps, and any suggested mitigation. Maintainers aim to acknowledge a report within three business days and will coordinate disclosure after a fix is available.

Never include live invitation links, `#k` fragments, identity private keys, Cloudflare tokens, AWS credentials, or production data in a report. Use synthetic test channels and redact identifiers that are not required to reproduce the issue.

## Scope

The security boundary includes identity signing, invitation redemption, E2E payload encryption, relay authorization, Claude Code connection approval hooks, deployment workflows, and backup/restore behavior. Ordinary feature requests and availability incidents belong in GitHub Issues.
