import { Scrollable } from "../../framework/widgets/Scrollable";
import { fg, fgBg } from "../../lib/theme";
import { getGlobal, getSlots, getStrataMetrics, onMetricsChange, type SlotMetrics } from "../../lib/metricstracker";
import { taskNumber, taskRate, taskTime } from "../../lib/taskformat";
import { formatMs, formatDraftRate, formatNum, spinnerChar, SPINNER_INTERVAL, cycleDetailLevel } from "../../lib/utils";
import type { Color } from "../../lib/theme";
import type { RenderContext, Size } from "../../framework/types";
import type { FramebufferCanvas } from "../../lib/framebuffer-canvas";

import type { DetailLevel } from "../../lib/utils";
export type MetricsDetailLevel = DetailLevel;

const STATE_COLOR: Record<string, Color> = {
  idle: "textMuted",
  prompting: "warning",
  generating: "success",
};

const THINKING_ICON = "\u221e";
const CONTEXT_BAR_WIDTH = 33;
type MetricRow = { text: string; color: Color }[];

function formatCtxNum(n: number): string {
  return n.toLocaleString("en-US");
}

function hasCtxData(s: SlotMetrics): boolean {
  return s.nCtxSlot !== null || s.contextSize > 0;
}

function hasSpeedData(s: SlotMetrics): boolean {
  if (s.state === "prompting") return true;
  if (s.state === "generating") return true;
  if (s.lastTask) return true;
  return false;
}

function slotHeight(s: SlotMetrics, level: MetricsDetailLevel): number {
  if (level === "basic") return 1;
  if (level === "middle") {
    return 3; // header + ctx bar + speeds always
  }
  // detailed
  let h = 1;
  if (hasCtxData(s)) h++;
  if (hasSpeedData(s)) h++;
  if (s.lastTask) h++;
  if (s.checkpoints.length > 0) h++;
  return h;
}

export class MetricsPanel extends Scrollable {
  focusable = false;
  protected _unsub: (() => void) | null = null;
  protected _renderTimer: ReturnType<typeof setTimeout> | null = null;
  protected _spinnerTimer: ReturnType<typeof setInterval> | null = null;
  protected _detailLevel: MetricsDetailLevel = "detailed";

  constructor() {
    super();
    this._unsub = onMetricsChange(() => {
      if (this._renderTimer) clearTimeout(this._renderTimer);
      this._renderTimer = setTimeout(() => {
        this.markDirty();
      }, 100);
    });
    this._spinnerTimer = setInterval(() => {
      this.markDirty();
    }, SPINNER_INTERVAL);
  }

  get detailLevel(): MetricsDetailLevel {
    return this._detailLevel;
  }

  set detailLevel(level: MetricsDetailLevel) {
    this._detailLevel = level;
    this.markDirty();
  }

  setDetailLevel(level: MetricsDetailLevel): void {
    this._detailLevel = level;
    this.markDirty();
  }

  cycleDetailLevel(): void {
    this._detailLevel = cycleDetailLevel(this._detailLevel);
    this.markDirty();
  }

  protected strataLines(): string[] {
    return this.strataRows().map(row => row.map(part => part.text).join(""));
  }

  protected strataRows(): MetricRow[] {
    const view = getStrataMetrics();
    if (!view) return [];
    const rows: MetricRow[] = [];
    const part = (text: string, color: Color = "textMuted") => ({ text, color });
    const pair = (left: MetricRow, right: MetricRow): MetricRow =>
      [...left, part(" ".repeat(Math.max(2, 42 - left.reduce((n, p) => n + p.text.length, 0))), "canvas"), ...right];
    const age = view.receivedAt === null ? "no snapshot" : `${Math.max(0, Math.floor((Date.now() - view.receivedAt) / 1000))}s old`;
    if (view.error) rows.push([part(`Telemetry unavailable: ${view.error} (${age}; last good data below)`, "warning")]);
    if (view.historyError) rows.push([part(`History recovery paused: ${view.historyError}`, "warning")]);
    if (view.missingRequests) rows.push([part(`History missing: ${view.missingRequests} completions; Tasks covers recovered rows only`, "warning")]);
    const m = view.snapshot;
    if (!m) return [...rows, [part("Waiting for Strata metrics")]];
    const completePromptTimes = m.kept === m.count && m.requests.every((r) => r.evaluatedInput !== null && r.promptMs !== null);
    const pp = completePromptTimes && m.evaluated !== null && m.promptMs !== null && m.promptMs > 0 ? m.evaluated * 1000 / m.promptMs : null;
    const pairs = m.requests.filter((r) => r.engineOutput !== null && r.decodeMs !== null && r.decodeMs > 0);
    const engineCount = pairs.reduce((sum, r) => sum + r.engineOutput!, 0);
    const decodeMs = pairs.reduce((sum, r) => sum + r.decodeMs!, 0);
    const tg = decodeMs > 0 ? engineCount * 1000 / decodeMs : null;
    const summary = [part("Session  Tasks "), part(String(m.count), "accent"), part("  ·  PP "), part(taskRate(pp), "info"),
      part("  ·  TG (history) "), part(taskRate(tg), "success")];
    if (this._detailLevel !== "basic") summary.push(part("  ·  Tokens "), part(taskNumber(m.evaluated), "info"),
      part(" / "), part(taskNumber(m.output), "success"));
    rows.push(summary);
    const draft = m.draftsAccepted !== null && m.draftsOffered !== null && m.draftsOffered > 0
      ? `${(m.draftsAccepted * 100 / m.draftsOffered).toFixed(1)}%` : "n/a";
    if (this._detailLevel !== "basic") {
      rows.push([part("  Draft "), part(draft, "accentColor"), part("  ·  Active "),
        part(taskNumber(m.live.running ?? (m.live.slots.length
          ? m.live.slots.filter(s => s.state !== "idle").length
          : m.live.state === "reading" || m.live.state === "generating" ? 1 : 0)), "warning"),
        part(`  ·  Queue ${taskNumber(m.live.queued)}`),
        ...(m.live.parallel !== null ? [part(`  ·  Parallel ${m.live.parallel}`)] : []),
        ...(m.live.waiting !== null ? [part(`  ·  Waiting ${m.live.waiting}`)] : []),
        part(`  ·  TG coverage ${pairs.length}/${m.count}  ·  ${age}`)]);
    }
    rows.push([]);
    const latest = m.requests[m.requests.length - 1];
    const slots = [...m.live.slots].sort((a, b) => a.slot - b.slot);
    // Stock history has no completed-slot identity. Only the service block can
    // retain the latest completion; never attach it to a sampled parallel slot.
    // With batch slots, a request alone runs on the solo path (all slots idle) and a new
    // one is read outside the slots before admission: stock reports those only as
    // outside_slots plus the top-level live fields (the newest request in flight).
    const busySlots = slots.filter(s => s.state !== "idle").length;
    const outside = m.live.outsideSlots ?? (m.live.running !== null ? Math.max(0, m.live.running - busySlots) : 0);
    const topBusy = m.live.state === "reading" || m.live.state === "generating";
    const topLevel = {
      state: m.live.state, prompt: m.live.promptRead, generated: m.live.generated,
      rate: m.live.rate, elapsed: m.live.elapsedSeconds, topLevel: true, held: null as number | null,
    };
    const activities = slots.length ? [
      ...(outside > 0 && topBusy ? [{ ...topLevel, label: busySlots ? "Admitting" : "Solo path", service: false,
        extra: outside > 1 ? `  +${outside - 1} outside slots` : "" }] : []),
      ...slots.map(s => ({
        label: `Slot ${s.slot}`, state: s.state, prompt: s.promptTokens, generated: s.generated,
        rate: s.rate, elapsed: s.elapsedSeconds, service: false, topLevel: false, held: s.heldTokens, extra: "",
      })),
    ] : [{ ...topLevel, label: "Service", service: true, extra: "" }];
    for (const activity of activities) {
      if (rows[rows.length - 1]!.length) rows.push([]);
      const prompting = activity.state === "reading";
      const generating = activity.state === "generating" || activity.state === "decoding";
      const idle = !prompting && !generating;
      if (idle && !activity.service) {
        rows.push([part(`${activity.label}  `), part("\u25cb idle", "textMuted"),
          ...(activity.held ? [part("  ·  holds "), part(taskNumber(activity.held), "info"), part(" tokens for a next turn")] : [])]);
        continue;
      }
      const last = activity.service ? latest : undefined;
      const promptRate = activity.service ? (!idle ? m.live.promptRate :
        last && last.evaluatedInput !== null && last.promptMs !== null && last.promptMs > 0
          ? last.evaluatedInput * 1000 / last.promptMs : null) : activity.topLevel && !idle ? m.live.promptRate : null;
      const genRate = generating ? activity.rate : idle ? last?.decodeRate ?? null : null;
      const header = [part(`${activity.label}  `), part(`${idle ? "\u25cb" : spinnerChar()} ${prompting ? "prompting" : generating ? "generating" : activity.state}`,
        prompting ? "warning" : generating ? "success" : "textMuted"), ...(activity.extra ? [part(activity.extra)] : [])];
      if (idle && last) header.push(part("  Last task #"), part(String(last.ordinal), "text"), part(`  ${last.finish ?? "n/a"}`));
      const speeds = pair([part("  PP   "), part(taskRate(promptRate), "info")],
        [part("TG   "), part(taskRate(genRate), "success"),
          ...(generating && activity.generated !== null ? [part(` (${activity.generated} tok)`)] : [])]);
      if (this._detailLevel === "basic") {
        rows.push([...header, part("  ·  PP "), part(taskRate(promptRate), "info"), part("  ·  TG "), part(taskRate(genRate), "success")]);
        continue;
      }
      rows.push(header);
      const total = activity.topLevel ? m.live.promptTotal ?? m.live.promptTokens : null;
      const promptValue = activity.topLevel && prompting && activity.prompt === null ? total : activity.prompt;
      const promptSuffix = !(activity.topLevel && prompting) ? ""
        : activity.prompt === null ? (total !== null ? " being read" : "")
        : ` / ${taskNumber(total)}${total ? ` (${Math.min(100, activity.prompt * 100 / total).toFixed(0)}%)` : ""} processed`;
      rows.push([part(idle ? "  In   " : "  Prompt "), part(taskNumber(idle && last ? last.evaluatedInput : promptValue), "info"),
        part(promptSuffix),
        part(idle ? "  ·  Out " : "  ·  Generated "), part(taskNumber(idle && last ? last.output : activity.generated), "success")]);
      rows.push(speeds);
      if (this._detailLevel === "detailed" && !idle) rows.push([part(`  Elapsed ${activity.elapsed === null ? "n/a" : `${activity.elapsed}s`}`)]);
      if (this._detailLevel === "detailed" && last) {
        const acceptance = last.draftsAccepted !== null && last.draftsOffered !== null && last.draftsOffered > 0
          ? `${(last.draftsAccepted * 100 / last.draftsOffered).toFixed(1)}% (${last.draftsAccepted}/${last.draftsOffered})` : "n/a";
        if (!idle) rows.push([part(`  Last task #${last.ordinal}  ${last.finish ?? "n/a"}`)]);
        rows.push(pair([part("  Time "), part(taskTime(last.totalMs), "text")],
          [part("Draft "), part(acceptance, "accentColor")]));
        rows.push([part(`  Last #${last.ordinal}  PT ${taskTime(last.promptMs)}  ET ${taskTime(last.decodeMs)}  Wall ${taskTime(last.wallMs)}  Finish ${last.finish ?? "n/a"}`)]);
        rows.push([part(`  Last input ${taskNumber(last.requestedInput)}  Cached ${taskNumber(last.cachedInput)}  In ${taskNumber(last.evaluatedInput)}  Out ${taskNumber(last.output)}  Engine ${taskNumber(last.engineOutput)}`)]);
      }
    }
    if (slots.length && latest && this._detailLevel !== "basic") {
      rows.push([], [part(`Last service completion #${latest.ordinal} (slot unavailable)  ${latest.finish ?? "n/a"}`)],
        pair([part("  PP   "), part(taskRate(latest.evaluatedInput !== null && latest.promptMs !== null && latest.promptMs > 0 ? latest.evaluatedInput * 1000 / latest.promptMs : null), "info")],
          [part("TG   "), part(taskRate(latest.decodeRate), "success")]),
        [part(`  In ${taskNumber(latest.evaluatedInput)}  Out ${taskNumber(latest.output)}  Time ${taskTime(latest.totalMs)}`)]);
    }
    return rows;
  }

  measure(parentSize?: Size): Size {
    if (getStrataMetrics()) {
      return { width: parentSize?.width ?? this.rect.width,
        height: Math.min(this.strataLines().length, parentSize?.height ?? 999) };
    }
    const slots = getSlots();
    const global = getGlobal();
    const numSlots = slots.length;
    const globalLines = global ? (this._detailLevel === "basic" ? 1 : 2) : 1;
    const gapAfterGlobal = numSlots > 0 ? 1 : 0;
    const slotLines = slots.reduce((sum, s) => sum + slotHeight(s, this._detailLevel), 0);
    const gapBetweenSlots = Math.max(0, numSlots - 1);
    const totalHeight = globalLines + gapAfterGlobal + slotLines + gapBetweenSlots;
    return {
      width: parentSize?.width ?? this.rect.width,
      height: Math.min(totalHeight, parentSize?.height ?? 999),
    };
  }

  draw(ctx: RenderContext): void {
    if (getStrataMetrics()) {
      const rows = this.strataRows();
      this.contentHeight = rows.length;
      for (let row = 0; row < this.rect.height; row++) {
        const parts = rows[this.scrollOffset + row];
        if (parts === undefined) break;
        ctx.canvas.moveTo(this.rect.x, this.rect.y + row);
        let remaining = this.contentWidth;
        for (const part of parts) {
          fg(ctx.canvas, part.color, part.text.slice(0, remaining));
          remaining = Math.max(0, remaining - part.text.length);
          if (!remaining) break;
        }
      }
      if (this.needsScrollbar) this.drawScrollbar(ctx.canvas, this.rect.x + this.contentWidth, this.rect.y, this._scrollbarWidth, this.rect.height);
      return;
    }
    const { canvas } = ctx;
    const { x, y } = this.rect;
    const viewportH = this.rect.height;
    const cw = this.contentWidth;
    const global = getGlobal();
    const slots = getSlots();
    const numSlots = slots.length;

    const globalLines = global ? (this._detailLevel === "basic" ? 1 : 2) : 1;
    const gapAfterGlobal = numSlots > 0 ? 1 : 0;
    const slotLines = slots.reduce((sum, s) => sum + slotHeight(s, this._detailLevel), 0);
    const gapBetweenSlots = Math.max(0, numSlots - 1);
    const contentH = globalLines + gapAfterGlobal + slotLines + gapBetweenSlots;
    this.contentHeight = contentH;

    const scrollOff = this.scrollOffset;
    const bottom = y + viewportH;

    let cy = 0;
    if (global) {
      // Global line 1: tasks, PP, TG (+ tokens in non-basic)
      if (cy - scrollOff + y < bottom) {
        canvas.moveTo(x, cy - scrollOff + y);
        fg(canvas, "textMuted", "Tasks ");
        fg(canvas, "accent", String(global.tasksCompleted));
        fg(canvas, "textMuted", `  ·  PP `);
        fg(canvas, "info", `${global.avgPromptSpeed.toFixed(1)} t/s`);
        fg(canvas, "textMuted", `  ·  TG `);
        fg(canvas, "success", `${global.avgGenSpeed.toFixed(1)} t/s`);
        if (this._detailLevel !== "basic") {
          fg(canvas, "textMuted", `  ·  Tokens `);
          fg(canvas, "info", `${formatNum(global.totalPromptTokens)}`);
          fg(canvas, "textMuted", " / ");
          fg(canvas, "success", `${formatNum(global.totalOutputTokens)}`);
        }
      }
      cy++;

      if (this._detailLevel !== "basic") {
        // Global line 2: draft, active
        if (cy - scrollOff + y < bottom) {
          canvas.moveTo(x, cy - scrollOff + y);
          fg(canvas, "textMuted", "  Draft ");
          fg(canvas, "accentColor", formatDraftRate(global.avgDraftAcceptance));
          if (global.activeSlots > 0) {
            fg(canvas, "textMuted", `  ·  Active `);
            fg(canvas, "warning", String(global.activeSlots));
          }
        }
        cy++;
      }
    } else {
      if (cy - scrollOff + y < bottom) {
        canvas.moveTo(x, cy - scrollOff + y);
        fg(canvas, "textMuted", "No session metrics yet");
        cy++;
      }
      cy++;
    }

    if (global && numSlots > 0) {
      cy += 1;
    }

    for (let i = 0; i < numSlots; i++) {
      const slot = slots[i];

      if (i > 0 && cy - scrollOff + y < bottom) {
        canvas.moveTo(x, cy - scrollOff + y);
        fg(canvas, "canvas", " ".repeat(cw));
        cy++;
      }

      if (cy - scrollOff + y >= bottom) break;

      const slotH = slotHeight(slot, this._detailLevel);
      this.renderSlot(canvas, x, cy - scrollOff + y, cw, slot);
      cy += slotH;
    }

    if (this.needsScrollbar) {
      this.drawScrollbar(canvas, x + cw, y, this._scrollbarWidth, viewportH);
    }
  }

  renderSlot(
    canvas: FramebufferCanvas,
    x: number,
    startY: number,
    width: number,
    slot: SlotMetrics
  ): void {
    const stateColor = STATE_COLOR[slot.state] || "textMuted";
    const dot = slot.state === "idle" ? "\u25cb" : spinnerChar();
    const isActive = slot.state !== "idle";
    const rightCol = 42;

    if (this._detailLevel === "basic") {
      // Single row: state + ctx numbers | PP | TG
      canvas.moveTo(x, startY);
      fg(canvas, "textMuted", `Slot ${slot.slotId}  `);
      fg(canvas, stateColor, `${dot} ${slot.state}`);
      if (slot.taskId !== null) {
        fg(canvas, "textMuted", `  Task #`);
        fg(canvas, "text", String(slot.taskId));
      }
      if (slot.thinking) {
        fg(canvas, "accentColor", `  ${THINKING_ICON}`);
      }

      // Ctx numbers (no bar)
      if (hasCtxData(slot)) {
        const limit = slot.nCtxSlot;
        if (limit !== null && limit > 0) {
          const used = slot.cachedTokens ?? slot.contextSize;
          fg(canvas, "textMuted", `  ·  Ctx `);
          fg(canvas, "text", `${formatCtxNum(used)} / ${formatCtxNum(limit)}`);
        } else if (slot.contextSize > 0) {
          fg(canvas, "textMuted", `  ·  Ctx `);
          fg(canvas, "text", `${formatCtxNum(slot.contextSize)}`);
        }
      }

      // Speeds inline
      const lt = slot.lastTask;
      const ppSpeed = slot.state === "prompting" ? slot.promptSpeed : lt?.promptSpeed ?? null;
      const tgSpeed = slot.state === "generating" ? slot.generationSpeed : lt?.outputSpeed ?? null;

      fg(canvas, "textMuted", `  ·  PP `);
      fg(canvas, "info", ppSpeed !== null ? `${ppSpeed.toFixed(1)} t/s` : "-");
      fg(canvas, "textMuted", `  ·  TG `);
      fg(canvas, "success", tgSpeed !== null ? `${tgSpeed.toFixed(1)} t/s` : "-");
      return;
    }

    // Middle and detailed: header row
    let cy = startY;
    canvas.moveTo(x, cy);
    fg(canvas, "textMuted", `Slot ${slot.slotId}  `);
    fg(canvas, stateColor, `${dot} ${slot.state}`);
    if (slot.taskId !== null) {
      fg(canvas, "textMuted", `  Task #`);
      fg(canvas, "text", String(slot.taskId));
    }
    if (slot.thinking) {
      fg(canvas, "accentColor", `  ${THINKING_ICON}`);
    }
    cy++;

    // Ctx bar (middle + detailed)
    canvas.moveTo(x, cy);
    fg(canvas, "textMuted", "  Ctx  ");
    if (hasCtxData(slot)) {
      const limit = slot.nCtxSlot;
      if (limit !== null && limit > 0) {
        const used = slot.cachedTokens ?? slot.contextSize;
        const usageRatio = used / limit;
        const barColor = usageRatio > 0.9 ? "danger" : usageRatio > 0.8 ? "warning" : isActive ? "success" : "textMuted";

        const exactFilled = usageRatio * CONTEXT_BAR_WIDTH;
        const fullBlocks = Math.min(Math.floor(exactFilled), CONTEXT_BAR_WIDTH);
        const remainder = Math.round((exactFilled - fullBlocks) * 8);
        const empty = CONTEXT_BAR_WIDTH - fullBlocks - (remainder > 0 ? 1 : 0);

        const partialBlocks = ["", "\u258F", "\u258E", "\u258D", "\u258C", "\u258B", "\u258A", "\u2589", "\u2588"];

        fgBg(canvas, barColor, barColor, " ".repeat(fullBlocks));
        if (remainder > 0) {
          fgBg(canvas, barColor, "border", partialBlocks[remainder]);
        }
        fgBg(canvas, "border", "border", " ".repeat(empty));

        fgBg(canvas, "textMuted", "surface", `  Used `);
        // fgBg() sets a persistent background color on the canvas that
        // otherwise bleeds into every subsequent write until something else
        // changes it (e.g. the "Used" label's "surface" background leaking
        // into the following text and even the next row/panel).
        canvas.setBackgroundColor("None");
        fg(canvas, "text", `${formatCtxNum(used)} / ${formatCtxNum(limit)}`);
      } else if (slot.contextSize > 0) {
        fg(canvas, "text", `${formatCtxNum(slot.contextSize)} tok`);
      }
    } else {
      fg(canvas, "textMuted", "-");
    }
    cy++;

    // Speeds (middle + detailed)
    canvas.moveTo(x, cy);
    const lt = slot.lastTask;

    const ppSpeed = slot.state === "prompting" ? slot.promptSpeed : lt?.promptSpeed ?? null;
    const tgSpeed = slot.state === "generating" ? slot.generationSpeed : lt?.outputSpeed ?? null;

    fg(canvas, "textMuted", "  PP   ");
    if (ppSpeed !== null) {
      const ppText = slot.state === "prompting" && slot.promptProgress !== null
        ? `${ppSpeed.toFixed(1)} t/s (${(slot.promptProgress * 100).toFixed(0)}%)`
        : `${ppSpeed.toFixed(1)} t/s`;
      fg(canvas, "info", ppText);
    } else {
      fg(canvas, "textMuted", "-");
    }

    const leftLen = 7 + (ppSpeed !== null
      ? (slot.state === "prompting" && slot.promptProgress !== null
        ? `${ppSpeed.toFixed(1)} t/s (${(slot.promptProgress * 100).toFixed(0)}%)`.length
        : `${ppSpeed.toFixed(1)} t/s`.length)
      : 1);
    const rightPad = Math.max(2, rightCol - leftLen);

    fg(canvas, "canvas", " ".repeat(rightPad));
    fg(canvas, "textMuted", "TG   ");
    if (tgSpeed !== null) {
      fg(canvas, "success", `${tgSpeed.toFixed(1)} t/s`);
      if (slot.state === "generating" && slot.decodedTokens !== null) {
        fg(canvas, "textMuted", ` (${slot.decodedTokens} tok)`);
      }
    } else {
      fg(canvas, "textMuted", "-");
    }
    cy++;

    // Middle mode stops here
    if (this._detailLevel === "middle") return;

    // Detailed: last task
    if (slot.lastTask) {
      canvas.moveTo(x, cy);
      const lt = slot.lastTask;

      fg(canvas, "textMuted", "  Time ");
      fg(canvas, "text", formatMs(lt.totalTimeMs));

      const leftLen = 7 + formatMs(lt.totalTimeMs).length;
      const rightPad = Math.max(2, rightCol - leftLen);

      fg(canvas, "canvas", " ".repeat(rightPad));
      fg(canvas, "textMuted", "Draft");
      if (lt.draftGenerated > 0) {
        fg(canvas, "accentColor", ` ${formatDraftRate(lt.draftAcceptance)} (${lt.draftAccepted}/${lt.draftGenerated})`);
        fg(canvas, "textMuted", "  Trunc ");
        fg(canvas, lt.truncated ? "danger" : "success", lt.truncated ? "yes" : "no");
      } else {
        fg(canvas, "textMuted", " No speculative decoding");
      }
      cy++;
    }

    // Detailed: checkpoints
    if (slot.checkpoints.length > 0) {
      canvas.moveTo(x, cy);
      const totalChkMiB = slot.checkpoints.reduce((s, cp) => s + cp.sizeMiB, 0);
      fg(canvas, "textMuted", "  Chk  ");
      fg(canvas, "accent", `${slot.checkpoints.length}`);
      fg(canvas, "textMuted", `  ${totalChkMiB.toFixed(1)} MiB`);
      cy++;
    }
  }

  onDestroy(): void {
    if (this._unsub) {
      this._unsub();
      this._unsub = null;
    }
    if (this._renderTimer) {
      clearTimeout(this._renderTimer);
      this._renderTimer = null;
    }
    if (this._spinnerTimer) {
      clearInterval(this._spinnerTimer);
      this._spinnerTimer = null;
    }
  }
}
