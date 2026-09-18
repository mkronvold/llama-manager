import fs from "fs-extra";
import path from "path";
import os from "os";
import { getVersionsDir } from "./config";
import { ConfigData } from "./config";
import {
  getFork,
  resolveBinaryName,
  parseFolderNameV2,
  detectForkFromFolder,
  ForkDefinition,
} from "./forks";

export const BACKEND_LABELS: Record<string, string> = {
  cpu: "CPU",
  metal: "Metal",
  cuda: "CUDA",
  cuda12: "CUDA 12",
  cuda13: "CUDA 13",
  vulkan: "Vulkan",
  rocm: "ROCm",
  "rocm-gfx120X": "ROCm gfx120X",
  "rocm-gfx1151": "ROCm gfx1151",
  "rocm-gfx1150": "ROCm gfx1150",
  "rocm-gfx110X": "ROCm gfx110X",
  "rocm-gfx103X": "ROCm gfx103X",
  "rocm-gfx90a": "ROCm gfx90a",
  "rocm-gfx908": "ROCm gfx908",
  openvino: "OpenVINO",
  opencl: "OpenCL",
  sycl: "SYCL",
  hip: "HIP/Radeon",
  oldpc: "CUDA (old GPU)",
};

export interface VersionInfo {
  version: string;
  tag: string;
  backend: string;
  path: string;
  active: boolean;
  fork: string;
  createdAt: number;
}

export interface RemoteVersion {
  tag: string;
  name: string;
  publishedAt: string;
  body: string;
  assets: Array<{ name: string; size: number; url: string }>;
}

export interface AvailableBackend {
  id: string;
  label: string;
  assetName: string;
}

export async function listRecentVersions(forkId: string, limit = 20): Promise<RemoteVersion[]> {
  const fork = getFork(forkId);
  const response = await fetch(
    `https://api.github.com/repos/${fork.githubRepo}/releases?per_page=${limit}`,
    {
      headers: { "User-Agent": "llama-manager" },
    },
  );

  if (!response.ok) throw new Error(`Failed to fetch releases: ${response.status}`);
  const data = await response.json();
  return data.map((r: any) => ({
    tag: r.tag_name,
    name: r.name || r.tag_name,
    publishedAt: r.published_at,
    body: r.body || "",
    assets: (r.assets || []).map((a: any) => ({ name: a.name, size: a.size, url: a.browser_download_url })),
  }));
}

/**
 * Convert an absolute path to Windows' extended-length ("\\?\") form so extraction of
 * archives with deeply nested entries doesn't hit the legacy 260-character MAX_PATH
 * limit. This bypasses MAX_PATH at the Win32 API layer regardless of whether the
 * "Enable Win32 long paths" group policy is turned on, and is a no-op on other
 * platforms. Node's own fs layer already does some of this internally, but applying it
 * explicitly for the extraction target directory maximizes compatibility across
 * Windows versions/policies and third-party extraction libraries.
 */
function toExtendedLengthPath(p: string): string {
  if (os.platform() !== "win32") return p;
  const resolved = path.resolve(p);
  if (resolved.startsWith("\\\\?\\")) return resolved;
  if (resolved.startsWith("\\\\")) return `\\\\?\\UNC\\${resolved.slice(2)}`;
  return `\\\\?\\${resolved}`;
}

export type InstallProgress = (pct: number, label: string) => void;

/** Transient Windows-only fs error codes seen when antivirus/Defender briefly locks
 * a just-written or just-extracted file (chmod/move racing a real-time AV scan). */
const TRANSIENT_WIN_FS_CODES = new Set(["EBUSY", "EPERM", "EACCES"]);

/**
 * Retry an fs operation with backoff when it fails with a transient Windows file-lock
 * error. No-ops (single attempt, rethrows immediately) on non-Windows platforms since
 * these errors are not expected there.
 */
async function retryOnTransientFsError<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseDelayMs?: number } = {},
): Promise<T> {
  const attempts = opts.attempts ?? (os.platform() === "win32" ? 5 : 1);
  const baseDelayMs = opts.baseDelayMs ?? 200;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const code = err?.code as string | undefined;
      if (os.platform() !== "win32" || !code || !TRANSIENT_WIN_FS_CODES.has(code) || i === attempts - 1) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * (i + 1)));
    }
  }
  throw lastErr;
}

/**
 * Runs `fn` while periodically invoking `onStall` if no progress has been observed for
 * `stallMs`. Call the returned `tick()` from within `fn` whenever real progress happens
 * (e.g. a chunk written); `onStall` fires repeatedly at `stallMs` intervals until progress
 * resumes or `fn` settles. Always cleans up its timer.
 */
async function withStallWatchdog<T>(
  fn: (tick: () => void) => Promise<T>,
  onStall: (elapsedMs: number) => void,
  stallMs = 15000,
): Promise<T> {
  let lastProgress = Date.now();
  const timer = setInterval(() => {
    const elapsed = Date.now() - lastProgress;
    if (elapsed >= stallMs) onStall(elapsed);
  }, stallMs);
  try {
    return await fn(() => {
      lastProgress = Date.now();
    });
  } finally {
    clearInterval(timer);
  }
}

function getBackendLabel(backend: string): string {
  if (BACKEND_LABELS[backend]) return BACKEND_LABELS[backend];
  const base = Object.keys(BACKEND_LABELS).find((k) => backend.startsWith(k));
  if (base) {
    const suffix = backend.slice(base.length);
    return BACKEND_LABELS[base] + (suffix ? ` ${suffix}` : "");
  }
  return backend;
}

export async function listVersions(config: ConfigData): Promise<VersionInfo[]> {
  const dir = getVersionsDir(config);
  if (!(await fs.pathExists(dir))) return [];

  const entries = await fs.readdir(dir, { withFileTypes: true });
  const versions: VersionInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const versionPath = path.join(dir, entry.name);
    const fork = detectForkFromFolder(entry.name);
    const binaryName = resolveBinaryName(fork);
    const binary = path.join(versionPath, binaryName);
    if (await fs.pathExists(binary)) {
      const { tag, backend } = parseFolderNameV2(entry.name);
      const stat = await fs.stat(versionPath);
      versions.push({
        version: entry.name,
        tag,
        backend,
        path: versionPath,
        active: entry.name === config.activeVersion,
        fork: fork.id,
        createdAt: stat.birthtimeMs,
      });
    }
  }

  return versions.sort((a, b) => {
    const tagCmp = b.tag.localeCompare(a.tag);
    if (tagCmp !== 0) return tagCmp;
    return a.backend.localeCompare(b.backend);
  });
}

export async function switchVersion(config: ConfigData, version: string): Promise<ConfigData> {
  const dir = getVersionsDir(config);
  const versionPath = path.join(dir, version);
  const fork = detectForkFromFolder(version);
  const binaryName = resolveBinaryName(fork);
  const binary = path.join(versionPath, binaryName);

  if (!(await fs.pathExists(binary))) {
    throw new Error(`Version not found: ${version}`);
  }

  config.activeVersion = version;
  return config;
}

export async function uninstallVersion(config: ConfigData, version: string): Promise<void> {
  if (version === config.activeVersion) {
    throw new Error("Cannot uninstall active version");
  }

  const dir = getVersionsDir(config);
  const versionPath = path.join(dir, version);
  await fs.remove(versionPath);
}

export async function checkLatestVersion(forkId: string): Promise<string> {
  const fork = getFork(forkId);
  const response = await fetch(
    `https://api.github.com/repos/${fork.githubRepo}/releases/latest`,
    {
      headers: { "User-Agent": "llama-manager" },
    },
  );

  if (!response.ok) throw new Error("Failed to fetch latest version");
  const data = await response.json();
  return data.tag_name;
}

export function getPlatformKey(): string {
  const platform = os.platform();
  if (platform === "linux") return "ubuntu";
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "win";
  throw new Error(`Unsupported platform: ${platform}`);
}

export function getArchKey(): string {
  const arch = os.arch();
  if (arch === "x64") return "x64";
  if (arch === "arm64") return "arm64";
  throw new Error(`Unsupported architecture: ${arch}`);
}

function extractBackendFromAsset(
  assetName: string,
  version: string,
  platform: string,
  fork: ForkDefinition,
): string | null {
  if (fork.id === "koboldcpp") {
    // Windows koboldcpp assets are raw ".exe" files with no OS token in the name
    // (e.g. "koboldcpp.exe", "koboldcpp-nocuda.exe"), unlike the linux/mac archives.
    const ext = assetName.endsWith(".tar.gz")
      ? ".tar.gz"
      : assetName.endsWith(".zip")
        ? ".zip"
        : assetName.endsWith(".exe")
          ? ".exe"
          : null;
    const base = ext ? assetName.slice(0, assetName.length - ext.length) : assetName;
    for (const variant of fork.backendVariants) {
      if (variant.assetMatcher(base, platform)) {
        return variant.id;
      }
    }
    return null;
  }
  if (fork.id === "llamacpp_rocm") {
    const ext = assetName.endsWith(".zip") ? ".zip" : null;
    const base = ext ? assetName.slice(0, assetName.length - ext.length) : assetName;
    for (const variant of fork.backendVariants) {
      if (variant.assetMatcher(base, platform)) {
        return variant.id;
      }
    }
    return null;
  }
  const ext = assetName.endsWith(".tar.gz") ? ".tar.gz" : assetName.endsWith(".zip") ? ".zip" : null;
  if (!ext) return null;

  const base = assetName.slice(0, assetName.length - ext.length);
  const osName = platform.split("-")[0];
  const arch = getArchKey();
  const prefixBase = fork.extractDirPrefix || "";
  const prefix = `${prefixBase}${version}-bin-${osName}`;
  const suffix = `-${arch}`;

  if (!base.startsWith(prefix) || !base.endsWith(suffix)) return null;

  const between = base.slice(prefix.length, base.length - suffix.length);
  if (!between || between === "") return "cpu";

  const parts = between.slice(1).split("-");
  const runtime = parts[0].toLowerCase();
  // "cpu" is included here because Windows llama.cpp/beellama/ik_llama releases publish
  // an explicit "-cpu-" suffixed asset (unlike Ubuntu/macOS builds, which omit any
  // suffix for the default CPU build and rely on the `between === ""` branch above).
  const known = ["cpu", "cuda", "vulkan", "rocm", "openvino", "opencl", "hip", "adreno", "sycl"];
  if (!known.includes(runtime)) return null;

  const versionPart = parts.slice(1).join(".").replace(/[^0-9.]/g, "");
  return versionPart ? `${runtime}${versionPart}` : runtime;
}

export function getAvailableBackends(
  version: string,
  platform: string,
  assets: Array<{ name: string }>,
  forkId: string,
): AvailableBackend[] {
  const fork = getFork(forkId);
  const backends: AvailableBackend[] = [];
  const seen = new Set<string>();
  const osName = platform.split("-")[0].toLowerCase();
  const arch = getArchKey().toLowerCase();
  const naming = fork.assetNaming;

  for (const asset of assets) {
    const nameLower = asset.name.toLowerCase();

    // Windows raw-binary assets (e.g. koboldcpp's "koboldcpp.exe") often carry no OS
    // token at all in the filename; an ".exe" extension unambiguously identifies them
    // as Windows binaries in this codebase (POSIX raw binaries never use ".exe"), so
    // skip the OS-token gate for that case instead of excluding them.
    const isWindowsExe = !naming.isArchive && platform.startsWith("win") && nameLower.endsWith(".exe");
    if (!isWindowsExe) {
      // Check OS token matches any of the fork's known OS tokens
      if (!naming.osTokens.some(token => nameLower.includes(token.toLowerCase()))) continue;
    }

    // Check arch + extension for archives
    if (naming.isArchive) {
      if (!nameLower.endsWith(`${arch}.tar.gz`) && !nameLower.endsWith(`${arch}.zip`)) continue;
    }

    const backend = extractBackendFromAsset(asset.name, version, platform, fork);
    if (!backend || seen.has(backend)) continue;
    seen.add(backend);

    backends.push({
      id: backend,
      label: getBackendLabel(backend),
      assetName: asset.name,
    });
  }

  return backends.sort((a, b) => {
    if (a.id === "cpu") return -1;
    if (b.id === "cpu") return 1;
    if (a.id === "metal") return -1;
    if (b.id === "metal") return 1;
    return a.id.localeCompare(b.id);
  });
}

function resolveAssetName(
  version: string,
  platform: string,
  backend: string,
  assets: Array<{ name: string; browser_download_url?: string }>,
  fork: ForkDefinition,
): { name: string; url: string } | null {
  for (const asset of assets) {
    const detected = extractBackendFromAsset(asset.name, version, platform, fork);
    if (detected === backend && asset.browser_download_url) {
      return { name: asset.name, url: asset.browser_download_url };
    }
  }
  return null;
}

function getFolderName(tag: string, backend: string, fork: ForkDefinition): string {
  const prefix = fork.folderPrefix;
  if (backend === "cpu" || backend === "metal") return `${prefix}${tag}`;
  return `${prefix}${tag}-${backend}`;
}

export async function installVersion(
  config: ConfigData,
  forkId: string,
  version: string,
  backend: string,
  onProgress: InstallProgress,
): Promise<string> {
  const fork = getFork(forkId);
  const dir = getVersionsDir(config);
  const folderName = getFolderName(version, backend, fork);
  const versionPath = path.join(dir, folderName);

  if (await fs.pathExists(versionPath)) {
    const unixBin = path.join(versionPath, "llama-server");
    const winBin = path.join(versionPath, "llama-server.exe");
    if (!(await fs.pathExists(unixBin)) && !(await fs.pathExists(winBin))) {
      await fs.remove(versionPath);
    } else {
      throw new Error(`Version already installed: ${folderName}`);
    }
  }

  const platform = getPlatformKey();

  onProgress(0, "Downloading release info...");
  const res = await fetch(
    `https://api.github.com/repos/${fork.githubRepo}/releases/tags/${version}`,
    {
      headers: { "User-Agent": "llama-manager" },
    },
  );

  if (!res.ok) {
    if (res.status === 404) throw new Error(`Version not found: ${version}`);
    throw new Error(`Failed to fetch release: ${res.status}`);
  }

  const releaseData = await res.json();
  const assets = releaseData.assets || [];
  const assetInfo = resolveAssetName(version, platform, backend, assets, fork);

  if (!assetInfo) {
    const available = getAvailableBackends(version, platform, assets.map((a: any) => ({ name: a.name })), forkId);
    throw new Error(`Backend "${backend}" not available. Available: ${available.map((b) => b.label).join(", ")}`);
  }

  const { name: assetName, url: downloadUrl } = assetInfo;

  onProgress(5, `Downloading ${assetName}...`);
  const dlRes = await fetch(downloadUrl);
  if (!dlRes.ok) throw new Error(`Download failed: ${dlRes.status}`);

  const total = parseInt(dlRes.headers.get("content-length") || "0", 10);
  let received = 0;

  await fs.ensureDir(versionPath);
  const tmpPath = path.join(versionPath, assetName);
  const writeStream = await fs.createWriteStream(tmpPath);

  const reader = dlRes.body as ReadableStream<Uint8Array>;
  const readerObj = reader.getReader();

  while (true) {
    const { done, value } = await readerObj.read();
    if (done) break;
    received += value.byteLength;
    const pct = Math.round((received / total) * 90);
    onProgress(pct, `Downloading: ${(received / 1024 / 1024).toFixed(1)} MB / ${(total / 1024 / 1024).toFixed(1)} MB`);
    // Respect backpressure: if the internal buffer is full, wait for "drain" before
    // reading more from the network. Without this, a slow disk (e.g. antivirus
    // intercepting writes on Windows) lets the network race far ahead of disk I/O,
    // causing unbounded memory growth that looks like a hang with no progress.
    const canContinue = writeStream.write(value);
    if (!canContinue) {
      await new Promise<void>((resolve) => writeStream.once("drain", () => resolve()));
    }
  }
  writeStream.end();

  await new Promise<void>((resolve, reject) => {
    writeStream.on("finish", () => resolve());
    writeStream.on("error", reject);
  });

  if (fork.isRawBinary) {
    onProgress(92, `Preparing binary...`);
    const binaryName = resolveBinaryName(fork);
    const destPath = path.join(versionPath, binaryName);
    await retryOnTransientFsError(() => fs.move(tmpPath, destPath));
    await retryOnTransientFsError(() => fs.chmod(destPath, "755"));
    onProgress(100, `Installed ${folderName}`);
    return folderName;
  }

  onProgress(92, `Extracting...`);

  if (assetName.endsWith(".zip")) {
    const extractZip = await import("extract-zip");
    try {
      await withStallWatchdog(
        async (tick) => {
          const result = extractZip.default(tmpPath, { dir: toExtendedLengthPath(versionPath) });
          // extract-zip doesn't expose incremental progress; treat the promise settling
          // (or not) as the only signal, but still record a tick so the watchdog timer
          // resets its clock from the start of this call rather than firing immediately.
          tick();
          return result;
        },
        (elapsedMs) => onProgress(92, `Extracting... (still working after ${Math.round(elapsedMs / 1000)}s — this can take a while on slower disks or when antivirus is scanning the extracted files)`),
      );
    } catch (err: any) {
      await fs.remove(tmpPath);
      throw new Error(`Extraction failed: ${err.message}`);
    }
  } else if (assetName.endsWith(".tar.gz") || assetName.endsWith(".tgz")) {
    const tar = await import("tar");
    try {
      await withStallWatchdog(
        async (tick) => {
          const result = tar.extract({ file: tmpPath, cwd: toExtendedLengthPath(versionPath) });
          tick();
          return result;
        },
        (elapsedMs) => onProgress(92, `Extracting... (still working after ${Math.round(elapsedMs / 1000)}s — this can take a while on slower disks or when antivirus is scanning the extracted files)`),
      );
    } catch (err: any) {
      await fs.remove(tmpPath);
      throw new Error(`Extraction failed: ${err.message}`);
    }
  } else {
    const binaryName = path.basename(assetName).replace(/\.(zip|tar\.gz|tgz)$/, "");
    await retryOnTransientFsError(() => fs.move(tmpPath, path.join(versionPath, binaryName)));
  }

  await fs.remove(tmpPath);

  const extractPrefix = fork.extractDirPrefix || "llama-";
  const subdirs = await fs.readdir(versionPath, { withFileTypes: true });
  const topDir = subdirs.find((e) => e.isDirectory() && e.name.startsWith(extractPrefix));
  if (topDir && (await fs.readdir(versionPath)).length === 1) {
    const srcPath = path.join(versionPath, topDir.name);
    const entries = await fs.readdir(srcPath, { withFileTypes: true });
    for (const entry of entries) {
      await retryOnTransientFsError(() =>
        fs.move(path.join(srcPath, entry.name), path.join(versionPath, entry.name), { overwrite: true }),
      );
    }
    await retryOnTransientFsError(() => fs.remove(srcPath));
  }

  const binaryName = resolveBinaryName(fork);
  const binary = path.join(versionPath, binaryName);
  if (await fs.pathExists(binary)) {
    // fs.chmod is effectively a no-op on Windows (ACLs don't map to POSIX mode bits);
    // harmless to call, kept for parity with POSIX platforms where it actually matters.
    await retryOnTransientFsError(() => fs.chmod(binary, "755"));
  }

  onProgress(100, `Installed ${folderName}`);
  return folderName;
}

export async function getTotalVersionsSize(config: ConfigData): Promise<number> {
  const dir = getVersionsDir(config);
  if (!(await fs.pathExists(dir))) return 0;

  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const size = await dirSize(path.join(dir, entry.name));
      total += size;
    }
  }
  return total;
}

async function dirSize(dirPath: string): Promise<number> {
  let total = 0;
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        total += await dirSize(fullPath);
      } else {
        const stat = await fs.stat(fullPath);
        total += stat.size;
      }
    }
  } catch {
    // ignore permission errors
  }
  return total;
}
