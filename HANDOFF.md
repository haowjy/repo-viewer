# Handoff: Remote Workspace (Standalone Repo)

Date: 2026-02-22
Repo: `/home/jimyao/gitrepos/remote-workspace`

## What This Is
Remote/mobile workspace for SSH + tmux workflows:
- browse repo files from phone
- upload/delete images in `.clipboard`
- view folder image grids from the Files tab (including configured hidden/gitignored folders)
- fast reloads via local metadata cache + HTTP image caching

## Current Status
- Standalone repo created and synced from monorepo work.
- Monorepo copy was removed (`meridian-collab/remote-workspace` deleted).
- `pnpm install` + `pnpm build` succeed in standalone repo.
- Global CLI link currently exists: `remote-workspace` -> this local repo.

## Key Behaviors Implemented
- Node launcher (`src/launcher.ts`) is the entrypoint.
- Tailscale `serve` default behavior.
- `--no-serve` local-only mode.
- `--funnel` supported and requires password auth.
- `--password [pwd]` supports inline or non-inline enablement.
- `--image-dirs <csv>` allows explicit hidden/gitignored image folders (default `.clipboard`).
- Basic Auth middleware in server with:
  - constant-time password comparison
  - auth-failure rate limiting / temporary block
  - same-origin check for mutating methods (`POST`/`DELETE` etc.)
- Delete endpoints:
  - `DELETE /api/clipboard/file?name=...`
- Files tab can render a folder-level image gallery for directories (non-clipboard images are viewed via `/api/file`).
- Hidden/gitignored folders listed in `REMOTE_WS_IMAGE_DIRS` remain visible in file listing and file reads.
- Caching:
  - server cache headers + validators for image endpoints
  - client stale-while-refresh metadata cache for list/tree/search

## Password/Config Precedence
Implemented in launcher + documented in README.

Password value precedence:
1. `--password <pwd>`
2. `REMOTE_WS_PASSWORD`
3. selected config file `REMOTE_WS_PASSWORD=...`

Config file selection precedence:
1. `--config <path>`
2. `REMOTE_WS_CONFIG_FILE`
3. `<repo-root>/.remote-workspace.conf`
4. user config (`$XDG_CONFIG_HOME/...`, `$APPDATA/...`, `~/.config/...`)

## Important Files
- `src/launcher.ts` (CLI/flags, tailscale orchestration, config resolution)
- `src/server.ts` (API, auth middleware, rate limit/origin checks, image-dir visibility rules)
- `static/app.js` (UI behavior, folder image gallery, local cache behavior)
- `README.md` (usage + security notes)

## Known Follow-ups
1. Help text still uses `pnpm dev ...` phrasing in launcher examples.
   - Optional: switch examples to `remote-workspace ...` now that bin exists.
2. Package is not publish-ready yet:
   - `package.json` still has `"private": true`.
   - Add publish packaging fields (`files`, optional `prepack`) when ready.
3. Repo is fresh/uncommitted.
   - `git status` currently all files untracked.

## Suggested Next Steps (in this repo)
1. Create first commit snapshot.
2. Decide publish plan (private/internal vs npm publish).
3. If publishing:
   - set package visibility/name/version strategy
   - remove `private`
   - verify `bin` + install path + `npx` UX
4. Optional polish:
   - update launcher help examples to command-name-first style.

## Quick Commands
```bash
cd ~/gitrepos/remote-workspace
pnpm install
pnpm build
pnpm dev -- --help

# Typical usage
pnpm dev -- --password --serve
pnpm dev -- --password --funnel
```
