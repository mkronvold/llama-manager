import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import type { ConfigData } from "./config";
import type { RuntimeLaunchSpec, StrataInstallation } from "./runtime";
import { validateStrataInstallations } from "./runtime";

const execFileAsync = promisify(execFile);
export type InspectionRunner = (executable: string, args: string[], cwd: string) => Promise<string>;

async function runInspection(executable: string, args: string[], cwd: string): Promise<string> {
  const result = await execFileAsync(executable, args, {
    cwd,
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  return result.stdout.trim();
}

export interface StrataConfigInfo {
  path: string;
  model: string;
  executable: string;
  args: string[];
  cwd: string;
  tokenizer: string;
  log: string | null;
  libDirs: string[];
  issues: string[];
}

export interface StrataInspection {
  root: string;
  python: string;
  sourceRevision: string | null;
  sourceTag: string | null;
  engineVersion: string | null;
  backend: string | null;
  architectures: string[];
  configs: StrataConfigInfo[];
  issues: string[];
  ready: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readObject(file: string): Promise<Record<string, unknown>> {
  const value: unknown = await fs.readJson(file);
  if (!isObject(value)) throw new Error(`${file}: expected a JSON object`);
  return value;
}

function resolvePath(base: string, value: string): string {
  return path.resolve(base, value);
}

async function requirePath(file: string, directory: boolean, issues: string[]): Promise<void> {
  try {
    const stat = await fs.stat(file);
    if (directory ? !stat.isDirectory() : !stat.isFile()) {
      issues.push(`Expected ${directory ? "directory" : "file"}: ${file}`);
    }
  } catch (error) {
    issues.push(`Cannot access ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function inspectConfig(file: string, root: string, backend: string | null): Promise<StrataConfigInfo> {
  const raw = await readObject(file);
  const issues: string[] = [];
  if (raw.cwd !== undefined && (typeof raw.cwd !== "string" || !raw.cwd.trim())) {
    issues.push("cwd must be a non-empty path");
  }
  if (raw.backend !== backend) issues.push("Config backend does not match the installed engine manifest");
  const cwd = typeof raw.cwd === "string" ? resolvePath(root, raw.cwd) : root;
  const args = Array.isArray(raw.args) && raw.args.every((arg): arg is string => typeof arg === "string")
    ? raw.args : [];
  if (!Array.isArray(raw.args) || args.length !== raw.args.length) issues.push("args must be an array of strings");
  const executable = typeof raw.exe === "string" ? resolvePath(cwd, raw.exe) : "";
  const tokenizer = typeof raw.tokenizer === "string" ? resolvePath(root, raw.tokenizer) : "";
  const model = typeof raw.model_name === "string" ? raw.model_name : "";
  if (!model) issues.push("Missing model_name");
  if (!executable) issues.push("Missing exe");
  else await requirePath(executable, false, issues);
  await requirePath(cwd, true, issues);
  if (!tokenizer) issues.push("Missing tokenizer");
  else {
    await requirePath(tokenizer, true, issues);
    for (const name of ["vocab.json", "merges.txt", "token_type.json"]) {
      await requirePath(path.join(tokenizer, name), false, issues);
    }
  }
  for (const [flag, directory] of [["--pack", true], ["--native", false]] as const) {
    const index = args.indexOf(flag);
    const value = index >= 0 ? args[index + 1] : undefined;
    if (!value || value.startsWith("--")) {
      issues.push(`Missing ${flag} path`);
      continue;
    }
    const resolved = resolvePath(cwd, value);
    await requirePath(resolved, directory, issues);
    if (flag === "--pack") {
      for (const name of ["index.txt", "dense.bin", "native_experts.txt"]) {
        await requirePath(path.join(resolved, name), false, issues);
      }
    }
    if (flag === "--native") {
      const match = path.basename(resolved).match(/^(.*)-(\d{5})-of-(\d{5})\.gguf$/i);
      if (match) {
        const count = Number(match[3]);
        if (count < 1 || count > 1000) issues.push(`Invalid shard count: ${resolved}`);
        else {
          for (let shard = 1; shard <= count; shard++) {
            await requirePath(path.join(path.dirname(resolved),
              `${match[1]}-${String(shard).padStart(5, "0")}-of-${match[3]}.gguf`), false, issues);
          }
        }
      }
    }
  }
  for (const flag of ["--expert-profile", "--mtp"]) {
    const index = args.indexOf(flag);
    if (index >= 0) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) issues.push(`Missing ${flag} path`);
      else await requirePath(resolvePath(cwd, value), flag === "--mtp", issues);
    }
  }
  const libDirs: string[] = [];
  if (raw.lib_dirs !== undefined && (!Array.isArray(raw.lib_dirs) || !raw.lib_dirs.every((item) => typeof item === "string"))) {
    issues.push("lib_dirs must be an array of paths");
  } else if (Array.isArray(raw.lib_dirs)) {
    for (const dir of raw.lib_dirs) {
      const resolved = resolvePath(root, String(dir));
      libDirs.push(resolved);
      await requirePath(resolved, true, issues);
    }
  }
  return {
    path: file, model, executable, args, cwd, tokenizer, libDirs, issues,
    log: typeof raw.log === "string" ? resolvePath(root, raw.log) : null,
  };
}

export async function inspectStrata(
  rootPath: string,
  runner: InspectionRunner = runInspection,
): Promise<StrataInspection> {
  const root = path.resolve(rootPath);
  const python = path.join(root, ".venv", "Scripts", "python.exe");
  const issues: string[] = [];
  const inspection: StrataInspection = {
    root, python, sourceRevision: null, sourceTag: null, engineVersion: null,
    backend: null, architectures: [], configs: [], issues, ready: false,
  };
  await requirePath(root, true, issues);
  const rootIsDirectory = issues.length === 0;
  await requirePath(path.join(root, "serve", "server.py"), false, issues);
  await requirePath(path.join(root, "setup.py"), false, issues);
  await requirePath(python, false, issues);
  try {
    const manifest = await readObject(path.join(root, "engine", "BUILD.json"));
    if (manifest.platform !== "windows-x64") issues.push("Engine manifest must specify windows-x64");
    if (manifest.backend !== "hip" && manifest.backend !== "cuda") issues.push("Unsupported Windows engine backend");
    else inspection.backend = manifest.backend;
    if (typeof manifest.version !== "string" || !manifest.version) issues.push("Missing engine version");
    else inspection.engineVersion = manifest.version;
    if (!Array.isArray(manifest.archs) || !manifest.archs.every((item) => typeof item === "string")) {
      issues.push("Engine manifest archs must be an array of strings");
    } else inspection.architectures = manifest.archs;
    if (manifest.lib_dirs !== undefined) {
      if (!Array.isArray(manifest.lib_dirs) || !manifest.lib_dirs.every((dir) => typeof dir === "string")) {
        issues.push("Engine manifest lib_dirs must be an array of paths");
      } else {
        for (const dir of manifest.lib_dirs) {
          await requirePath(resolvePath(path.join(root, "engine"), dir), true, issues);
        }
      }
    }
    await requirePath(path.join(root, "engine", "strata.exe"), false, issues);
  } catch (error) {
    issues.push(`Cannot inspect engine manifest: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (await fs.pathExists(path.join(root, ".git"))) {
    try {
      inspection.sourceRevision = await runner("git", ["rev-parse", "HEAD"], root);
      const tags = await runner("git", ["tag", "--points-at", "HEAD"], root);
      inspection.sourceTag = tags.split(/\r?\n/).find(Boolean) ?? null;
    } catch (error) {
      issues.push(`Cannot inspect source revision: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (await fs.pathExists(python)) {
    try {
      await runner(python, ["-c", "import sys; assert sys.version_info >= (3,10) and sys.maxsize > 2**32; import numpy, jinja2, regex, yaml, requests, psutil; import serve.server; import strata_tokenizer"], root);
    } catch (error) {
      issues.push(`Python/server dependency check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (rootIsDirectory) {
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !/^strata-.*\.json$/i.test(entry.name)) continue;
        try {
          inspection.configs.push(await inspectConfig(path.join(root, entry.name), root, inspection.backend));
        } catch (error) {
          issues.push(`Cannot inspect ${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch (error) {
      issues.push(`Cannot discover configs: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!inspection.configs.length) issues.push("No generated strata-*.json model configs; run upstream setup");
  inspection.ready = issues.length === 0 && inspection.configs.some((config) => config.issues.length === 0);
  return inspection;
}

export function buildStrataLaunchSpec(
  inspection: StrataInspection,
  configPath: string,
  host: string,
  port: number,
): RuntimeLaunchSpec {
  const config = inspection.configs.find((item) => item.path === path.resolve(configPath));
  if (!inspection.ready || !config || config.issues.length) {
    throw new Error("Strata configuration is not usable; inspect the installation diagnostics");
  }
  if (!host.trim() || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid Strata bind address or port");
  }
  return {
    executable: inspection.python,
    args: ["-u", "-m", "serve.server", "--engine", "strata", "--config", config.path,
      "--host", host, "--port", String(port)],
    cwd: inspection.root,
    environment: {},
  };
}

export async function registerStrataInstallation(
  config: ConfigData,
  rootPath: string,
  runner: InspectionRunner = runInspection,
): Promise<StrataInspection> {
  if (os.platform() !== "win32") throw new Error("Strata registration currently supports Windows only");
  if (!path.isAbsolute(rootPath)) throw new Error("Strata installation root must be an absolute path");
  const root = await fs.realpath(path.resolve(rootPath));
  if (validateStrataInstallations(config.strataInstallations).some((item) => item.root.toLowerCase() === root.toLowerCase())) {
    throw new Error(`Strata installation is already registered: ${root}`);
  }
  const inspection = await inspectStrata(root, runner);
  const installation: StrataInstallation = {
    id: randomUUID(), root, ownership: "external", registeredAt: new Date().toISOString(),
  };
  config.strataInstallations = [...(config.strataInstallations ?? []), installation];
  return inspection;
}

export function unregisterStrataInstallation(config: ConfigData, id: string): void {
  const registrations = validateStrataInstallations(config.strataInstallations);
  if (!registrations.some((item) => item.id === id)) throw new Error(`Unknown Strata registration: ${id}`);
  config.strataInstallations = registrations.filter((item) => item.id !== id);
}
