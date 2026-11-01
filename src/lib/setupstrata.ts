import path from "path";
import type { ConfigData } from "./config";
import { buildStrataProfile } from "./strataprofile";

/** Existing profiles are never replaced by an installer rerun. */
export function addSetupStrataProfile(config: ConfigData, installationId: string, configPath: string, context: number): boolean {
  if (Object.hasOwn(config.server.profiles, "strata")) return false;
  const installation = config.strataInstallations?.find((item) => item.id === installationId);
  if (!installation) throw new Error("Strata installation is not registered");
  const relative = path.relative(installation.root, configPath);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error("Strata config must be inside the registered installation");
  }
  if (!Number.isInteger(context) || context < 1024 || context > 32768) {
    throw new Error("Setup context must be between 1024 and 32768 tokens");
  }
  const profile = buildStrataProfile(undefined, {
    installationId, configPath,
    overrides: { maxContext: context, parallel: 1, batchMtp: "off" },
  });
  profile.presets.server.host = "127.0.0.1";
  profile.presets.server.port = 1234;
  profile.presets.server.apiKey = null;
  config.server.profiles.strata = profile;
  return true;
}
