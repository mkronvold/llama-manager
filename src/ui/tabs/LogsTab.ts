import { Control } from "../../framework/Control";
import { focusManager } from "../../framework/FocusManager";
import { Section } from "../../framework/widgets/Section";
import { createConfirmDialog } from "../../framework/widgets/ConfirmDialog";
import { createInputDialog } from "../../framework/widgets/InputDialog";
import { LogsViewer } from "../specialized/LogsViewer";
import { serverLogLines, onServerLog, clearServerLog, getCurrentLogFile } from "../../lib/server";
import { copyToClipboard } from "../../lib/clipboard";
import { fireAsync } from "../../lib/utils";
import type { TabContext } from "../../lib/tabcontext";
import type { Size } from "../../framework/types";

export class LogsControl extends Control {
  protected _ctx: TabContext | null = null;
  protected _section: Section;
  protected _logsControl: LogsViewer;
  protected _logUnsub: (() => void) | null = null;
  protected _logRenderTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(ctx: TabContext) {
    super();
    this._ctx = ctx;

    this._section = new Section();
    this._section.title = "Logs";
    this._section.hint = "scroll to navigate · c/del clear · w wrap · f/ find · p path";
    this._section.flex = 1;
    // Logs are frequently multi-line-selected in the terminal to copy for
    // troubleshooting; the decorative left border bar would get swept into
    // that selection on every row, so it's disabled here.
    this._section.showLeftBorder = false;

    this._logsControl = new LogsViewer({
      getLines: () => serverLogLines,
      emptyMessage: "Start the server to see logs",
    });
    this._logsControl.flex = 1;

    this._section.add(this._logsControl);
    this.add(this._section);
  }

  measure(parentSize?: Size): Size {
    return parentSize ? { width: parentSize.width, height: parentSize.height } : super.measure(parentSize);
  }

  onInit(): void {
    this._logUnsub = onServerLog(() => {
      if (this._logRenderTimer) clearTimeout(this._logRenderTimer);
      this._logRenderTimer = setTimeout(() => {
        this.markDirty();
      }, 200);
    });
    this.markDirty();
  }

  onDestroy(): void {
    if (this._logUnsub) {
      this._logUnsub();
      this._logUnsub = null;
    }
    if (this._logRenderTimer) {
      clearTimeout(this._logRenderTimer);
      this._logRenderTimer = null;
    }
    this._ctx = null;
  }

  onFocus(): void {
    super.onFocus();
    focusManager.setFocus(this._logsControl);
  }

  handleKey(key: string): boolean {
    if (key === "c" || key === "C" || key === "DELETE") {
      this.clearLogs();
      return true;
    }
    if (key === "w" || key === "W") {
      this._logsControl.toggleWrap();
      this._ctx?.showMessage(this._logsControl.wrap ? "Wrap: on" : "Wrap: off");
      return true;
    }
    if (key === "f" || key === "F" || key === "/") {
      this.openSearch();
      return true;
    }
    if (key === "p" || key === "P") {
      this.copyLogPath();
      return true;
    }
    if (key === "n" && this._logsControl.searchQuery) {
      this.reportMatch(this._logsControl.findNext(1));
      return true;
    }
    if (key === "N" && this._logsControl.searchQuery) {
      this.reportMatch(this._logsControl.findNext(-1));
      return true;
    }
    if (key === "ESCAPE" && this._logsControl.searchQuery) {
      this._logsControl.clearSearch();
      this._ctx?.showMessage("Search cleared");
      return true;
    }
    if (this._logsControl.handleKey(key)) return true;
    return super.handleKey(key);
  }

  protected openSearch(): void {
    if (!this._ctx) return;
    fireAsync(async () => {
      const result = await this._ctx!.openModal<string | null>(createInputDialog(
        "Find in Logs",
        "search text...",
        this._logsControl.searchQuery,
      ));
      if (result === null) return;
      this.reportMatch(this._logsControl.setSearchQuery(result));
    }, this._ctx);
  }

  protected reportMatch(info: { current: number; total: number } | null): void {
    if (!info) {
      this._ctx?.showMessage(`No matches for "${this._logsControl.searchQuery}"`);
      return;
    }
    this._ctx?.showMessage(`Match ${info.current}/${info.total} · n next · N prev · esc clear`);
  }

  protected copyLogPath(): void {
    if (!this._ctx) return;
    const logFile = getCurrentLogFile(this._ctx.getConfig());
    if (!logFile) {
      this._ctx.showMessage("No log file yet — start the server first");
      return;
    }
    fireAsync(async () => {
      const ok = await copyToClipboard(logFile);
      if (ok) {
        this._ctx?.showMessage(`Copied to clipboard: ${logFile}`);
        return;
      }
      // Clipboard tool unavailable (e.g. no xclip on headless Linux) - fall
      // back to a dialog with the path pre-filled so the user can select
      // and copy it manually from the terminal.
      await this._ctx!.openModal<string | null>(createInputDialog(
        "Log File Path",
        "",
        logFile,
      ));
    }, this._ctx);
  }

  protected clearLogs(): void {
    if (!this._ctx) return;
    if (serverLogLines.length === 0) {
      this._ctx.showMessage("Log is already empty");
      return;
    }
    fireAsync(async () => {
      const confirmed = await this._ctx!.openModal<boolean>(createConfirmDialog(
        "Clear Logs",
        "Clear all server log output? This cannot be undone.",
      ));
      if (!confirmed) return;
      clearServerLog();
      this.markDirty();
      this._ctx?.showMessage("Logs cleared");
    }, this._ctx);
  }
}

export function createLogsTab(ctx: TabContext): Control {
  return new LogsControl(ctx);
}
