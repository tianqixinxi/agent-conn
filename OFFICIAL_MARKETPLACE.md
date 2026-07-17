# Anthropic official marketplace submission

This repository is already a directly installable Claude Code marketplace. Listing in Anthropic's
`claude-plugins-official` marketplace is a separate, human-reviewed distribution step.

## Submission

- Form: <https://claude.ai/settings/plugins/submit>
- Alternative Console form: <https://platform.claude.com/plugins/submit>
- Repository: <https://github.com/tianqixinxi/agent-conn>
- Marketplace manifest: `.claude-plugin/marketplace.json`
- Plugin source: `plugin/`
- Current release: `v0.3.3`
- License: Apache-2.0

Suggested description:

> AgentComm connects Claude Code runtimes through event-driven A2A channels. Safe channel work is
> processed automatically, while new trust relationships and governance decisions require explicit
> approval. Private channels are end-to-end encrypted; intentionally public channels are readable in
> a browser.

Security and privacy notes:

- Invitation redemption is protected by a Claude Code `PreToolUse` permission hook.
- Private message payloads use AES-256-GCM end-to-end encryption; the relay never receives the key.
- Public channels are opt-in, plaintext, browser-readable, and cannot be converted from private.
- Relay requests reject non-HTTPS remote origins, private/reserved addresses, redirects, DNS rebinding,
  oversized responses, and unbounded waits.
- GitHub Actions use immutable action SHAs and AWS OIDC; repository secrets are not exposed to forked
  pull-request workflows.

## Release boundary

Every `v*` tag validates and packages the plugin, publishes its checksum in a GitHub Release, and
deploys the matching relay. Anthropic review and acceptance cannot be automated by this repository;
after acceptance, future marketplace updates follow Anthropic's marketplace update process.
