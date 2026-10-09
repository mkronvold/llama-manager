import fs from "fs-extra";
import path from "node:path";
import {
  DEFAULT_PRESETS,
  STRATA_DEFAULT_HOST,
  STRATA_DEFAULT_PORT,
  profilesUsingStrataInstallation,
  type ConfigData,
  type ServerPresets,
  type ServerProfile,
} from "./config";
import type { StrataInstallation, StrataProfileBinding } from "./runtime";

/** Preset fields a Strata profile exposes; every other llama preset is hidden. */
const STRATA_PROFILE_FIELDS: Record<string, readonly string[]> = {
  server: ["host", "port", "apiKey"],
};

export function isPresetFieldVisibleForStrata(categoryKey: string, fieldKey: string): boolean {
  return STRATA_PROFILE_FIELDS[categoryKey]?.includes(fieldKey) ?? false;
}

export function strataFieldDefault(categoryKey: string, fieldKey: string): unknown {
  if (categoryKey !== "server") return undefined;
  if (fieldKey === "host") return STRATA_DEFAULT_HOST;
  if (fieldKey === "port") return STRATA_DEFAULT_PORT;
  return undefined;
}

const LLAMA_DEFAULT_HOST = "127.0.0.1";
const LLAMA_DEFAULT_PORT = 8080;

/**
 * Builds a new Strata profile. Host/port/apiKey are copied from the source profile
 * when it set them; values that are missing or still the llama defaults count as
 * unset and fall back to Strata's 0.0.0.0:1234.
 */
export function buildStrataProfile(source: ServerProfile | undefined, binding: StrataProfileBinding): ServerProfile {
  const presets = JSON.parse(JSON.stringify(DEFAULT_PRESETS)) as ServerPresets;
  const server = source?.presets?.server ?? {};
  const host = typeof server.host === "string" && server.host.trim() && server.host !== LLAMA_DEFAULT_HOST
    ? server.host : STRATA_DEFAULT_HOST;
  const port = typeof server.port === "number" && Number.isInteger(server.port) && server.port > 0 &&
    server.port <= 65535 && server.port !== LLAMA_DEFAULT_PORT ? server.port : STRATA_DEFAULT_PORT;
  presets.server = { ...presets.server, host, port, apiKey: typeof server.apiKey === "string" && server.apiKey ? server.apiKey : null };
  return { presets, freeFormArgs: [], strata: { ...binding } };
}

export function findStrataInstallation(config: ConfigData, id: string): StrataInstallation | undefined {
  return config.strataInstallations?.find((item) => item.id === id);
}

/** Cheap discovery of generated configs (no Python/Git inspection). */
export async function listStrataConfigFiles(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /^strata-.*\.json$/i.test(entry.name))
      .map((entry) => path.join(root, entry.name))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export interface StrataConfigSummary {
  path: string;
  model: string | null;
  backend: string | null;
  configHost: string | null;
  configPort: number | null;
  hasConfigApiKey: boolean;
  /** Requested engine settings, in config order, rendered read-only. */
  settings: Array<{ key: string; value: string }>;
  error: string | null;
}

const PATH_FLAGS = new Set(["--pack", "--native", "--expert-profile", "--mtp"]);

/** Reads a generated strata-*.json for read-only display. Never throws. */
export async function readStrataConfigSummary(file: string): Promise<StrataConfigSummary> {
  const summary: StrataConfigSummary = {
    path: file, model: null, backend: null, configHost: null, configPort: null,
    hasConfigApiKey: false, settings: [], error: null,
  };
  let raw: unknown;
  try {
    raw = await fs.readJson(file);
  } catch (error) {
    summary.error = error instanceof Error ? error.message : String(error);
    return summary;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    summary.error = "expected a JSON object";
    return summary;
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.model_name === "string") summary.model = obj.model_name;
  if (typeof obj.backend === "string") summary.backend = obj.backend;
  if (typeof obj.host === "string") summary.configHost = obj.host;
  if (typeof obj.port === "number") summary.configPort = obj.port;
  summary.hasConfigApiKey = typeof obj.api_key === "string" && obj.api_key.length > 0;
  const args = Array.isArray(obj.args) ? obj.args.filter((a): a is string => typeof a === "string") : [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) continue;
    const next = args[i + 1];
    const hasValue = next !== undefined && !next.startsWith("--");
    let value = hasValue ? next : "on";
    if (hasValue) i++;
    if (PATH_FLAGS.has(arg)) value = path.basename(value);
    summary.settings.push({ key: arg.slice(2), value });
  }
  if (typeof obj.tokenizer === "string") summary.settings.push({ key: "tokenizer", value: path.basename(obj.tokenizer) });
  if (Array.isArray(obj.lib_dirs)) {
    summary.settings.push({ key: "lib_dirs", value: obj.lib_dirs.map(String).join("; ") });
  }
  return summary;
}

export type StrataProfileStatus =
  | { kind: "ok" }
  | { kind: "installation-missing" }
  | { kind: "config-unset" }
  | { kind: "config-missing" };

export async function getStrataProfileStatus(config: ConfigData, binding: StrataProfileBinding): Promise<StrataProfileStatus> {
  if (!findStrataInstallation(config, binding.installationId)) return { kind: "installation-missing" };
  if (!binding.configPath) return { kind: "config-unset" };
  if (!(await fs.pathExists(binding.configPath))) return { kind: "config-missing" };
  return { kind: "ok" };
}

export function describeStrataProfileStatus(status: StrataProfileStatus): string {
  switch (status.kind) {
    case "ok": return "ready";
    case "installation-missing": return "installation not registered — pick another in Edit";
    case "config-unset": return "configuration needed — run Configure, then select a config";
    case "config-missing": return "config missing — run Configure or select another config";
  }
}

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127\./.test(h);
}

export function strataExposureWarning(profile: ServerProfile, configHasApiKey = false): string | null {
  const host = String(profile.presets.server.host ?? "");
  const key = profile.presets.server.apiKey;
  if (!isLoopbackHost(host) && !(typeof key === "string" && key) && !configHasApiKey) {
    return `Bound to ${host} without an API key: other devices on the network can use this service`;
  }
  return null;
}

/** Confirmation text for unregistering an installation; lists profiles that will lose their binding. */
export function strataUnregisterMessage(config: ConfigData, installationId: string, root: string): string {
  const base = `Unregister ${root}? All source, environment, model and pack files will be kept.`;
  const users = profilesUsingStrataInstallation(config, installationId);
  if (users.length === 0) return base;
  return `${base} Profiles using it will show "installation not registered" until re-bound: ${users.join(", ")}.`;
}
