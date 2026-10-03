# Security policy

dash controls a privileged, terminal-capable agent (Hermes), so security reports are
welcome and taken seriously.

## Reporting a vulnerability

Please **do not open a public issue** for a vulnerability. Use GitHub's private
vulnerability reporting for this repository (Security → Report a vulnerability) with:

- the affected version (shown in the dash header and in `manifest.json`),
- the Hermes version (`hermes --version`),
- reproduction steps and the impact you observed.

You should receive an acknowledgement within a few days. Fixes are released as patch
versions and noted in `CHANGELOG.md`.

Vulnerabilities in Hermes itself (gateway, API server, Dashboard) should go to the Hermes
Agent project.

## Supported versions

| Version | Supported |
|---------|-----------|
| 1.x     | yes       |
| < 1.0   | no        |

## Scope and design

The threat model, trust boundaries and hardening (credential handling, mutation guard,
rendering rules, approvals, uploads) are documented in [docs/security.md](docs/security.md).
Deployment guidance (keeping the API server on loopback, proxy/Tailscale setup, auth) is in
[docs/deployment.md](docs/deployment.md).
