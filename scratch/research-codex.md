# Research Notes - npm Publishing for `@meridian/remote-workspace`

## Problem Statement
Prepare this repo to publish safely and repeatably to npm, with correct CLI behavior, minimal package contents, and modern npm security/release practices.

## Codebase Context
- Package initially blocked publish via `"private": true`; this was removed during preparation.
- CLI entry is already configured: `"bin": { "remote-workspace": "dist/launcher.js" }` in `package.json:24`.
- Build emits runtime JS into `dist/` (`package.json:9`, `tsconfig.json` outDir).
- Server runtime serves static assets from `../static` relative to built file (`src/server.ts:1080`), so published package must include `static/`.
- Initial `npm pack --dry-run` included many non-runtime files (for example `src/*`, `HANDOFF.md`, `tsconfig.json`), and could include local temp files if created in repo.

## Best Practices (Official Docs)
- Use `"private": true` to prevent accidental publish; remove it only when intentionally publishing.
- For scoped public packages, first publish typically needs `--access public` (or equivalent config).
- Control published contents with package `files` allowlist (safer than relying on ignore defaults).
- Use lifecycle scripts such as `prepack`/`prepublishOnly` to ensure build + checks run before publish.
- Prefer npm Trusted Publishing (OIDC) in CI for stronger security and optional provenance, instead of long-lived automation tokens.
- If not using Trusted Publishing, use short-lived/granular tokens and enforce account/package security settings (2FA or equivalent policy controls).

## Alternative Approaches

### Approach A: Minimal manual publish
Description:
- Remove `"private": true`, run `npm publish --access public` from local machine.

Pros:
- Fastest path, minimal changes.

Cons:
- Higher risk of accidentally shipping extra files.
- Relies on local machine credentials/tokens.
- Weaker release repeatability.

Codebase fit:
- Works immediately but does not address this repo's current over-inclusive pack output.

### Approach B: Hardened manual publish with packaging controls
Description:
- Remove `"private": true`.
- Add `files` allowlist for runtime assets only (`dist/**`, `static/**`, `README.md`, `LICENSE*`).
- Add `prepack` script to build before packing.
- Add `publishConfig.access: "public"` for scoped package ergonomics.
- Verify with `npm pack --dry-run` before publish.

Pros:
- Prevents accidental file leaks.
- Keeps local/manual workflow simple.
- Strongly improves reproducibility and safety with small repo changes.

Cons:
- Still depends on local npm auth/token hygiene.
- No automatic provenance unless added separately.

Codebase fit:
- Strong fit. Repo already has clean build artifacts and explicit bin entry; only packaging guardrails are missing.

### Approach C: CI-driven Trusted Publishing + provenance
Description:
- Keep Approach B packaging controls.
- Publish from GitHub Actions using npm Trusted Publishing (OIDC), optionally with provenance enabled.
- Protect publish via tagged releases or protected branch workflow.

Pros:
- Best security posture (no long-lived npm publish tokens in secrets).
- Repeatable and auditable releases.
- Better long-term maintainer workflow.

Cons:
- Requires CI workflow setup and npm package/trusted publisher configuration.
- Slightly more setup time than manual publish.

Codebase fit:
- Best long-term fit if this package will be versioned/released regularly.

## Recommendation
Adopt **Approach B now**, then move to **Approach C** once first publish is validated.

Reasoning:
- This repo's immediate risk is packaging scope. `files` + `prepack` + `publishConfig.access` directly fix that with low complexity.
- Trusted Publishing is the right long-term endpoint, but not required to unblock first release.

## Open Questions
- Public vs private package visibility policy for the first release?
- License choice (MIT/Apache-2.0/etc.) and whether to include `LICENSE`.
- Should first release be `0.1.x` or `1.0.0` based on API stability expectations?

## Sources
- https://docs.npmjs.com/cli/v11/configuring-npm/package-json
- https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/
- https://docs.npmjs.com/cli/v11/commands/npm-publish
- https://docs.npmjs.com/cli/v11/using-npm/scripts/
- https://docs.npmjs.com/trusted-publishers/
- https://docs.npmjs.com/about-access-tokens/
