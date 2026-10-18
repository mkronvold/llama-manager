export type RuntimeKind = "llama-compatible" | "strata";

export interface StrataInstallation {
  id: string;
  root: string;
  ownership: "external" | "managed";
  registeredAt: string;
}

export interface RuntimeCapabilities {
  settingsOwner: "manager" | "upstream";
  telemetry: "logs" | "json-api";
  listDevices: boolean;
  modelSelection: boolean;
  lifecycleAvailable: boolean;
}

export interface RuntimeLaunchSpec {
  executable: string;
  args: string[];
  cwd?: string;
  environment: Record<string, string>;
}

export interface RuntimeAdapter {
  kind: RuntimeKind;
  capabilities: RuntimeCapabilities;
}

const ADAPTERS: Record<RuntimeKind, RuntimeAdapter> = {
  "llama-compatible": {
    kind: "llama-compatible",
    capabilities: {
      settingsOwner: "manager",
      telemetry: "logs",
      listDevices: true,
      modelSelection: true,
      lifecycleAvailable: true,
    },
  },
  strata: {
    kind: "strata",
    capabilities: {
      settingsOwner: "upstream",
      telemetry: "json-api",
      listDevices: false,
      modelSelection: false,
      lifecycleAvailable: true,
    },
  },
};

export function getRuntimeAdapter(kind: RuntimeKind): RuntimeAdapter {
  return ADAPTERS[kind];
}

export function strataVersionId(installationId: string): string {
  return `strata:${installationId}`;
}

export function isStrataVersion(version: string): boolean {
  return version.startsWith("strata:");
}

export interface StrataEngineOverrides {
  /** --max-context; contexts above the trained 262144 need setup's rope scaling, so they stay Configure-only. */
  maxContext?: number;
  /** "off" keeps the whole KV cache in VRAM; "on" streams it with kvResidentCells cells per layer in VRAM. */
  kvStreaming?: "on" | "off";
  kvResidentCells?: number;
  prefill?: "auto" | "auto:16384" | "auto:32768";
  /** The config's top-level "parallel": batch slots decoding together (1 = one request at a time). */
  parallel?: number;
  /** --batch-mtp: MTP drafts inside batch slots (single GPU). */
  batchMtp?: "on" | "off";
}

export const STRATA_PARALLEL_MAX = 8;
export const STRATA_CONTEXT_CHOICES = [8192, 32768, 65536, 131072, 204800, 262144] as const;
export const STRATA_PREFILL_CHOICES = ["auto", "auto:16384", "auto:32768"] as const;
export const STRATA_KV_RESIDENT_MIN = 20480;
export const STRATA_KV_RESIDENT_DEFAULT = 32768;

export interface StrataProfileBinding {
  installationId: string;
  configPath: string | null;
  /** Profile-owned engine settings applied at Start over the generated config; absent = config value. */
  overrides?: StrataEngineOverrides;
}

export class RuntimeRegistrationError extends Error {}

export function validateStrataOverrides(value: unknown, profileName: string): StrataEngineOverrides | undefined {
  if (value === undefined || value === null) return undefined;
  const fail = (what: string): never => {
    throw new RuntimeRegistrationError(`Invalid Strata engine setting in profile "${profileName}": ${what}`);
  };
  if (typeof value !== "object" || Array.isArray(value)) fail("expected an object");
  const v = value as Record<string, unknown>;
  const out: StrataEngineOverrides = {};
  if (v.maxContext !== undefined) {
    if (!(STRATA_CONTEXT_CHOICES as readonly unknown[]).includes(v.maxContext)) fail(`context ${String(v.maxContext)}`);
    out.maxContext = v.maxContext as number;
  }
  if (v.kvStreaming !== undefined) {
    if (v.kvStreaming !== "on" && v.kvStreaming !== "off") fail(`KV streaming ${String(v.kvStreaming)}`);
    out.kvStreaming = v.kvStreaming as "on" | "off";
  }
  if (v.kvResidentCells !== undefined) {
    if (typeof v.kvResidentCells !== "number" || !Number.isInteger(v.kvResidentCells) ||
        v.kvResidentCells < STRATA_KV_RESIDENT_MIN) {
      fail(`KV cells in VRAM must be an integer of at least ${STRATA_KV_RESIDENT_MIN}`);
    }
    out.kvResidentCells = v.kvResidentCells as number;
  }
  if (v.prefill !== undefined) {
    if (!(STRATA_PREFILL_CHOICES as readonly unknown[]).includes(v.prefill)) fail(`prefill ${String(v.prefill)}`);
    out.prefill = v.prefill as StrataEngineOverrides["prefill"];
  }
  if (v.parallel !== undefined) {
    if (typeof v.parallel !== "number" || !Number.isInteger(v.parallel) ||
        v.parallel < 1 || v.parallel > STRATA_PARALLEL_MAX) {
      fail(`parallel must be a whole number from 1 to ${STRATA_PARALLEL_MAX}`);
    }
    out.parallel = v.parallel as number;
  }
  if (v.batchMtp !== undefined) {
    if (v.batchMtp !== "on" && v.batchMtp !== "off") fail(`batch MTP ${String(v.batchMtp)}`);
    out.batchMtp = v.batchMtp as "on" | "off";
  }
  return Object.keys(out).length ? out : undefined;
}

export function validateStrataProfileBinding(value: unknown, profileName: string): StrataProfileBinding | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" ||
      !("installationId" in value) || typeof value.installationId !== "string" || !value.installationId.trim() ||
      !("configPath" in value) ||
      (value.configPath !== null && (typeof value.configPath !== "string" || !path.isAbsolute(value.configPath)))) {
    throw new RuntimeRegistrationError(
      `Invalid Strata binding in profile "${profileName}": expected installation ID and absolute config path or null`,
    );
  }
  const overrides = validateStrataOverrides((value as { overrides?: unknown }).overrides, profileName);
  return { installationId: value.installationId, configPath: value.configPath, ...(overrides ? { overrides } : {}) };
}

export function validateStrataInstallations(value: unknown): StrataInstallation[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new RuntimeRegistrationError("strataInstallations must be an array");
  const ids = new Set<string>();
  const roots = new Set<string>();
  return value.map((item: unknown) => {
    if (typeof item !== "object" || item === null ||
        !("id" in item) || typeof item.id !== "string" || !item.id.trim() ||
        !("root" in item) || typeof item.root !== "string" || !path.isAbsolute(item.root) ||
        !("ownership" in item) || (item.ownership !== "external" && item.ownership !== "managed") ||
        !("registeredAt" in item) || typeof item.registeredAt !== "string" || !Number.isFinite(Date.parse(item.registeredAt))) {
      throw new RuntimeRegistrationError("Invalid Strata registration: expected ID, absolute root, ownership and registration date");
    }
    const rootKey = path.resolve(item.root).toLowerCase();
    if (ids.has(item.id) || roots.has(rootKey)) {
      throw new RuntimeRegistrationError("Duplicate Strata registration ID or installation root");
    }
    ids.add(item.id);
    roots.add(rootKey);
    return { id: item.id, root: item.root, ownership: item.ownership, registeredAt: item.registeredAt };
  });
}
import path from "node:path";
