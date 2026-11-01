import fs from "fs-extra";
import path from "path";
import { getConfigPath, loadConfig, saveConfig } from "../src/lib/config";
import { inspectStrata, registerStrataInstallation } from "../src/lib/strata";
import { addSetupStrataProfile } from "../src/lib/setupstrata";

const [rootArg, contextArg, selectedConfig] = process.argv.slice(2);
if (!rootArg || !contextArg) throw new Error("Expected Strata root and context");
const configFile = getConfigPath();
if (await fs.pathExists(configFile)) {
  // loadConfig deliberately falls back on corrupt config; installers must not overwrite it.
  const raw = await fs.readJson(configFile);
  if (!raw || !raw.server?.profiles || !Object.hasOwn(raw.server.profiles, raw.server.activeProfile)) {
    throw new Error(`Existing config cannot safely be updated: ${configFile}`);
  }
}
const config = structuredClone(await loadConfig());
if (Object.hasOwn(config.server.profiles, "strata")) {
  console.log('Profile "strata" already exists; no configuration or registration was changed.');
} else {
  const root = await fs.realpath(rootArg);
  const existing = config.strataInstallations?.find((item) => item.root.toLowerCase() === root.toLowerCase());
  const inspection = existing ? await inspectStrata(root) : await registerStrataInstallation(config, root);
  if (!inspection.ready) throw new Error(`Strata is not ready: ${inspection.issues.join("; ")}`);
  const candidates = inspection.configs.filter((item) => item.issues.length === 0);
  const selected = selectedConfig
    ? candidates.find((item) => path.resolve(item.path).toLowerCase() === path.resolve(selectedConfig).toLowerCase())
    : candidates.length === 1 ? candidates[0] : undefined;
  if (!selected) {
    throw new Error("Select exactly one valid generated config with -StrataConfig; none or multiple were found. No manager config was saved.");
  }
  const generated = await fs.readJson(selected.path);
  const streaming = Array.isArray(generated.args) && generated.args.includes("--kv-resident");
  console.log(`KV streaming: ${streaming ? "on" : "off"} (inherited from upstream automatic setup).`);
  const installation = existing ?? config.strataInstallations?.find((item) => item.root === root);
  if (!installation) throw new Error("Strata registration missing");
  addSetupStrataProfile(config, installation.id, selected.path, Number(contextArg));
  if (await fs.pathExists(configFile)) {
    const backup = `${configFile}.setup-${Date.now()}.bak`;
    await fs.copy(configFile, backup, { overwrite: false, errorOnExist: true });
    console.log(`Config backup: ${backup}`);
  }
  await saveConfig(config);
  console.log('Created localhost-only profile "strata"; the active profile was not changed.');
}
