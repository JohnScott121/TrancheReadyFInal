# Security Policy

- Data is processed in memory only (no disk persistence).
- No system credentials or integrations are required.
- Evidence ZIP is cached in-memory behind a short-lived token (TTL configurable via `VERIFY_TTL_MIN`).
- Optional Ed25519 signing of `manifest.json` via `SIGN_PUBLIC_KEY` / `SIGN_PRIVATE_KEY`.
- Set `TRUST_PROXY=1` on Render so IPs are logged correctly.
- Contact: security@trancheready.com
