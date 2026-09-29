import { Control } from "../../framework/Control";
import { Column } from "../../framework/Layout";
import { Section } from "../../framework/widgets/Section";
import { fg, fgBg } from "../../lib/theme";
import { formatSize } from "../../lib/utils";
import { getSystemSnapshot } from "../../lib/systeminfo";
import { getStatus } from "../../lib/server";
import type { GpuTelemetrySourceSnapshot, SystemSnapshot } from "../../lib/systeminfo";
import type { Color } from "../../lib/theme";
import type { TabContext } from "../../lib/tabcontext";
import type { Size, RenderContext } from "../../framework/types";

const REFRESH_MS = 2000;
const BAR_WIDTH = 30;

function barColorFor(ratio: number): Color {
  if (ratio > 0.9) return "danger";
  if (ratio > 0.75) return "warning";
  return "success";
}

/** Draws a simple filled/empty block bar of `width` cells representing `ratio` (0-1). */
function drawBar(canvas: RenderContext["canvas"], x: number, y: number, width: number, ratio: number, color: Color): void {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(clamped * width);
  canvas.moveTo(x, y);
  if (filled > 0) fgBg(canvas, color, color, " ".repeat(filled));
  if (width - filled > 0) fgBg(canvas, "border", "border", " ".repeat(width - filled));
  // fgBg() sets a persistent background color on the canvas that otherwise
  // bleeds into every subsequent write (including unrelated text/labels on
  // later rows) until something else changes it. Reset it immediately after
  // the bar so the background doesn't leak past this widget - most visibly
  // when the bar is 100% filled with a single solid color.
  canvas.setBackgroundColor("None");
}

class SystemPanel extends Control {
  focusable = false;
  protected _ctx: TabContext | null = null;
  protected _snapshot: SystemSnapshot | null = null;
  protected _loading = true;
  protected _refreshTimer: ReturnType<typeof setTimeout> | null = null;
  protected _destroyed = false;
  protected _sourceIndex = 0;
  protected _onSourceChange: ((source: GpuTelemetrySourceSnapshot | null, count: number) => void) | null = null;

  constructor(ctx: TabContext) {
    super();
    this._ctx = ctx;
  }

  measure(parentSize?: Size): Size {
    return { width: parentSize?.width ?? this.rect.width, height: this.contentHeight() };
  }

  setOnSourceChange(callback: (source: GpuTelemetrySourceSnapshot | null, count: number) => void): void {
    this._onSourceChange = callback;
  }

  protected activeSource(): GpuTelemetrySourceSnapshot | null {
    const sources = this._snapshot?.gpuSources || [];
    if (sources.length === 0) return null;
    const available = sources.filter((source) => source.gpus.length > 0);
    const displaySources = available.length > 0 ? available : sources;
    const idx = ((this._sourceIndex % displaySources.length) + displaySources.length) % displaySources.length;
    return displaySources[idx] || null;
  }

  protected displaySourceCount(): number {
    const sources = this._snapshot?.gpuSources || [];
    const available = sources.filter((source) => source.gpus.length > 0);
    return (available.length > 0 ? available : sources).length;
  }

  cycleSource(delta: number): boolean {
    const count = this.displaySourceCount();
    if (count <= 1) return false;
    this._sourceIndex = ((this._sourceIndex + delta) % count + count) % count;
    this._onSourceChange?.(this.activeSource(), count);
    this.markDirty();
    return true;
  }

  protected contentHeight(): number {
    // CPU (1) + RAM (1) + optional shared sub-line + gap (1) + per-GPU
    // (util + dedicated + shared, +1 gap between) or error/loading lines,
    // then the optional systemwide/residency/pressure blocks.
    if (!this._snapshot) return 3;
    const source = this.activeSource();
    const gpus = source?.gpus || [];
    const gpuLines = gpus.length > 0
      ? gpus.length * 3 + (gpus.length - 1)
      : this.gpuErrorLines(source?.error || this._snapshot.gpuError).length;
    return 1 + 1 + this.sharedSubLines() + 1 + gpuLines + this.detailLines();
  }

  /** The "of which GPU" sub-line under RAM, shown only when shared VRAM is in use. */
  protected sharedSubLines(): number {
    const shared = this._snapshot?.sharedGpuRamBytes;
    return shared !== null && shared !== undefined && shared > 0 ? 1 : 0;
  }

  protected detailLines(): number {
    const snap = this._snapshot;
    if (!snap) return 0;
    let lines = 0;
    // Systemwide total (blank + line)
    if (snap.systemwideTotalBytes) lines += 2;
    // Model residency: blank + heading + 3 bars
    if (snap.residency) lines += 5;
    // Memory pressure: blank + commit bar + available + paging
    if (snap.pressure) lines += 4;
    return lines;
  }

  protected gpuErrorLines(error: string | null): string[] {
    const message = error || "No GPUs detected";
    return message.split("|").map((part) => part.trim()).filter(Boolean);
  }

  start(): void {
    this._destroyed = false;
    this.refresh();
  }

  stop(): void {
    this._destroyed = true;
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
      this._refreshTimer = null;
    }
  }

  protected refresh(): void {
    // The residency breakdown is per-process, so the running server's PID is
    // passed down and folded into the same counter query.
    const serverPid = getStatus().pid;
    getSystemSnapshot(this._ctx?.getConfig(), serverPid).then((snapshot) => {
      if (this._destroyed) return;
      this._snapshot = snapshot;
      const count = this.displaySourceCount();
      if (count > 0 && this._sourceIndex >= count) this._sourceIndex = 0;
      this._onSourceChange?.(this.activeSource(), count);
      this._loading = false;
      this.markDirty();
      this._refreshTimer = setTimeout(() => this.refresh(), REFRESH_MS);
    }).catch(() => {
      if (this._destroyed) return;
      this._refreshTimer = setTimeout(() => this.refresh(), REFRESH_MS);
    });
  }

  draw(ctx: RenderContext): void {
    const { canvas } = ctx;
    const { x, y } = this.rect;
    let cy = y;

    if (this._loading || !this._snapshot) {
      canvas.moveTo(x, cy);
      fg(canvas, "textMuted", "Collecting system stats...");
      return;
    }

    const snap = this._snapshot;
    const source = this.activeSource();
    const gpus = source?.gpus || [];
    const labelWidth = 18;

    // CPU
    canvas.moveTo(x, cy);
    fg(canvas, "textMuted", "CPU".padEnd(labelWidth));
    if (snap.cpuPercent !== null) {
      drawBar(canvas, x + labelWidth, cy, BAR_WIDTH, snap.cpuPercent / 100, barColorFor(snap.cpuPercent / 100));
      canvas.moveTo(x + labelWidth + BAR_WIDTH + 1, cy);
      fg(canvas, "text", `${snap.cpuPercent.toFixed(0)}%`);
    } else {
      fg(canvas, "textMuted", "n/a");
    }
    cy++;

    // RAM
    canvas.moveTo(x, cy);
    fg(canvas, "textMuted", "RAM".padEnd(labelWidth));
    const ramRatio = snap.ramTotalBytes > 0 ? snap.ramUsedBytes / snap.ramTotalBytes : 0;
    drawBar(canvas, x + labelWidth, cy, BAR_WIDTH, ramRatio, barColorFor(ramRatio));
    canvas.moveTo(x + labelWidth + BAR_WIDTH + 1, cy);
    fg(canvas, "text", `${formatSize(snap.ramUsedBytes)} / ${formatSize(snap.ramTotalBytes)}`);
    cy++;

    // Shared VRAM is an aperture onto this same RAM rather than extra memory,
    // so it is surfaced as a share of the RAM figure instead of being
    // subtracted from it (which would disagree with Task Manager).
    if (snap.sharedGpuRamBytes !== null && snap.sharedGpuRamBytes > 0) {
      canvas.moveTo(x, cy);
      fg(canvas, "textMuted", "  Shared".padEnd(labelWidth));
      fg(canvas, "text", formatSize(snap.sharedGpuRamBytes));
      fg(canvas, "textMuted", "  with GPU");
      cy++;
    }
    cy++;

    if (gpus.length === 0) {
      for (const line of this.gpuErrorLines(source?.error || snap.gpuError)) {
        canvas.moveTo(x, cy);
        fg(canvas, "textMuted", line.padEnd(this.rect.width).slice(0, this.rect.width));
        cy++;
      }
      this.drawDetails(ctx, cy, labelWidth);
      return;
    }

    for (let i = 0; i < gpus.length; i++) {
      const gpu = gpus[i]!;

      canvas.moveTo(x, cy);
      const gpuLabel = `${gpu.label} Util`;
      fg(canvas, "textMuted", gpuLabel.padEnd(labelWidth).slice(0, labelWidth));
      if (gpu.utilizationPercent !== null) {
        drawBar(canvas, x + labelWidth, cy, BAR_WIDTH, gpu.utilizationPercent / 100, barColorFor(gpu.utilizationPercent / 100));
        canvas.moveTo(x + labelWidth + BAR_WIDTH + 1, cy);
        fg(canvas, "text", `${gpu.utilizationPercent.toFixed(0)}%`);
        fg(canvas, "textMuted", ` · ${gpu.source}`);
      } else {
        fg(canvas, "textMuted", "n/a");
        fg(canvas, "textMuted", ` · ${gpu.source}`);
      }
      cy++;

      canvas.moveTo(x, cy);
      fg(canvas, "textMuted", "  Dedicated VRAM".padEnd(labelWidth));
      if (gpu.dedicatedUsedBytes !== null && gpu.dedicatedTotalBytes) {
        const ratio = gpu.dedicatedUsedBytes / gpu.dedicatedTotalBytes;
        drawBar(canvas, x + labelWidth, cy, BAR_WIDTH, ratio, barColorFor(ratio));
        canvas.moveTo(x + labelWidth + BAR_WIDTH + 1, cy);
        fg(canvas, "text", `${formatSize(gpu.dedicatedUsedBytes)} / ${formatSize(gpu.dedicatedTotalBytes)}`);
      } else if (gpu.dedicatedUsedBytes !== null) {
        fg(canvas, "text", `${formatSize(gpu.dedicatedUsedBytes)} used`);
        fg(canvas, "textMuted", " (capacity unknown)");
      } else {
        fg(canvas, "textMuted", "n/a");
      }
      cy++;

      canvas.moveTo(x, cy);
      fg(canvas, "textMuted", "  Shared VRAM".padEnd(labelWidth));
      if (gpu.sharedUsedBytes !== null && gpu.sharedTotalBytes) {
        const ratio = gpu.sharedUsedBytes / gpu.sharedTotalBytes;
        drawBar(canvas, x + labelWidth, cy, BAR_WIDTH, ratio, barColorFor(ratio));
        canvas.moveTo(x + labelWidth + BAR_WIDTH + 1, cy);
        fg(canvas, "text", `${formatSize(gpu.sharedUsedBytes)} / ${formatSize(gpu.sharedTotalBytes)}`);
      } else if (gpu.sharedUsedBytes !== null) {
        fg(canvas, "text", `${formatSize(gpu.sharedUsedBytes)} used`);
        fg(canvas, "textMuted", " (capacity unknown)");
      } else {
        fg(canvas, "textMuted", "n/a");
      }
      cy++;

      if (i < gpus.length - 1) cy++;
    }

    cy = this.drawDetails(ctx, cy, labelWidth);
  }

  /** Draws the systemwide total, model residency and memory pressure blocks. */
  protected drawDetails(ctx: RenderContext, startY: number, labelWidth: number): number {
    const { canvas } = ctx;
    const { x } = this.rect;
    const snap = this._snapshot;
    let cy = startY;
    if (!snap) return cy;

    if (snap.systemwideTotalBytes && snap.systemwideUsedBytes !== null) {
      cy++;
      canvas.moveTo(x, cy);
      fg(canvas, "textMuted", "Systemwide".padEnd(labelWidth));
      fg(canvas, "text", `${formatSize(snap.systemwideUsedBytes)} / ${formatSize(snap.systemwideTotalBytes)}`);
      fg(canvas, "textMuted", "  RAM + dedicated VRAM carve-out");
      cy++;
    }

    const res = snap.residency;
    if (res) {
      const total = res.committedBytes || 1;
      const pct = (bytes: number) => `${Math.round((bytes / total) * 100)}%`;
      cy++;
      canvas.moveTo(x, cy);
      fg(canvas, "textMuted", "Model residency".padEnd(labelWidth));
      fg(canvas, "text", formatSize(res.committedBytes));
      fg(canvas, "textMuted", `  committed by PID ${res.pid}`);
      cy++;

      const drawPart = (label: string, bytes: number, color: Color) => {
        canvas.moveTo(x, cy);
        fg(canvas, "textMuted", label.padEnd(labelWidth));
        drawBar(canvas, x + labelWidth, cy, BAR_WIDTH, bytes / total, color);
        canvas.moveTo(x + labelWidth + BAR_WIDTH + 1, cy);
        fg(canvas, "text", formatSize(bytes));
        fg(canvas, "textMuted", `  ${pct(bytes)}`);
        cy++;
      };
      drawPart("  Dedicated VRAM", res.dedicatedBytes, "success");
      drawPart("  Shared (RAM)", res.sharedBytes, "success");
      // Deliberately not called "evicted": this bucket is everything committed
      // that is not in GPU memory, and a measured part of it is resident in
      // host RAM. How much is genuinely paged/compressed cannot be attributed
      // per-process, so the label stays disjunctive. Always amber because it
      // is a proportion, not a budget - the usual 75/90% thresholds would be
      // meaningless here.
      drawPart("  Host RAM / paged", res.elsewhereBytes, "warning");
    }

    const pressure = snap.pressure;
    if (pressure) {
      const ratio = pressure.committedBytes / pressure.commitLimitBytes;
      cy++;
      canvas.moveTo(x, cy);
      fg(canvas, "textMuted", "Commit charge".padEnd(labelWidth));
      drawBar(canvas, x + labelWidth, cy, BAR_WIDTH, ratio, barColorFor(ratio));
      canvas.moveTo(x + labelWidth + BAR_WIDTH + 1, cy);
      fg(canvas, "text", `${formatSize(pressure.committedBytes)} / ${formatSize(pressure.commitLimitBytes)}`);
      fg(canvas, "textMuted", `  ${Math.round(ratio * 100)}%`);
      cy++;

      canvas.moveTo(x, cy);
      fg(canvas, "textMuted", "Available commit".padEnd(labelWidth));
      fg(canvas, "text", formatSize(pressure.availableCommitBytes));
      fg(canvas, "textMuted", "  headroom before a load fails");
      cy++;

      canvas.moveTo(x, cy);
      fg(canvas, "textMuted", "Paging".padEnd(labelWidth));
      if (pressure.pageReadsPerSec === null) {
        fg(canvas, "textMuted", "n/a");
      } else {
        // High commit alone is not a problem - evicted pages that are never
        // touched again cost nothing. The hard page-read rate is the only
        // signal that memory pressure is actually slowing the model down.
        const busy = pressure.pageReadsPerSec >= 50;
        fg(canvas, busy ? "warning" : "success", busy ? "paging" : "healthy");
        fg(canvas, "textMuted", `  ${pressure.pageReadsPerSec.toFixed(0)} page reads/s`);
        if (!busy) fg(canvas, "textMuted", " · evicted pages are cold");
      }
      cy++;
    }

    return cy;
  }
}

export class SystemControl extends Control {
  protected _ctx: TabContext | null = null;
  protected _column: Column;
  protected _section: Section;
  protected _panel: SystemPanel;

  constructor(ctx: TabContext) {
    super();
    this._ctx = ctx;

    this._panel = new SystemPanel(ctx);
    this._panel.setOnSourceChange((source, count) => {
      const cycleHint = count > 1 ? " · c/←/→ source" : "";
      this._section.hint = source
        ? `CPU · RAM · ${source.label}${cycleHint}`
        : `CPU · RAM · GPU/VRAM${cycleHint}`;
    });

    this._section = new Section();
    this._section.title = "System";
    this._section.hint = "CPU · RAM · GPU/VRAM";
    this._section.flex = 1;
    this._section.add(this._panel);

    this._column = new Column();
    this._column.add(this._section);
    this._column.flex = 1;

    this.add(this._column);
  }

  measure(parentSize?: Size): Size {
    return parentSize ? { width: parentSize.width, height: parentSize.height } : super.measure(parentSize);
  }

  onShow(): void {
    super.onShow();
    this._panel.start();
  }

  onHide(): void {
    super.onHide();
    this._panel.stop();
  }

  onInit(): void {
    if (this.visible) this._panel.start();
  }

  onDestroy(): void {
    this._panel.stop();
    this._ctx = null;
  }

  handleKey(key: string): boolean {
    if (key === "c" || key === "C" || key === "RIGHT") {
      return this._panel.cycleSource(1);
    }
    if (key === "LEFT") {
      return this._panel.cycleSource(-1);
    }
    return super.handleKey(key);
  }
}

export function createSystemTab(ctx: TabContext): Control {
  return new SystemControl(ctx);
}
