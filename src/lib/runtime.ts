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
      lifecycleAvailable: false,
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

export interface StrataProfileBinding {
  installationId: string;
  configPath: string | null;
}

export class RuntimeRegistrationError extends Error {}

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
  return { installationId: value.installationId, configPath: value.configPath };
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
