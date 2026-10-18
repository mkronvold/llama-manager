import { Control } from "../../framework/Control";
import { Column, Row } from "../../framework/Layout";
import { Button } from "../../framework/widgets/Button";
import { Spacer } from "../../framework/widgets/Spacer";
import { Section } from "../../framework/widgets/Section";
import { Checkbox } from "../../framework/widgets/Checkbox";
import { SettingsPanel } from "../specialized/SettingsPanel";
import { ProfileList } from "../specialized/ProfileList";
import { StyledText } from "../../framework/widgets/StyledText";
import { focusManager } from "../../framework/FocusManager";
import path from "node:path";
import fs from "fs-extra";
import { ConfigData, DEFAULT_PRESETS, ServerPresets, ServerProfile, getModelsDir, isStrataProfile, saveConfig } from "../../lib/config";
import type { StrataInstallation, StrataProfileBinding } from "../../lib/runtime";
import { inspectStrata } from "../../lib/strata";
import {
  buildStrataProfile,
  describeStrataProfileStatus,
  effectiveStrataSettings,
  findStrataInstallation,
  getStrataProfileStatus,
  listStrataConfigFiles,
  readStrataConfigSummary,
  strataExposureWarning,
} from "../../lib/strataprofile";
import {
  StrataOpBlockedError,
  describeStrataOp,
  finalizeStrataOp,
  isActiveStrataOp,
  listStrataOps,
  reconcileStrataOp,
  startStrataOp,
  type StrataOpAction,
  type StrataOpMarker,
} from "../../lib/strataops";
import { readConfigVramReserve, readStrataOverrideWarnings, tuneConfiguredStrataConfigs } from "../../lib/strataconfigure";
import { isStrataInstallationInUse } from "../../lib/server";
import { createSelectorModal } from "../../framework/widgets/SelectorModal";
import { WrappedTextView, type TextLine } from "../specialized/WrappedTextView";
import { fireAsync } from "../../lib/utils";
import type { TabContext } from "../../lib/tabcontext";
import type { Size } from "../../framework/types";
import { createConfirmDialog } from "../../framework/widgets/ConfirmDialog";
import { createInputDialog } from "../../framework/widgets/InputDialog";

export class ServerControl extends Control {
  protected _ctx: TabContext | null = null;
  protected _column: Column;
  protected _buttonRow: Row;
  protected _buttons: Button[];
  protected _section: Section;
  protected _settingsPanel: SettingsPanel;
  protected _profileList: ProfileList;
  protected _summary: StyledText;
  protected _backButton: Button;
  protected _advancedCheckbox: Checkbox;
  protected _showingSettings = false;
  protected _strataSection: Section;
  protected _strataView: WrappedTextView;
  protected _strataButtons: Button[];
  protected _bindButton: Button;
  protected _opTimer: ReturnType<typeof setInterval> | null = null;
  protected _polling = false;
  protected _detailsSeq = 0;
  protected _editingName: string | null = null;

  constructor(ctx: TabContext) {
    super();
    this._ctx = ctx;

    this._summary = new StyledText();
    this._summary.flex = 1;

    this._buttons = [
      new Button({ label: "Create" }),
      new Button({ label: "Duplicate" }),
      new Button({ label: "Rename" }),
      new Button({ label: "Delete" }),
    ];

    this._strataButtons = [
      new Button({ label: "Check" }),
      new Button({ label: "Configure" }),
      new Button({ label: "Refresh" }),
    ];
    for (const btn of this._strataButtons) btn.visible = false;
    this._bindButton = new Button({ label: "Strata Config" });
    this._bindButton.visible = false;

    this._backButton = new Button({ label: "Back" });
    this._backButton.visible = false;
    this._backButton.setAction(() => {
      this.showProfileList();
    });

    this._advancedCheckbox = new Checkbox({ label: "Advanced options" });
    this._advancedCheckbox.visible = false;

    this._buttonRow = new Row();
    this._buttonRow.add(this._backButton);
    this._buttonRow.add(this._summary);
    const spacer = new Spacer();
    spacer.flex = 1;
    this._buttonRow.add(spacer);
    for (const btn of this._buttons) {
      this._buttonRow.add(btn);
    }
    for (const btn of this._strataButtons) {
      this._buttonRow.add(btn);
    }
    this._buttonRow.add(this._bindButton);
    this._buttonRow.add(this._advancedCheckbox);

    this._settingsPanel = new SettingsPanel();
    this._settingsPanel.flex = 1;
    this._settingsPanel.visible = false;
    this._settingsPanel.setTabContext(this._ctx);
    this._settingsPanel.setMessageCallback((msg: string) => {
      this._ctx?.showMessage(msg);
    });
    this._settingsPanel.setOnEscape(() => {
      this.showProfileList();
    });
    this._settingsPanel.setOnChange(() => {
      const config = this._ctx?.getConfig();
      if (config && isStrataProfile(config.server.profiles[this.shownProfileName(config)])) this.refreshStrataDetails();
    });

    this._advancedCheckbox.setAction((checked: boolean) => {
      this._settingsPanel.setAdvancedMode(checked);
    });

    this._profileList = new ProfileList();
    this._profileList.flex = 1;
    this._profileList.setSelectCallback((name: string) => {
      this.switchProfile(name);
    });
    this._profileList.setEditCallback((name: string) => {
      this.showSettings(name);
    });

    this._section = new Section();
    this._section.title = "Available Profiles";
    this._section.flex = 1;
    this._section.add(this._settingsPanel);
    this._section.add(this._profileList);

    this._strataView = new WrappedTextView();
    this._strataView.flex = 1;
    this._strataSection = new Section();
    this._strataSection.title = "Strata";
    this._strataSection.flex = 1;
    this._strataSection.visible = false;
    this._strataSection.add(this._strataView);

    this._column = new Column();
    this._column.add(this._buttonRow);
    this._column.add(new Spacer());
    this._column.add(this._section);
    this._column.add(this._strataSection);

    this.add(this._column);
  }

  measure(parentSize?: Size): Size {
    return parentSize ? { width: parentSize.width, height: parentSize.height } : super.measure(parentSize);
  }

  onInit(): void {
    if (!this._ctx) return;

    this._buttons[0]?.setAction(() => {
      this.createProfile();
    });

    this._buttons[1]?.setAction(() => {
      this.duplicateProfile();
    });

    this._buttons[2]?.setAction(() => {
      this.renameProfile();
    });

    this._buttons[3]?.setAction(() => {
      this.deleteProfile();
    });

    this._strataButtons[0]?.setAction(() => this.runStrataTool("check"));
    this._strataButtons[1]?.setAction(() => this.runStrataTool("configure"));
    this._strataButtons[2]?.setAction(() => this.refreshStrataInstallation());
    this._bindButton.setAction(() => this.selectStrataBinding());

    this.refreshConfig();
  }

  onDestroy(): void {
    this.stopOpPolling();
    this._ctx = null;
  }

  handleKey(key: string): boolean {
    if (this._showingSettings && key === "ESC") {
      this.showProfileList();
      return true;
    }
    return super.handleKey(key);
  }

  onFocus(): void {
    super.onFocus();
    if (this._showingSettings) {
      focusManager.setFocus(this._settingsPanel);
    } else {
      focusManager.setFocus(this._profileList);
    }
  }

  refreshConfig(): void {
    const config = this._ctx?.getConfig();
    if (!config) return;

    const count = Object.keys(config.server.profiles).length;
    this._settingsPanel.setConfig(config);
    this._profileList.setConfig(config);
    const isDefault = config.server.activeProfile === "Default";
    this._buttons[2].disabled = isDefault;
    this._buttons[3].disabled = isDefault;
    this.updateStrataControls();
    this._summary.builder
      .muted("Profiles ")
      .accentColor(String(count))
      .muted("  Current ")
      .text(config.server.activeProfile);
    this.markDirty();
  }

  showProfileList(): void {
    this._showingSettings = false;
    this._editingName = null;
    this._settingsPanel.visible = false;
    this._advancedCheckbox.visible = false;
    this._profileList.visible = true;
    this._section.title = "Available Profiles";
    this._settingsPanel.setEditingProfile(null);
    this._backButton.visible = false;
    for (const btn of this._buttons) btn.visible = true;
    const config = this._ctx?.getConfig();
    if (config) this._profileList.setConfig(config, true);
    this.updateStrataControls();
    focusManager.setFocus(this._profileList);
    this.markDirty();
  }

  showSettings(profileName?: string): void {
    this._showingSettings = true;
    this._editingName = profileName ?? null;
    this._settingsPanel.visible = true;
    this._advancedCheckbox.visible = true;
    this._profileList.visible = false;
    this._backButton.visible = true;
    for (const btn of this._buttons) btn.visible = false;
    const config = this._ctx?.getConfig();
    if (config) {
      this._settingsPanel.setConfig(config);
      this._settingsPanel.setEditingProfile(profileName ?? null);
    }
    this._section.title = `Edit Profile - ${profileName || config?.server.activeProfile || ""}`;
    this.updateStrataControls();
    focusManager.setFocus(this._settingsPanel);
    this.markDirty();
  }

  switchProfile(name: string): void {
    const config = this._ctx?.getConfig();
    if (!config) return;

    config.server.activeProfile = name;
    this.persist(config, `Switched to profile: ${name}`);
    this.refreshConfig();
  }

  /** Saves without leaving a rejected promise unhandled. */
  protected persist(config: ConfigData, success: string): void {
    saveConfig(config)
      .then(() => this._ctx?.showMessage(success))
      .catch((e) => this._ctx?.showMessage(`Error saving: ${e instanceof Error ? e.message : String(e)}`));
  }

  createProfile(): void {
    const config = this._ctx?.getConfig();
    if (!config) return;

    fireAsync(async () => {
      const runtime = await createSelectorModal("Profile runtime", [
        { id: "llama", label: "llama.cpp", sublabel: "llama-server compatible versions" },
        { id: "strata", label: "Strata", sublabel: "registered Strata installation" },
      ], "llama");
      if (!runtime) return;
      let profile: ServerProfile | undefined;
      if (runtime === "strata") {
        const binding = await this.pickStrataBinding(config, null);
        if (!binding) return;
        profile = buildStrataProfile(config.server.profiles[config.server.activeProfile], binding);
      } else if (isStrataProfile(config.server.profiles[config.server.activeProfile])) {
        profile = { presets: JSON.parse(JSON.stringify(DEFAULT_PRESETS)) as ServerPresets, freeFormArgs: [] };
      }
      const name = await this._ctx!.openModal<string | null>(
        createInputDialog("Create Profile", "Profile name", runtime === "strata" ? "strata" : "")
      );
      if (!name) return;
      this.commitCreateProfile(name, config, profile);
    }, this._ctx!);
  }

  duplicateProfile(): void {
    const config = this._ctx?.getConfig();
    if (!config) return;

    fireAsync(async () => {
      const name = await this._ctx!.openModal<string | null>(
        createInputDialog("Duplicate Profile", "New profile name", `${config.server.activeProfile} copy`)
      );
      if (!name) return;
      this.commitCreateProfile(name, config);
    }, this._ctx!);
  }

  commitCreateProfile(name: string, config: ConfigData, profile?: ServerProfile): void {
    name = name.trim();
    if (!name) {
      this._ctx?.showMessage("Profile name cannot be empty");
      return;
    }
    if (name === "Default") {
      this._ctx?.showMessage("Cannot use 'Default' as a profile name");
      return;
    }
    if (config.server.profiles[name]) {
      this._ctx?.showMessage(`Profile '${name}' already exists`);
      return;
    }

    const current = config.server.profiles[config.server.activeProfile];
    if (!current && !profile) return;

    config.server.profiles[name] = profile ?? JSON.parse(JSON.stringify(current));
    config.server.activeProfile = name;

    const created = config.server.profiles[name];
    const warning = isStrataProfile(created) ? strataExposureWarning(created) : null;
    this.persist(config, warning ? `Created profile: ${name}. Warning: ${warning}` : `Created profile: ${name}`);
    this.refreshConfig();
  }

  renameProfile(): void {
    const config = this._ctx?.getConfig();
    if (!config) return;

    if (config.server.activeProfile === "Default") {
      this._ctx?.showMessage("Default profile cannot be renamed");
      return;
    }

    fireAsync(async () => {
      const name = await this._ctx!.openModal<string | null>(
        createInputDialog("Rename Profile", "New name", config.server.activeProfile)
      );
      if (!name) return;
      this.commitRenameProfile(name, config);
    }, this._ctx!);
  }

  commitRenameProfile(name: string, config: ConfigData): void {
    name = name.trim();
    if (!name) {
      this._ctx?.showMessage("Profile name cannot be empty");
      return;
    }
    if (name === "Default") {
      this._ctx?.showMessage("Cannot use 'Default' as a profile name");
      return;
    }
    if (name === config.server.activeProfile) {
      return;
    }
    if (config.server.profiles[name]) {
      this._ctx?.showMessage(`Profile '${name}' already exists`);
      return;
    }

    const current = config.server.profiles[config.server.activeProfile];
    if (!current) return;

    config.server.profiles[name] = current;
    delete config.server.profiles[config.server.activeProfile];
    config.server.activeProfile = name;

    this.persist(config, `Renamed profile to: ${name}`);

    this.refreshConfig();
  }

  deleteProfile(): void {
    const config = this._ctx?.getConfig();
    if (!config) return;

    if (config.server.activeProfile === "Default") {
      this._ctx?.showMessage("Cannot delete Default profile");
      return;
    }

    const profiles = config.server.profiles;
    const keys = Object.keys(profiles);
    if (keys.length <= 1) {
      this._ctx?.showMessage("Cannot delete the only profile");
      return;
    }

    fireAsync(async () => {
      const confirmed = await this._ctx!.openModal<boolean>(createConfirmDialog(
        "Delete Profile",
        `Delete profile "${config.server.activeProfile}"? This cannot be undone.`
      ));
      if (!confirmed) return;

      const oldName = config.server.activeProfile;
      delete profiles[oldName];
      config.server.activeProfile = "Default";

      this.persist(config, `Deleted profile "${oldName}", switched to Default`);

      this.refreshConfig();
    }, this._ctx!);
  }

  // --- Strata profiles ---

  protected shownProfileName(config: ConfigData): string {
    return (this._showingSettings && this._editingName) || config.server.activeProfile;
  }

  protected updateStrataControls(): void {
    const config = this._ctx?.getConfig();
    if (!config) return;
    const strata = isStrataProfile(config.server.profiles[this.shownProfileName(config)]);
    for (const btn of this._strataButtons) btn.visible = strata && !this._showingSettings;
    this._bindButton.visible = strata && this._showingSettings;
    this._advancedCheckbox.visible = this._showingSettings && !strata;
    this._strataSection.visible = strata;
    if (strata) this.refreshStrataDetails();
    else this.stopOpPolling();
    this.markDirty();
  }

  protected refreshStrataDetails(fromTimer = false): void {
    const ctx = this._ctx;
    if (!ctx || (fromTimer && this._polling)) return;
    const seq = ++this._detailsSeq;
    this._polling = true;
    fireAsync(async () => {
      try {
        const lines = await this.buildStrataLines();
        if (seq !== this._detailsSeq || !this._ctx) return;
        this._strataView.setLines(lines);
        this.markDirty();
      } finally {
        if (seq === this._detailsSeq) this._polling = false;
      }
    }, ctx);
  }

  protected async buildStrataLines(): Promise<TextLine[]> {
    const config = this._ctx?.getConfig();
    if (!config) return [];
    const name = this.shownProfileName(config);
    const profile = config.server.profiles[name];
    if (!isStrataProfile(profile)) return [];
    const binding = profile.strata;
    const installation = findStrataInstallation(config, binding.installationId);
    const status = await getStrataProfileStatus(config, binding);
    const server = profile.presets.server;
    const lines: TextLine[] = [
      { text: `Profile ${name}: ${describeStrataProfileStatus(status)}`, color: status.kind === "ok" ? "success" : "warning" },
      { text: `Installation: ${installation?.root ?? `${binding.installationId} (not registered)`}` },
      { text: `Config: ${binding.configPath ?? "(none selected)"}` },
    ];
    let configHasKey = false;
    if (binding.configPath && status.kind === "ok") {
      const summary = await readStrataConfigSummary(binding.configPath);
      configHasKey = summary.hasConfigApiKey;
      if (summary.error) {
        lines.push({ text: `Config unreadable: ${summary.error}`, color: "danger" });
      } else {
        lines.push({ text: `Model: ${summary.model ?? "unknown"}   Backend: ${summary.backend ?? "unknown"}` });
        lines.push({
          text: `Endpoint: ${server.host}:${server.port} (profile)` +
            (summary.configPort !== null && summary.configPort !== server.port ? `; overrides config port ${summary.configPort}` : ""),
        });
        lines.push({ text: `API key: ${server.apiKey ? "profile key" : configHasKey ? "Strata config key" : "none"}` });
        lines.push({ text: "" });
        const overrides = binding.overrides;
        lines.push({
          text: overrides
            ? "Engine settings (profile overrides marked; others change with Configure):"
            : "Requested engine settings (read-only; change them with Configure):",
          color: "text",
        });
        for (const item of effectiveStrataSettings(summary.settings, overrides)) {
          lines.push({ text: `  ${item.key.padEnd(22)} ${item.value}`, ...(item.profile ? { color: "accent" as const } : {}) });
        }
        for (const w of await readStrataOverrideWarnings(binding.configPath, overrides)) {
          lines.push({ text: `Warning: ${w}`, color: "warning" });
        }
      }
    } else {
      lines.push({ text: `Endpoint: ${server.host}:${server.port} (profile)` });
    }
    const warning = strataExposureWarning(profile, configHasKey);
    if (warning) lines.push({ text: `Warning: ${warning}`, color: "warning" });
    if (installation) {
      const ops = await this.latestOps(installation);
      if (ops.length) lines.push({ text: "" });
      for (const op of ops) {
        lines.push({ text: `${describeStrataOp(op)}  (${new Date(op.startedAt).toLocaleString()})`, color: opColor(op) });
      }
      if (ops.some(isActiveStrataOp)) this.startOpPolling();
      else this.stopOpPolling();
    }
    lines.push({ text: "" });
    lines.push({ text: "Strata Start/Stop is not available yet; this profile cannot be launched.", color: "textMuted" });
    return lines;
  }

  /** Latest Check and Configure run for an installation, advanced to their current state. */
  protected async latestOps(installation: StrataInstallation): Promise<StrataOpMarker[]> {
    const markers = await listStrataOps(installation.id);
    const latest: StrataOpMarker[] = [];
    for (const action of ["configure", "check"] as StrataOpAction[]) {
      const marker = markers.find((m) => m.action === action);
      if (!marker) continue;
      let next = await reconcileStrataOp(marker);
      let tuning = "";
      next = await finalizeStrataOp(next, async () => {
        if (action === "configure") tuning = await this.tuneConfiguredConfigs(installation, next.startedAt);
        const inspection = await inspectStrata(installation.root);
        return {
          ready: inspection.ready,
          detail: inspection.issues[0] ?? inspection.configs.find((c) => c.issues.length)?.issues[0],
        };
      });
      if (isActiveStrataOp(marker) && !isActiveStrataOp(next)) {
        this._ctx?.showMessage(describeStrataOp(next) + (tuning ? `; ${tuning}` : ""));
      }
      latest.push(next);
    }
    return latest;
  }

  /** Reapplies the manager's tuning to configs a finished Configure run wrote; returns a short summary. */
  protected async tuneConfiguredConfigs(installation: StrataInstallation, startedAt: string): Promise<string> {
    const files = await listStrataConfigFiles(installation.root);
    const results = await tuneConfiguredStrataConfigs(files, Date.parse(startedAt));
    const parts = results.map((r) => `${path.basename(r.file)}: ${r.error ? `tuning failed (${r.error})` : r.changes.join("; ") || "no tuning needed"}`);
    return parts.join(" | ");
  }

  protected startOpPolling(): void {
    if (this._opTimer) return;
    this._opTimer = setInterval(() => this.refreshStrataDetails(true), 2000);
  }

  protected stopOpPolling(): void {
    if (!this._opTimer) return;
    clearInterval(this._opTimer);
    this._opTimer = null;
  }

  protected runStrataTool(action: StrataOpAction): void {
    const ctx = this._ctx;
    const config = ctx?.getConfig();
    if (!ctx || !config) return;
    const profile = config.server.profiles[config.server.activeProfile];
    if (!isStrataProfile(profile)) return;
    fireAsync(async () => {
      const installation = findStrataInstallation(config, profile.strata.installationId);
      if (!installation) {
        ctx.showMessage("This profile's Strata installation is not registered; use Edit > Strata Config");
        return;
      }
      const python = path.join(installation.root, ".venv", "Scripts", "python.exe");
      if (!(await fs.pathExists(python))) {
        ctx.showMessage("Strata Python environment is missing; run START-HERE.bat in the installation first");
        return;
      }
      if (action === "configure") {
        const confirmed = await ctx.openModal<boolean>(createConfirmDialog(
          "Configure Strata",
          "Open Strata setup in a new window? It asks which model and settings to use and may download large files. " +
            `GGUF files are reused from or downloaded to ${getModelsDir(config)}. ` +
            "When it finishes, llama-manager reapplies its tuning (prefill, conversation cache, and KV cache in VRAM " +
            "when the last load measured room for it). No model is started.",
        ));
        if (!confirmed) return;
      }
      try {
        const marker = await startStrataOp(installation, python, action, {
          isServiceUsingInstallation: isStrataInstallationInUse,
          modelsDir: getModelsDir(config),
          vramReserveMib: action === "configure" ? await readConfigVramReserve(profile.strata.configPath) : null,
        });
        ctx.showMessage(marker.state === "failed"
          ? describeStrataOp(marker)
          : `Strata ${action === "check" ? "Check" : "Configure"} opened in a new window`);
      } catch (error) {
        if (error instanceof StrataOpBlockedError) ctx.showMessage(error.message);
        else throw error;
      }
      this.refreshStrataDetails();
    }, ctx);
  }

  protected refreshStrataInstallation(): void {
    const ctx = this._ctx;
    const config = ctx?.getConfig();
    if (!ctx || !config) return;
    const profile = config.server.profiles[config.server.activeProfile];
    if (!isStrataProfile(profile)) return;
    fireAsync(async () => {
      const installation = findStrataInstallation(config, profile.strata.installationId);
      if (!installation) {
        ctx.showMessage("This profile's Strata installation is not registered");
        return;
      }
      ctx.showMessage("Inspecting Strata installation…");
      const inspection = await inspectStrata(installation.root);
      ctx.showMessage(`Strata: ${inspection.configs.length} config(s), ` +
        (inspection.ready ? "usable" : `configuration incomplete${inspection.issues[0] ? ` (${inspection.issues[0]})` : ""}`));
      this.refreshStrataDetails();
    }, ctx);
  }

  protected async pickStrataBinding(
    config: ConfigData,
    current: StrataProfileBinding | null,
  ): Promise<StrataProfileBinding | null> {
    const installs = config.strataInstallations ?? [];
    if (!installs.length) {
      this._ctx?.showMessage("Register a Strata installation in Versions first");
      return null;
    }
    let installation: StrataInstallation | undefined = installs[0];
    if (installs.length > 1 || (current && !findStrataInstallation(config, current.installationId))) {
      const id = await createSelectorModal(
        "Strata installation",
        installs.map((item) => ({ id: item.id, label: item.root })),
        current?.installationId ?? installs[0]!.id,
      );
      if (!id) return null;
      installation = installs.find((item) => item.id === id);
    }
    if (!installation) return null;
    const files = await listStrataConfigFiles(installation.root);
    if (!files.length) {
      this._ctx?.showMessage("No generated Strata config yet; use Configure on this profile");
      return { installationId: installation.id, configPath: null };
    }
    if (files.length === 1 && !current) return { installationId: installation.id, configPath: files[0]! };
    const summaries = await Promise.all(files.map((file) => readStrataConfigSummary(file)));
    const chosen = await createSelectorModal(
      "Strata model config",
      [
        ...summaries.map((s) => ({ id: s.path, label: path.basename(s.path), sublabel: s.model ?? s.error ?? "" })),
        { id: "__none__", label: "(no config)", sublabel: "choose one after Configure" },
      ],
      current?.configPath ?? files[0]!,
    );
    if (!chosen) return null;
    return { installationId: installation.id, configPath: chosen === "__none__" ? null : chosen };
  }

  protected selectStrataBinding(): void {
    const ctx = this._ctx;
    const config = ctx?.getConfig();
    if (!ctx || !config) return;
    const name = this.shownProfileName(config);
    const profile = config.server.profiles[name];
    if (!isStrataProfile(profile)) return;
    fireAsync(async () => {
      const binding = await this.pickStrataBinding(config, profile.strata);
      if (!binding) return;
      profile.strata = binding;
      this.persist(config, `Profile ${name} uses ${binding.configPath ? path.basename(binding.configPath) : "no config"}`);
      this.refreshStrataDetails();
    }, ctx);
  }
}

function opColor(op: StrataOpMarker): TextLine["color"] {
  switch (op.state) {
    case "completed": return "success";
    case "failed":
    case "abandoned": return "danger";
    case "incomplete": return "warning";
    default: return "info";
  }
}

export function createServerTab(ctx: TabContext): Control {
  return new ServerControl(ctx);
}
