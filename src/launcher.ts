#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

type ParsedArgs = {
  repoRoot: string;
  port: number;
  skipInstall: boolean;
  forceInstall: boolean;
  serveEnabled: boolean;
  serveModeSet: boolean;
  funnelEnabled: boolean;
  passwordEnabled: boolean;
  workspacePassword: string;
  configFile: string;
  alwaysHidden: string | null;
  imageDirs: string | null;
};

const currentFilePath = fileURLToPath(import.meta.url);
const currentDirectoryPath = path.dirname(currentFilePath);
const appDir = path.resolve(currentDirectoryPath, "..");
const builtServerPath = path.resolve(currentDirectoryPath, "server.js");

function printUsage(): void {
  console.log(`Usage: pnpm dev -- [options]

Options:
  --repo-root <path> Repository root to expose (default: REPO_ROOT or cwd)
  --config <path>    Config file path (default uses precedence search)
  --port <port>      Listen port (default: REMOTE_WS_PORT or 18080)
  --always-hidden <csv> Extra always-hidden path segments (comma-separated)
  --image-dirs <csv> Visible image folders (repo-relative, comma-separated)
  --install          Force dependency install before start
  --skip-install     Skip install check even if node_modules is missing
  --no-serve         Skip tailscale serve setup
  --funnel           Enable tailscale funnel (public internet)
  --password [pwd]   Enable Basic Auth (optional inline password)
  --serve            Force tailscale serve setup
  -h, --help         Show this help text

Examples:
  pnpm dev
  pnpm dev -- --repo-root /path/to/repo
  pnpm dev -- --config ~/.config/remote-workspace/config
  pnpm dev -- --port 18111
  pnpm dev -- --always-hidden .git,.env,.secrets
  pnpm dev -- --image-dirs .clipboard,.playwright-mcp
  pnpm dev -- --password
  pnpm dev -- --password mypass --serve
  pnpm dev -- --password mypass --funnel
  REMOTE_WS_PASSWORD=mypass pnpm dev -- --password
`);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function parsePort(rawPort: string): number {
  if (!/^\d+$/.test(rawPort)) {
    fail(`Invalid --port value: ${rawPort} (must be numeric).`);
  }
  const value = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    fail(`Invalid --port value: ${rawPort} (must be 1-65535).`);
  }
  return value;
}

function parseAlwaysHiddenCsv(rawValue: string, sourceLabel: string): string {
  const segments = rawValue
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (segments.length === 0) {
    fail(`Invalid ${sourceLabel} value: provide at least one segment.`);
  }

  const normalizedSegments = new Set<string>();
  for (const segment of segments) {
    if (segment.includes("/") || segment.includes("\\") || segment.includes("\u0000")) {
      fail(
        `Invalid ${sourceLabel} segment "${segment}": segments must not contain path separators or null bytes.`,
      );
    }
    normalizedSegments.add(segment);
  }

  return Array.from(normalizedSegments).join(",");
}

function normalizeRepoRelativePath(rawValue: string, sourceLabel: string): string {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.includes("\u0000")) {
    fail(`Invalid ${sourceLabel} path "${rawValue}": path must not contain null bytes.`);
  }

  const normalized = path.posix.normalize(trimmed.replaceAll("\\", "/")).replace(/^\.\//, "");
  if (!normalized || normalized === ".") {
    return "";
  }
  if (normalized === ".." || normalized.startsWith("../")) {
    fail(`Invalid ${sourceLabel} path "${rawValue}": path must stay inside repository.`);
  }
  if (path.posix.isAbsolute(normalized)) {
    fail(`Invalid ${sourceLabel} path "${rawValue}": path must be repo-relative.`);
  }
  if (normalized.split("/").includes(".git")) {
    fail(`Invalid ${sourceLabel} path "${rawValue}": .git cannot be exposed.`);
  }
  return normalized;
}

function parseImageDirsCsv(rawValue: string, sourceLabel: string): string {
  const normalizedPaths = new Set<string>();
  for (const rawPath of rawValue.split(",")) {
    const normalizedPath = normalizeRepoRelativePath(rawPath, sourceLabel);
    if (!normalizedPath) {
      continue;
    }
    normalizedPaths.add(normalizedPath);
  }
  if (normalizedPaths.size === 0) {
    fail(`Invalid ${sourceLabel} value: provide at least one repo-relative path.`);
  }
  return Array.from(normalizedPaths).join(",");
}

function parseConfigPassword(configFilePath: string): string {
  if (!existsSync(configFilePath)) {
    return "";
  }

  const content = readFileSync(configFilePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) {
      continue;
    }
    const match = line.match(/^\s*REMOTE_WS_PASSWORD\s*=(.*)$/);
    if (!match) {
      continue;
    }
    let value = match[1].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return "";
}

function resolveUserConfigPath(): string {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  if (xdgConfigHome) {
    return path.resolve(xdgConfigHome, "remote-workspace", "config");
  }

  const appData = process.env.APPDATA;
  if (appData) {
    return path.resolve(appData, "remote-workspace", "config");
  }

  const home =
    process.env.HOME ??
    process.env.USERPROFILE ??
    (process.env.HOMEDRIVE && process.env.HOMEPATH
      ? `${process.env.HOMEDRIVE}${process.env.HOMEPATH}`
      : undefined);
  if (!home) {
    return "";
  }
  return path.resolve(home, ".config", "remote-workspace", "config");
}

function parseArgs(argv: string[]): ParsedArgs {
  let repoRoot = path.resolve(process.env.REPO_ROOT ?? process.cwd());
  let port = parsePort(process.env.REMOTE_WS_PORT ?? "18080");
  let skipInstall = false;
  let forceInstall = false;
  let serveEnabled = true;
  let serveModeSet = false;
  let funnelEnabled = false;
  let passwordEnabled = false;
  let workspacePassword = "";
  let configFileFromArg: string | null = null;
  let configFile = "";
  let alwaysHidden: string | null = null;
  let imageDirs: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--repo-root": {
        const next = argv[i + 1];
        if (!next || next.startsWith("--")) {
          fail("Missing value for --repo-root.");
        }
        repoRoot = path.resolve(next);
        i += 1;
        break;
      }
      case "--config": {
        const next = argv[i + 1];
        if (!next || next.startsWith("--")) {
          fail("Missing value for --config.");
        }
        configFileFromArg = path.resolve(next);
        i += 1;
        break;
      }
      case "--port": {
        const next = argv[i + 1];
        if (!next || next.startsWith("--")) {
          fail("Missing value for --port.");
        }
        port = parsePort(next);
        i += 1;
        break;
      }
      case "--always-hidden": {
        const next = argv[i + 1];
        if (!next || next.startsWith("--")) {
          fail("Missing value for --always-hidden.");
        }
        alwaysHidden = parseAlwaysHiddenCsv(next, "--always-hidden");
        i += 1;
        break;
      }
      case "--image-dirs": {
        const next = argv[i + 1];
        if (!next || next.startsWith("--")) {
          fail("Missing value for --image-dirs.");
        }
        imageDirs = parseImageDirsCsv(next, "--image-dirs");
        i += 1;
        break;
      }
      case "--install":
        forceInstall = true;
        break;
      case "--skip-install":
        skipInstall = true;
        break;
      case "--no-serve":
        serveEnabled = false;
        funnelEnabled = false;
        serveModeSet = true;
        break;
      case "--funnel":
        serveEnabled = true;
        funnelEnabled = true;
        serveModeSet = true;
        break;
      case "--password": {
        passwordEnabled = true;
        const maybeValue = argv[i + 1];
        if (maybeValue && !maybeValue.startsWith("--")) {
          workspacePassword = maybeValue;
          i += 1;
        }
        break;
      }
      case "--serve":
        serveEnabled = true;
        funnelEnabled = false;
        serveModeSet = true;
        break;
      case "-h":
      case "--help":
        printUsage();
        process.exit(0);
      default:
        fail(`Unknown argument: ${arg}`);
    }
  }

  if (!existsSync(repoRoot)) {
    fail(`Repository root does not exist: ${repoRoot}`);
  }
  const projectConfigFile = path.resolve(repoRoot, ".remote-workspace.conf");
  const userConfigFile = resolveUserConfigPath();

  if (configFileFromArg) {
    if (!existsSync(configFileFromArg)) {
      fail(`Config file does not exist: ${configFileFromArg}`);
    }
    configFile = configFileFromArg;
  } else if (process.env.REMOTE_WS_CONFIG_FILE) {
    const envConfigFile = path.resolve(process.env.REMOTE_WS_CONFIG_FILE);
    if (!existsSync(envConfigFile)) {
      fail(`Config file from REMOTE_WS_CONFIG_FILE does not exist: ${envConfigFile}`);
    }
    configFile = envConfigFile;
  } else if (existsSync(projectConfigFile)) {
    configFile = projectConfigFile;
  } else if (userConfigFile && existsSync(userConfigFile)) {
    configFile = userConfigFile;
  } else {
    // No discovered config file. Keep the conventional project path for messages.
    configFile = projectConfigFile;
  }

  const configPassword = parseConfigPassword(configFile);
  if (!workspacePassword) {
    workspacePassword =
      process.env.REMOTE_WS_PASSWORD ?? configPassword;
  }

  // Backward compatibility: explicit env password enables auth without flag.
  if (!passwordEnabled && Boolean(process.env.REMOTE_WS_PASSWORD)) {
    passwordEnabled = true;
  }

  if (passwordEnabled && !workspacePassword) {
    fail(
      `--password was provided but no password value is available.\nSet REMOTE_WS_PASSWORD, pass --password <pwd>, or create ${configFile} with REMOTE_WS_PASSWORD=...`,
    );
  }

  if (!passwordEnabled) {
    workspacePassword = "";
  }

  if (funnelEnabled && !passwordEnabled) {
    fail(
      `--funnel requires password auth.\nPass --password (or set REMOTE_WS_PASSWORD / ${configFile}).`,
    );
  }

  if (!serveModeSet && passwordEnabled) {
    serveEnabled = false;
    console.warn(
      "Warning: password auth is enabled and no serve mode was selected.\nDefaulting to local-only mode (--no-serve).\nTo expose through Tailscale, restart with --serve.",
    );
  }

  return {
    repoRoot,
    port,
    skipInstall,
    forceInstall,
    serveEnabled,
    serveModeSet,
    funnelEnabled,
    passwordEnabled,
    workspacePassword,
    configFile,
    alwaysHidden,
    imageDirs,
  };
}

function hasCommand(commandName: string): boolean {
  const locator = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(locator, [commandName], { stdio: "ignore" });
  return result.status === 0;
}

function runSyncOrFail(commandName: string, args: string[], message: string): void {
  const result = spawnSync(commandName, args, { stdio: "inherit" });
  if (result.error) {
    fail(`${message}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(message);
  }
}

function runSync(commandName: string, args: string[]): void {
  spawnSync(commandName, args, { stdio: "inherit" });
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const runBuiltServer = existsSync(builtServerPath);

  if (args.serveEnabled) {
    if (!hasCommand("tailscale")) {
      fail(
        "tailscale is not installed, but serve mode is enabled.\nUse local-only mode with --no-serve (or --password <pwd>).\nOr install Tailscale, run 'tailscale up', then restart with --serve.",
      );
    }
    runSyncOrFail(
      "tailscale",
      ["status"],
      "tailscale is installed but not connected.\nRun 'tailscale up' and retry --serve, or use local-only mode with --no-serve.",
    );
  }

  if (!runBuiltServer) {
    if (!hasCommand("pnpm")) {
      fail("pnpm is required but not installed.");
    }
    if (!existsSync(path.join(appDir, "package.json"))) {
      fail(`remote-workspace app not found at: ${appDir}`);
    }
    if (args.forceInstall) {
      runSyncOrFail("pnpm", ["--dir", appDir, "install"], "Dependency install failed.");
    } else if (!args.skipInstall && !existsSync(path.join(appDir, "node_modules"))) {
      runSyncOrFail("pnpm", ["--dir", appDir, "install"], "Dependency install failed.");
    }
  }

  if (args.serveEnabled) {
    console.log(`Configuring tailscale serve (https:443 -> 127.0.0.1:${args.port})`);
    runSyncOrFail(
      "tailscale",
      ["serve", "--bg", "--https=443", `127.0.0.1:${args.port}`],
      "tailscale serve setup failed.",
    );
    if (args.funnelEnabled) {
      console.log("Enabling tailscale funnel (public internet exposure)");
      runSyncOrFail("tailscale", ["funnel", "--bg", "on"], "tailscale funnel setup failed.");
      runSync("tailscale", ["funnel", "status"]);
    } else {
      runSync("tailscale", ["serve", "status"]);
    }
  } else {
    console.log("Skipping tailscale serve (--no-serve).");
  }

  console.log(`Starting remote-workspace on http://127.0.0.1:${args.port}`);
  console.log(`Repo root: ${args.repoRoot}`);
  if (args.passwordEnabled) {
    console.log("Auth: Basic Auth enabled");
  }
  if (args.alwaysHidden !== null) {
    console.log(`Always hidden segments: .git + ${args.alwaysHidden}`);
  } else if (process.env.REMOTE_WS_ALWAYS_HIDDEN) {
    console.log(`Always hidden segments: .git + ${process.env.REMOTE_WS_ALWAYS_HIDDEN}`);
  } else {
    console.log("Always hidden segments: .git");
  }
  if (args.imageDirs !== null) {
    console.log(`Visible image folders: ${args.imageDirs}`);
  } else if (process.env.REMOTE_WS_IMAGE_DIRS) {
    console.log(`Visible image folders: ${process.env.REMOTE_WS_IMAGE_DIRS}`);
  } else {
    console.log("Visible image folders: .clipboard");
  }
  console.log("");

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    REPO_ROOT: args.repoRoot,
    REMOTE_WS_PORT: String(args.port),
    REMOTE_WS_PASSWORD: args.workspacePassword,
  };
  if (args.alwaysHidden !== null) {
    childEnv.REMOTE_WS_ALWAYS_HIDDEN = args.alwaysHidden;
  }
  if (args.imageDirs !== null) {
    childEnv.REMOTE_WS_IMAGE_DIRS = args.imageDirs;
  }

  const child = runBuiltServer
    ? spawn(
        "node",
        [builtServerPath],
        {
          stdio: "inherit",
          env: childEnv,
        },
      )
    : spawn(
        "pnpm",
        ["--dir", appDir, "dev:server"],
        {
          stdio: "inherit",
          env: childEnv,
        },
      );

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}

main();
