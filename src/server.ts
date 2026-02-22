import express from "express";
import multer from "multer";
import { createReadStream, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { lookup as mimeLookup } from "mime-types";

function parseIntegerFromEnv(
  envName: string,
  fallbackValue: number,
  options: { min: number; max?: number },
): number {
  const rawValue = process.env[envName];
  const parsedValue = Number.parseInt(rawValue ?? String(fallbackValue), 10);
  if (!Number.isInteger(parsedValue)) {
    throw new Error(`Invalid ${envName}: expected integer`);
  }
  if (parsedValue < options.min) {
    throw new Error(`Invalid ${envName}: must be >= ${options.min}`);
  }
  if (options.max !== undefined && parsedValue > options.max) {
    throw new Error(`Invalid ${envName}: must be <= ${options.max}`);
  }
  return parsedValue;
}

const REPO_ROOT = path.resolve(process.env.REPO_ROOT ?? process.cwd());
const HOST = "127.0.0.1";
const PORT = parseIntegerFromEnv("REMOTE_WS_PORT", 18080, { min: 1, max: 65535 });
const MAX_PREVIEW_BYTES = parseIntegerFromEnv("REMOTE_WS_MAX_PREVIEW_BYTES", 1_048_576, {
  min: 1,
});
const MAX_UPLOAD_BYTES = parseIntegerFromEnv("REMOTE_WS_MAX_UPLOAD_BYTES", 26_214_400, {
  min: 1,
});
const MAX_TREE_ENTRIES = parseIntegerFromEnv("REMOTE_WS_MAX_TREE_ENTRIES", 5000, {
  min: 1,
});
const CLIPBOARD_DIRECTORY_NAME = ".clipboard";
const CLIPBOARD_DIRECTORY_PATH = path.resolve(REPO_ROOT, CLIPBOARD_DIRECTORY_NAME);
const SCREENSHOTS_DIRECTORY_NAME = ".playwright-mcp";
const SCREENSHOTS_DIRECTORY_PATH = path.resolve(REPO_ROOT, SCREENSHOTS_DIRECTORY_NAME);
const ALLOWED_IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".bmp",
  ".heic",
  ".heif",
  ".avif",
]);
const IMAGE_CACHE_CONTROL = "private, max-age=60, stale-while-revalidate=300";
const METADATA_CACHE_CONTROL = "private, max-age=10, stale-while-revalidate=30";
const BASIC_AUTH_PASSWORD = process.env.REMOTE_WS_PASSWORD ?? "";
const AUTH_WINDOW_MS = 10 * 60 * 1000;
const AUTH_MAX_ATTEMPTS = 20;
const AUTH_BLOCK_MS = 15 * 60 * 1000;

type Entry = {
  name: string;
  path: string;
  type: "file" | "directory";
  size: number;
  modifiedAt: string;
};

const app = express();
const authFailureByIP = new Map<
  string,
  { windowStartAt: number; failures: number; blockedUntil: number }
>();

function parseBasicAuthPassword(req: express.Request): string | null {
  const authHeader = req.header("authorization");
  if (!authHeader) {
    return null;
  }
  if (!authHeader.startsWith("Basic ")) {
    return null;
  }

  const encoded = authHeader.slice("Basic ".length).trim();
  if (!encoded) {
    return null;
  }

  let decoded: string;
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    return null;
  }

  const separatorIndex = decoded.indexOf(":");
  if (separatorIndex < 0) {
    return null;
  }
  return decoded.slice(separatorIndex + 1);
}

function constantTimePasswordMatch(actualPassword: string, expectedPassword: string): boolean {
  const actual = Buffer.from(actualPassword, "utf8");
  const expected = Buffer.from(expectedPassword, "utf8");
  if (actual.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(actual, expected);
}

function clientIPAddress(req: express.Request): string {
  const forwardedFor = req.header("x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) {
      return first;
    }
  }
  return req.ip || req.socket.remoteAddress || "unknown";
}

function normalizeAuthority(authorityUrl: URL): string {
  const protocolPort = authorityUrl.protocol === "https:" ? "443" : "80";
  const port = authorityUrl.port || protocolPort;
  return `${authorityUrl.hostname.toLowerCase()}:${port}`;
}

function normalizeRequestAuthority(req: express.Request): string | null {
  const hostHeader = req.header("x-forwarded-host") ?? req.header("host");
  if (!hostHeader) {
    return null;
  }

  const protocolHeader = req.header("x-forwarded-proto") ?? req.protocol ?? "http";
  const protocol =
    protocolHeader.toLowerCase().startsWith("https") ? "https" : "http";
  try {
    return normalizeAuthority(new URL(`${protocol}://${hostHeader}`));
  } catch {
    return null;
  }
}

function isSameOriginMutation(req: express.Request): boolean {
  const requestAuthority = normalizeRequestAuthority(req);
  if (!requestAuthority) {
    return false;
  }

  const originHeader = req.header("origin");
  if (originHeader) {
    try {
      const originAuthority = normalizeAuthority(new URL(originHeader));
      return originAuthority === requestAuthority;
    } catch {
      return false;
    }
  }

  const refererHeader = req.header("referer");
  if (refererHeader) {
    try {
      const refererAuthority = normalizeAuthority(new URL(refererHeader));
      return refererAuthority === requestAuthority;
    } catch {
      return false;
    }
  }

  return false;
}

function recordAuthFailure(req: express.Request): { blockedUntil?: number } {
  const now = Date.now();
  const ip = clientIPAddress(req);
  const existing = authFailureByIP.get(ip);
  if (!existing || now - existing.windowStartAt >= AUTH_WINDOW_MS) {
    const first = { windowStartAt: now, failures: 1, blockedUntil: 0 };
    authFailureByIP.set(ip, first);
    return {};
  }

  existing.failures += 1;
  if (existing.failures >= AUTH_MAX_ATTEMPTS) {
    existing.blockedUntil = now + AUTH_BLOCK_MS;
    existing.failures = 0;
    existing.windowStartAt = now;
    return { blockedUntil: existing.blockedUntil };
  }
  return {};
}

if (BASIC_AUTH_PASSWORD.length > 0) {
  app.use((req, res, next) => {
    const now = Date.now();
    const ip = clientIPAddress(req);
    const existing = authFailureByIP.get(ip);
    if (existing?.blockedUntil && existing.blockedUntil > now) {
      const retryAfterSeconds = Math.ceil((existing.blockedUntil - now) / 1000);
      res.setHeader("Retry-After", String(retryAfterSeconds));
      res.status(429).send("Too many authentication failures");
      return;
    }

    const suppliedPassword = parseBasicAuthPassword(req);
    if (
      suppliedPassword !== null &&
      constantTimePasswordMatch(suppliedPassword, BASIC_AUTH_PASSWORD)
    ) {
      authFailureByIP.delete(ip);
      if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH" || req.method === "DELETE") {
        if (!isSameOriginMutation(req)) {
          res.status(403).send("Origin validation failed");
          return;
        }
      }
      next();
      return;
    }

    const failure = recordAuthFailure(req);
    if (failure.blockedUntil) {
      const retryAfterSeconds = Math.ceil((failure.blockedUntil - Date.now()) / 1000);
      res.setHeader("Retry-After", String(retryAfterSeconds));
      res.status(429).send("Too many authentication failures");
      return;
    }

    res.setHeader(
      "WWW-Authenticate",
      'Basic realm="remote-workspace", charset="UTF-8"',
    );
    res.status(401).send("Authentication required");
  });
}

app.use(express.json({ limit: "256kb" }));
const execFileAsync = promisify(execFile);

function getSingleQueryValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === "string") {
    return value[0];
  }
  return undefined;
}

function toRepoRelativePath(absPath: string): string {
  const relative = path.relative(REPO_ROOT, absPath);
  if (!relative) {
    return "";
  }
  return relative.split(path.sep).join("/");
}

function isHiddenRepoRelativePath(repoRelativePath: string): boolean {
  if (!repoRelativePath) {
    return false;
  }
  return repoRelativePath.split("/").some((segment) => segment.startsWith("."));
}

function isBlockedHiddenRepoRelativePath(repoRelativePath: string): boolean {
  return isHiddenRepoRelativePath(repoRelativePath);
}

function parseGitIgnoredStdout(stdout: string | Buffer | undefined): Set<string> {
  if (!stdout) {
    return new Set();
  }
  return new Set(
    String(stdout)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

async function getGitIgnoredPathSet(repoRelativePaths: string[]): Promise<Set<string>> {
  const normalizedPaths = Array.from(new Set(repoRelativePaths.filter(Boolean)));
  if (normalizedPaths.length === 0) {
    return new Set();
  }

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", REPO_ROOT, "check-ignore", "--", ...normalizedPaths],
      { maxBuffer: 1024 * 1024 },
    );
    return parseGitIgnoredStdout(stdout);
  } catch (error) {
    const gitError = error as NodeJS.ErrnoException & { stdout?: string | Buffer };
    return parseGitIgnoredStdout(gitError.stdout);
  }
}

async function assertPathAccessible(
  absPath: string,
  options?: { allowHidden?: boolean; allowGitIgnored?: boolean },
): Promise<void> {
  const repoRelativePath = toRepoRelativePath(absPath);

  if (!options?.allowHidden && isBlockedHiddenRepoRelativePath(repoRelativePath)) {
    throw new Error("Hidden paths are not accessible");
  }
  if (!options?.allowGitIgnored && repoRelativePath) {
    const ignoredPathSet = await getGitIgnoredPathSet([repoRelativePath]);
    if (ignoredPathSet.has(repoRelativePath)) {
      throw new Error("Gitignored paths are not accessible");
    }
  }
}

function isWithinRepo(absPath: string): boolean {
  const relative = path.relative(REPO_ROOT, absPath);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function resolveRepoPath(relativePath: string | undefined): string {
  const input = (relativePath ?? "").trim();
  if (input.includes("\u0000")) {
    throw new Error("Path contains null byte");
  }

  const resolved = path.resolve(REPO_ROOT, input);
  if (!isWithinRepo(resolved)) {
    throw new Error("Path escapes repository root");
  }
  return resolved;
}

function sanitizeUploadFilename(originalName: string): string {
  const stripped = path.basename(originalName).replace(/[\u0000-\u001f]/g, "");
  const cleaned = stripped.trim();
  if (!cleaned || cleaned === "." || cleaned === "..") {
    return `upload-${Date.now()}`;
  }
  return cleaned;
}

function validateUploadFilename(fileName: string): string | null {
  if (!fileName) {
    return "Filename is required";
  }
  if (/\s/.test(fileName)) {
    return "Filename cannot contain spaces";
  }
  if (fileName === "." || fileName === ".." || fileName.startsWith(".")) {
    return "Filename is invalid";
  }
  if (!/^[A-Za-z0-9._-]+$/.test(fileName)) {
    return "Filename may only contain letters, numbers, dot, underscore, and dash";
  }
  const extension = path.extname(fileName).toLowerCase();
  if (!extension || !ALLOWED_IMAGE_EXTENSIONS.has(extension)) {
    return "Filename must use an allowed image extension";
  }
  return null;
}

function isLikelyBinary(buffer: Buffer): boolean {
  for (const byte of buffer) {
    if (byte === 0) {
      return true;
    }
  }
  return false;
}

function setMetadataCacheHeaders(res: express.Response): void {
  res.setHeader("Cache-Control", METADATA_CACHE_CONTROL);
}

function buildWeakETag(stats: { size: number; mtimeMs: number }): string {
  return `W/"${stats.size}-${Math.floor(stats.mtimeMs)}"`;
}

function shouldRespondNotModified(
  req: express.Request,
  etag: string,
  lastModifiedMillis: number,
): boolean {
  const ifNoneMatch = req.header("if-none-match");
  if (ifNoneMatch) {
    const candidates = ifNoneMatch.split(",").map((value) => value.trim());
    if (candidates.includes("*") || candidates.includes(etag)) {
      return true;
    }
  }

  const ifModifiedSince = req.header("if-modified-since");
  if (ifModifiedSince) {
    const since = Date.parse(ifModifiedSince);
    const lastModifiedSeconds = Math.floor(lastModifiedMillis / 1000) * 1000;
    if (!Number.isNaN(since) && since >= lastModifiedSeconds) {
      return true;
    }
  }
  return false;
}

function setImageCacheHeaders(
  req: express.Request,
  res: express.Response,
  stats: { size: number; mtimeMs: number },
): boolean {
  const etag = buildWeakETag(stats);
  res.setHeader("Cache-Control", IMAGE_CACHE_CONTROL);
  res.setHeader("ETag", etag);
  res.setHeader("Last-Modified", new Date(stats.mtimeMs).toUTCString());
  if (shouldRespondNotModified(req, etag, stats.mtimeMs)) {
    res.status(304).end();
    return true;
  }
  return false;
}

function resolveNamedImagePath(
  baseDirectoryPath: string,
  requestedName: string,
): { path: string; name: string } {
  const safeName = sanitizeUploadFilename(requestedName);
  const validationError = validateUploadFilename(safeName);
  if (validationError) {
    throw new Error(validationError);
  }

  const absoluteDirectoryPath = path.resolve(baseDirectoryPath);
  const absolutePath = path.resolve(absoluteDirectoryPath, safeName);
  const relativeToDirectory = path.relative(absoluteDirectoryPath, absolutePath);
  if (relativeToDirectory.startsWith("..") || path.isAbsolute(relativeToDirectory)) {
    throw new Error("Path escapes target directory");
  }

  return { path: absolutePath, name: safeName };
}

async function ensureDirectory(
  absPath: string,
  options?: { allowHidden?: boolean; allowGitIgnored?: boolean },
): Promise<void> {
  const stats = await fs.stat(absPath);
  if (!stats.isDirectory()) {
    throw new Error("Target path is not a directory");
  }
  const realPath = await fs.realpath(absPath);
  if (!isWithinRepo(realPath)) {
    throw new Error("Resolved path escapes repository root");
  }
  await assertPathAccessible(realPath, options);
}

async function ensureFile(
  absPath: string,
  options?: { allowHidden?: boolean; allowGitIgnored?: boolean },
): Promise<void> {
  const stats = await fs.stat(absPath);
  if (!stats.isFile()) {
    throw new Error("Target path is not a file");
  }
  const realPath = await fs.realpath(absPath);
  if (!isWithinRepo(realPath)) {
    throw new Error("Resolved path escapes repository root");
  }
  await assertPathAccessible(realPath, options);
}

const storage = multer.diskStorage({
  destination: async (req, _file, callback) => {
    try {
      await ensureClipboardDirectoryReady();
      (req as express.Request & { uploadDirectoryPath?: string }).uploadDirectoryPath =
        CLIPBOARD_DIRECTORY_PATH;
      callback(null, CLIPBOARD_DIRECTORY_PATH);
    } catch (error) {
      callback(error as Error, "");
    }
  },
  filename: (req, file, callback) => {
    const uploadDirectoryPath = (
      req as express.Request & { uploadDirectoryPath?: string }
    ).uploadDirectoryPath;
    if (!uploadDirectoryPath) {
      callback(new Error("Upload directory unavailable"), "");
      return;
    }

    const requestedName = getSingleQueryValue(req.query.name);
    if (!requestedName) {
      callback(new Error("Missing required query parameter: name"), "");
      return;
    }
    const sanitizedRequestedName = sanitizeUploadFilename(requestedName ?? "");
    const validationError = validateUploadFilename(sanitizedRequestedName);
    if (validationError) {
      callback(new Error(validationError), "");
      return;
    }

    const targetPath = path.join(uploadDirectoryPath, sanitizedRequestedName);
    if (existsSync(targetPath)) {
      callback(new Error("Filename already exists"), "");
      return;
    }

    callback(null, sanitizedRequestedName);
  },
});

const upload = multer({
  storage,
  limits: {
    files: 1,
    fileSize: MAX_UPLOAD_BYTES,
  },
  fileFilter: (_req, file, callback) => {
    const isImageMime = file.mimetype.startsWith("image/");
    const originalExtension = path.extname(file.originalname).toLowerCase();
    if (
      !isImageMime ||
      (originalExtension !== "" && !ALLOWED_IMAGE_EXTENSIONS.has(originalExtension))
    ) {
      callback(new Error("Only image uploads are allowed"));
      return;
    }
    callback(null, true);
  },
});
const clipboardUploadMiddleware = upload.fields([
  { name: "file", maxCount: 1 },
  { name: "files", maxCount: 1 },
]);

function handleClipboardUpload(req: express.Request, res: express.Response): void {
  const requestFiles = req.files as Record<string, Express.Multer.File[]> | undefined;
  const uploadedFile = requestFiles?.file?.[0] ?? requestFiles?.files?.[0];
  if (!uploadedFile) {
    res.status(400).json({ error: "Missing upload file" });
    return;
  }

  const uploaded = {
    name: uploadedFile.filename,
    path: toRepoRelativePath(uploadedFile.path),
    size: uploadedFile.size,
  };

  const uploadDirectoryPath = (
    req as express.Request & { uploadDirectoryPath?: string }
  ).uploadDirectoryPath;

  res.json({
    directory: uploadDirectoryPath ? toRepoRelativePath(uploadDirectoryPath) : "",
    uploaded: [uploaded],
  });
}

async function ensureClipboardDirectoryReady(): Promise<void> {
  await fs.mkdir(CLIPBOARD_DIRECTORY_PATH, { recursive: true });
  await ensureDirectory(CLIPBOARD_DIRECTORY_PATH, {
    allowHidden: true,
    allowGitIgnored: true,
  });
}

type TreeNode = {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: TreeNode[];
};

function buildTreeFromPaths(filePaths: string[]): TreeNode {
  const root: TreeNode = { name: "", path: "", type: "directory", children: [] };

  for (const filePath of filePaths) {
    const segments = filePath.split("/");
    let current = root;

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const isFile = i === segments.length - 1;
      const currentPath = segments.slice(0, i + 1).join("/");

      if (!current.children) {
        current.children = [];
      }

      let existing = current.children.find((c) => c.name === segment);
      if (!existing) {
        existing = {
          name: segment,
          path: currentPath,
          type: isFile ? "file" : "directory",
          ...(isFile ? {} : { children: [] }),
        };
        current.children.push(existing);
      } else if (!isFile && !existing.children) {
        // Was added as a file but now needs to be a directory (shouldn't happen, but safe)
        existing.type = "directory";
        existing.children = [];
      }

      if (!isFile) {
        current = existing;
      }
    }
  }

  return root;
}

function sortTree(node: TreeNode): void {
  if (!node.children) return;
  node.children.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });
  for (const child of node.children) {
    sortTree(child);
  }
}

app.get("/api/tree", async (_req, res) => {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", REPO_ROOT, "ls-files", "--cached", "--others", "--exclude-standard"],
      { maxBuffer: 10 * 1024 * 1024 },
    );

    const allPaths = String(stdout)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    // Filter hidden paths
    const visiblePaths = allPaths.filter((p) => !isHiddenRepoRelativePath(p));

    const truncated = visiblePaths.length > MAX_TREE_ENTRIES;
    const paths = truncated ? visiblePaths.slice(0, MAX_TREE_ENTRIES) : visiblePaths;

    const root = buildTreeFromPaths(paths);
    sortTree(root);

    setMetadataCacheHeaders(res);
    res.json({
      root,
      totalFiles: visiblePaths.length,
      truncated,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to build file tree";
    res.status(400).json({ error: message });
  }
});

app.get("/api/list", async (req, res) => {
  try {
    const requestedPath = getSingleQueryValue(req.query.path);
    const directoryPath = resolveRepoPath(requestedPath);
    await ensureDirectory(directoryPath);

    const dirEntries = await fs.readdir(directoryPath, { withFileTypes: true });
    const candidates: Array<{
      childPath: string;
      childRepoRelativePath: string;
      isDirectory: boolean;
      name: string;
    }> = [];
    const entries: Entry[] = [];
    let skippedSymlinks = 0;
    let skippedHidden = 0;
    let skippedIgnored = 0;

    for (const dirEntry of dirEntries) {
      if (dirEntry.isSymbolicLink()) {
        skippedSymlinks += 1;
        continue;
      }
      const childPath = path.join(directoryPath, dirEntry.name);
      const childRepoRelativePath = toRepoRelativePath(childPath);
      if (isBlockedHiddenRepoRelativePath(childRepoRelativePath)) {
        skippedHidden += 1;
        continue;
      }
      if (!dirEntry.isDirectory() && !dirEntry.isFile()) {
        continue;
      }

      candidates.push({
        childPath,
        childRepoRelativePath,
        isDirectory: dirEntry.isDirectory(),
        name: dirEntry.name,
      });
    }

    const ignoredPathSet = await getGitIgnoredPathSet(
      candidates.map((candidate) => candidate.childRepoRelativePath),
    );

    for (const candidate of candidates) {
      if (ignoredPathSet.has(candidate.childRepoRelativePath)) {
        skippedIgnored += 1;
        continue;
      }

      let childStats;
      try {
        childStats = await fs.stat(candidate.childPath);
      } catch {
        // The file may disappear between readdir and stat (race with external writers).
        continue;
      }

      entries.push({
        name: candidate.name,
        path: candidate.childRepoRelativePath,
        type: candidate.isDirectory ? "directory" : "file",
        size: childStats.size,
        modifiedAt: childStats.mtime.toISOString(),
      });
    }

    entries.sort((left, right) => {
      if (left.type !== right.type) {
        return left.type === "directory" ? -1 : 1;
      }
      return left.name.localeCompare(right.name, undefined, {
        numeric: true,
        sensitivity: "base",
      });
    });

    const currentPath = toRepoRelativePath(directoryPath);
    const parentPath = currentPath
      ? toRepoRelativePath(path.dirname(directoryPath))
      : null;

    setMetadataCacheHeaders(res);
    res.json({
      currentPath,
      parentPath,
      entries,
      skippedSymlinks,
      skippedHidden,
      skippedIgnored,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to list";
    res.status(400).json({ error: message });
  }
});

app.get("/api/clipboard/list", async (_req, res) => {
  try {
    await ensureClipboardDirectoryReady();
    const dirEntries = await fs.readdir(CLIPBOARD_DIRECTORY_PATH, {
      withFileTypes: true,
    });
    const entries: Entry[] = [];

    for (const dirEntry of dirEntries) {
      if (!dirEntry.isFile()) {
        continue;
      }
      const extension = path.extname(dirEntry.name).toLowerCase();
      if (!ALLOWED_IMAGE_EXTENSIONS.has(extension)) {
        continue;
      }

      const absPath = path.join(CLIPBOARD_DIRECTORY_PATH, dirEntry.name);
      let stats;
      try {
        stats = await fs.stat(absPath);
      } catch {
        continue;
      }

      entries.push({
        name: dirEntry.name,
        path: toRepoRelativePath(absPath),
        type: "file",
        size: stats.size,
        modifiedAt: stats.mtime.toISOString(),
      });
    }

    entries.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
    setMetadataCacheHeaders(res);
    res.json({
      directory: CLIPBOARD_DIRECTORY_NAME,
      entries,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to list clipboard";
    res.status(400).json({ error: message });
  }
});

app.get("/api/clipboard/file", async (req, res) => {
  try {
    const requestedName = getSingleQueryValue(req.query.name);
    if (!requestedName) {
      res.status(400).json({ error: "Missing ?name=..." });
      return;
    }

    await ensureClipboardDirectoryReady();
    const { path: absPath } = resolveNamedImagePath(
      CLIPBOARD_DIRECTORY_PATH,
      requestedName,
    );
    await ensureFile(absPath, { allowHidden: true, allowGitIgnored: true });
    const stats = await fs.stat(absPath);
    if (setImageCacheHeaders(req, res, stats)) {
      return;
    }

    const mimeType = mimeLookup(absPath) || "application/octet-stream";
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Length", String(stats.size));
    await pipeline(createReadStream(absPath), res);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to stream clipboard file";
    if (!res.headersSent) {
      res.status(400).json({ error: message });
      return;
    }
    res.destroy();
  }
});

app.delete("/api/clipboard/file", async (req, res) => {
  try {
    const requestedName = getSingleQueryValue(req.query.name);
    if (!requestedName) {
      res.status(400).json({ error: "Missing ?name=..." });
      return;
    }

    await ensureClipboardDirectoryReady();
    const { path: absPath } = resolveNamedImagePath(
      CLIPBOARD_DIRECTORY_PATH,
      requestedName,
    );
    await fs.unlink(absPath);
    res.setHeader("Cache-Control", "no-store");
    res.status(204).end();
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      res.status(404).json({ error: "File not found" });
      return;
    }
    const message =
      error instanceof Error ? error.message : "Unable to delete clipboard file";
    res.status(400).json({ error: message });
  }
});

app.get("/api/screenshots/list", async (_req, res) => {
  try {
    const dirEntries = await fs.readdir(SCREENSHOTS_DIRECTORY_PATH, {
      withFileTypes: true,
    }).catch(() => [] as never[]);

    const entries: Entry[] = [];
    for (const dirEntry of dirEntries) {
      if (!dirEntry.isFile()) continue;
      const extension = path.extname(dirEntry.name).toLowerCase();
      if (!ALLOWED_IMAGE_EXTENSIONS.has(extension)) continue;

      const absPath = path.join(SCREENSHOTS_DIRECTORY_PATH, dirEntry.name);
      let stats;
      try {
        stats = await fs.stat(absPath);
      } catch {
        continue;
      }

      entries.push({
        name: dirEntry.name,
        path: `${SCREENSHOTS_DIRECTORY_NAME}/${dirEntry.name}`,
        type: "file",
        size: stats.size,
        modifiedAt: stats.mtime.toISOString(),
      });
    }

    entries.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
    setMetadataCacheHeaders(res);
    res.json({
      directory: SCREENSHOTS_DIRECTORY_NAME,
      entries,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to list screenshots";
    res.status(400).json({ error: message });
  }
});

app.get("/api/screenshots/file", async (req, res) => {
  try {
    const requestedName = getSingleQueryValue(req.query.name);
    if (!requestedName) {
      res.status(400).json({ error: "Missing ?name=..." });
      return;
    }

    const { path: absPath } = resolveNamedImagePath(
      SCREENSHOTS_DIRECTORY_PATH,
      requestedName,
    );
    const stats = await fs.stat(absPath);
    if (!stats.isFile()) {
      res.status(400).json({ error: "Not a file" });
      return;
    }
    const realPath = await fs.realpath(absPath);
    const relativeToDirectory = path.relative(
      SCREENSHOTS_DIRECTORY_PATH,
      realPath,
    );
    if (
      relativeToDirectory.startsWith("..") ||
      path.isAbsolute(relativeToDirectory)
    ) {
      res.status(400).json({ error: "Path escapes target directory" });
      return;
    }
    if (setImageCacheHeaders(req, res, stats)) {
      return;
    }

    const mimeType = mimeLookup(absPath) || "application/octet-stream";
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Length", String(stats.size));
    await pipeline(createReadStream(absPath), res);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to stream screenshot";
    if (!res.headersSent) {
      res.status(400).json({ error: message });
      return;
    }
    res.destroy();
  }
});

app.delete("/api/screenshots/file", async (req, res) => {
  try {
    const requestedName = getSingleQueryValue(req.query.name);
    if (!requestedName) {
      res.status(400).json({ error: "Missing ?name=..." });
      return;
    }

    const { path: absPath } = resolveNamedImagePath(
      SCREENSHOTS_DIRECTORY_PATH,
      requestedName,
    );
    await fs.unlink(absPath);
    res.setHeader("Cache-Control", "no-store");
    res.status(204).end();
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      res.status(404).json({ error: "File not found" });
      return;
    }
    const message =
      error instanceof Error ? error.message : "Unable to delete screenshot";
    res.status(400).json({ error: message });
  }
});

app.get("/api/text", async (req, res) => {
  try {
    const requestedPath = getSingleQueryValue(req.query.path);
    if (!requestedPath) {
      res.status(400).json({ error: "Missing ?path=..." });
      return;
    }

    const absPath = resolveRepoPath(requestedPath);
    await ensureFile(absPath);
    const stats = await fs.stat(absPath);

    const maxReadBytes = Math.min(stats.size, MAX_PREVIEW_BYTES);
    const handle = await fs.open(absPath, "r");
    const buffer = Buffer.alloc(maxReadBytes);
    let readResult: Awaited<ReturnType<typeof handle.read>>;
    try {
      readResult = await handle.read(buffer, 0, maxReadBytes, 0);
    } finally {
      await handle.close();
    }
    const data = buffer.subarray(0, readResult.bytesRead);

    if (isLikelyBinary(data)) {
      res.json({
        path: toRepoRelativePath(absPath),
        binary: true,
        truncated: stats.size > data.length,
        size: stats.size,
      });
      return;
    }

    res.json({
      path: toRepoRelativePath(absPath),
      binary: false,
      truncated: stats.size > data.length,
      size: stats.size,
      content: data.toString("utf8"),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to read file";
    res.status(400).json({ error: message });
  }
});

app.get("/api/file", async (req, res) => {
  try {
    const requestedPath = getSingleQueryValue(req.query.path);
    if (!requestedPath) {
      res.status(400).json({ error: "Missing ?path=..." });
      return;
    }

    const absPath = resolveRepoPath(requestedPath);
    await ensureFile(absPath);
    const stats = await fs.stat(absPath);

    const mimeType = mimeLookup(absPath) || "application/octet-stream";
    if (String(mimeType).startsWith("image/")) {
      if (setImageCacheHeaders(req, res, stats)) {
        return;
      }
    }
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Length", String(stats.size));
    await pipeline(createReadStream(absPath), res);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to stream file";
    if (!res.headersSent) {
      res.status(400).json({ error: message });
      return;
    }
    res.destroy();
  }
});

app.post("/api/clipboard/upload", clipboardUploadMiddleware, handleClipboardUpload);
// Backward compatibility for older cached clients still posting to /api/upload.
app.post("/api/upload", clipboardUploadMiddleware, handleClipboardUpload);

const currentFilePath = fileURLToPath(import.meta.url);
const currentDirectoryPath = path.dirname(currentFilePath);
const staticDirectoryPath = path.resolve(currentDirectoryPath, "..", "static");

app.use(express.static(staticDirectoryPath));
app.get("/", (_req, res) => {
  res.sendFile(path.join(staticDirectoryPath, "index.html"));
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof multer.MulterError) {
    res.status(400).json({ error: error.message });
    return;
  }
  const message = error instanceof Error ? error.message : "Unexpected server error";
  res.status(500).json({ error: message });
});

app.listen(PORT, HOST, () => {
  console.log(`[remote-workspace] root: ${REPO_ROOT}`);
  console.log(`[remote-workspace] http://${HOST}:${PORT}`);
  if (BASIC_AUTH_PASSWORD.length > 0) {
    console.log("[remote-workspace] basic auth: enabled");
  }
  console.log(
    `[remote-workspace] Tailscale serve example: tailscale serve --bg --https=443 127.0.0.1:${PORT}`,
  );
});
