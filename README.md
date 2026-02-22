# Remote Workspace

Mobile-friendly read/upload web workspace for this repository.

## Features

- Browse repository folders/files
- Upload images into `.clipboard/` at repo root (single image per upload)
- Delete images from `.clipboard/` and `.playwright-mcp/` from the UI
- Preview text files and images
- Render Markdown with Mermaid diagrams
- Hide and block access to dotfiles/dot-directories (for example `.env`, `.git`)
- Dedicated collapsible `.clipboard` panel for upload + quick image viewing

This app is intentionally **no text editing** to keep remote access simple and lower risk.
Image operations are limited to upload/delete with strict filename validation.

## Start

From repo root:

```bash
pnpm dev
```

By default it serves on `127.0.0.1:18080`.

The Node launcher configures Tailscale Serve (tailnet-only) by default before starting.

Disable Serve mode (local-only):

```bash
pnpm dev -- no-serve
```

Enable Funnel mode (public internet):

```bash
pnpm dev -- password your-password --funnel
```

Enable Basic Auth:

```bash
pnpm dev -- password your-password
# or
REMOTE_WS_PASSWORD=your-password pnpm dev -- password
```

When a password is set and serve mode is not explicitly chosen, the launcher defaults to local-only (`--no-serve`). Add `--serve` if you want password-protected remote access through Tailscale.
`--funnel` requires password auth and exposes the workspace publicly.
When this auto-switch happens, the launcher prints a warning with the exact `--serve` override.

Copy/paste startup command:

```bash
cd /path/to/your/repo && pnpm dev
```

## Options

```bash
pnpm dev -- config /path/to/config
pnpm dev -- port 18111
pnpm dev -- install
pnpm dev -- no-serve
pnpm dev -- password your-password
pnpm dev -- password your-password --serve
pnpm dev -- password your-password --funnel
```

## Environment

- `REMOTE_WS_PORT` (default `18080`)
- `REMOTE_WS_MAX_PREVIEW_BYTES` (default `1048576`)
- `REMOTE_WS_MAX_UPLOAD_BYTES` (default `26214400`)
- `REMOTE_WS_PASSWORD` (optional, enables HTTP Basic Auth when set)
- `REMOTE_WS_CONFIG_FILE` (optional config file path override)
- `REPO_ROOT` (injected by launcher script)

Password config file format (default: repo root `.remote-workspace.conf`):

```bash
REMOTE_WS_PASSWORD=your-password
```

Password/config precedence:

1. CLI inline password (`--password <pwd>`)
2. Env password (`REMOTE_WS_PASSWORD`)
3. Selected config file value (`REMOTE_WS_PASSWORD=...`)

Config file selection precedence:

1. CLI config path (`--config <path>`)
2. Env config path (`REMOTE_WS_CONFIG_FILE`)
3. Project config (`<repo-root>/.remote-workspace.conf`)
4. User config (`$XDG_CONFIG_HOME/remote-workspace/config`, then `$APPDATA/remote-workspace/config`, then `~/.config/remote-workspace/config`)

## Upload Clipboard

- `POST /api/clipboard/upload` always writes to `REPO_ROOT/.clipboard`
- `DELETE /api/clipboard/file?name=<filename>` deletes one image in `REPO_ROOT/.clipboard`
- `.clipboard` panel uses dedicated clipboard endpoints (`/api/clipboard/upload`, `/api/clipboard/list`, `/api/clipboard/file`)
- Main repository browser still blocks all hidden paths and gitignored paths
- Gitignored paths are hidden/blocked (for example `node_modules/`, build artifacts, local secrets)
- Accepted upload types are images only (`png`, `jpg`, `jpeg`, `gif`, `webp`, `svg`, `bmp`, `heic`, `heif`, `avif`)
- Clipboard panel supports both file picker and `Paste From Clipboard` button (when browser clipboard image API is available)
- Upload requires `name` query parameter (filename is user-controlled)
- Filename rules: no spaces, no leading dot, `[A-Za-z0-9._-]` only, and must use an allowed image extension
- Multipart field names accepted: `file` (current UI) and `files` (legacy cached UI compatibility)
- Legacy alias: `/api/upload` is still accepted for older cached clients

## Screenshots

- `GET /api/screenshots/list` lists images in `REPO_ROOT/.playwright-mcp`
- `GET /api/screenshots/file?name=<filename>` streams one screenshot image
- `DELETE /api/screenshots/file?name=<filename>` deletes one screenshot image

## Caching

- The browser now caches image bytes (`/api/clipboard/file`, `/api/screenshots/file`, image responses from `/api/file`) with short-lived cache headers and validators.
- The client keeps a small local metadata cache (tree + clipboard/screenshot lists) and hydrates immediately on reload, then refreshes in the background.
- Refresh buttons bypass local metadata cache and force a new server fetch.

## Tailscale

Tailscale Serve is enabled by default and stays private to your tailnet.
Use `--no-serve` if you want local-only mode.
Use `--funnel` to publish via Tailscale Funnel (password required).
If Tailscale is missing or disconnected while serve mode is enabled, the launcher exits with guidance to either switch to local-only mode or run `tailscale up` and retry `--serve`.

```bash
# Tailnet-only URL
pnpm dev
```

Manual commands (equivalent):

```bash
tailscale serve --bg --https=443 127.0.0.1:18080
```

## Auth

When `REMOTE_WS_PASSWORD` is set (or `--password` is passed to the launcher), the app requires HTTP Basic Auth for all routes (UI + API).
When auth is enabled, mutating routes (`POST`/`DELETE`) also require same-origin `Origin`/`Referer` headers.
