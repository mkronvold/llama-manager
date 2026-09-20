import { Control } from "../../framework/Control";
import { Column } from "../../framework/Layout";
import { Section } from "../../framework/widgets/Section";
import { fg, fgBg } from "../../lib/theme";
import { formatSize } from "../../lib/utils";
import { getSystemSnapshot } from "../../lib/systeminfo";
import type { SystemSnapshot } from "../../lib/systeminfo";
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
}

class SystemPanel extends Control {
  focusable = false;
  protected _ctx: TabContext | null = null;
  protected _snapshot: SystemSnapshot | null = null;
  protected _loading = true;
  protected _refreshTimer: ReturnType<typeof setTimeout> | null = null;
  protected _destroyed = false;

  constructor(ctx: TabContext) {
    super();
    this._ctx = ctx;
  }

  measure(parentSize?: Size): Size {
    return { width: parentSize?.width ?? this.rect.width, height: this.contentHeight() };
  }

  protected contentHeight(): number {
    // CPU (1) + RAM (1) + gap (1) + per-GPU (util + dedicated + shared, +1 gap between) or 1-line error/loading
    if (!this._snapshot) return 3;
    const gpuLines = this._snapshot.gpus.length > 0
      ? this._snapshot.gpus.length * 3 + (this._snapshot.gpus.length - 1)
      : 1;
    return 1 + 1 + 1 + gpuLines;
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
    getSystemSnapshot(this._ctx?.getConfig()).then((snapshot) => {
      if (this._destroyed) return;
      this._snapshot = snapshot;
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
    cy++;

    if (snap.gpus.length === 0) {
      canvas.moveTo(x, cy);
      fg(canvas, "textMuted", snap.gpuError || "No GPUs detected");
      return;
    }

    for (let i = 0; i < snap.gpus.length; i++) {
      const gpu = snap.gpus[i]!;

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
      } else {
        fg(canvas, "textMuted", "n/a");
      }
      cy++;

      if (i < snap.gpus.length - 1) cy++;
    }
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
}

export function createSystemTab(ctx: TabContext): Control {
  return new SystemControl(ctx);
}
