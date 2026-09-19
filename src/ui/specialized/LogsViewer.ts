import { Scrollable } from "../../framework/widgets/Scrollable";
import { fg, fgBg } from "../../lib/theme";
import { renderLogLine, renderLogSegments, wrapLogLine } from "../../lib/logcolors";
import type { LogSegment } from "../../lib/logcolors";
import type { Point, Size, RenderContext } from "../../framework/types";
import type { FramebufferCanvas } from "../../lib/framebuffer-canvas";

export interface LogsViewerConfig {
  getLines: () => string[];
  emptyMessage?: string;
}

export interface LogSearchMatchInfo {
  current: number;
  total: number;
}

export class LogsViewer extends Scrollable {
  focusable = true;
  protected _config: LogsViewerConfig;
  protected _autoScroll = true;
  protected _wrap = false;
  protected _wrappedRows: LogSegment[][] = [];
  protected _wrapRowLine: number[] = [];
  protected _wrapLineStartRow: number[] = [];
  protected _wrapWidth = 0;
  protected _wrapLineCount = -1;

  protected _searchQuery = "";
  protected _matchLines: number[] = [];
  protected _matchCursor = -1;

  constructor(config: LogsViewerConfig) {
    super();
    this._config = config;
  }

  get wrap(): boolean { return this._wrap; }

  toggleWrap(): void {
    this._wrap = !this._wrap;
    this._wrapWidth = 0; // force rewrap on next layout
    this._wrapLineCount = -1;
    this.markDirty();
  }

  get searchQuery(): string { return this._searchQuery; }

  get matchInfo(): LogSearchMatchInfo | null {
    if (!this._searchQuery || this._matchLines.length === 0) return null;
    return { current: this._matchCursor + 1, total: this._matchLines.length };
  }

  /** Sets the active search query, recomputes matches over the current log
   *  lines, and jumps to the first match at/after the current scroll position
   *  (wrapping to the first match overall if none found after). Returns the
   *  resulting match info (null if the query is empty or has no matches). */
  setSearchQuery(query: string): LogSearchMatchInfo | null {
    this._searchQuery = query.trim();
    this.recomputeMatches();
    if (this._matchLines.length === 0) {
      this._matchCursor = -1;
      this.markDirty();
      return null;
    }
    const anchorLine = this.topLineIndex();
    let idx = this._matchLines.findIndex((l) => l >= anchorLine);
    if (idx === -1) idx = 0;
    this._matchCursor = idx;
    this.jumpToCurrentMatch();
    return this.matchInfo;
  }

  clearSearch(): void {
    this._searchQuery = "";
    this._matchLines = [];
    this._matchCursor = -1;
    this.markDirty();
  }

  /** Moves to the next (direction=1) or previous (direction=-1) match,
   *  wrapping around. Returns null if there is no active search/matches. */
  findNext(direction: 1 | -1): LogSearchMatchInfo | null {
    if (this._matchLines.length === 0) return null;
    this._matchCursor = (this._matchCursor + direction + this._matchLines.length) % this._matchLines.length;
    this.jumpToCurrentMatch();
    return this.matchInfo;
  }

  protected recomputeMatches(): void {
    if (!this._searchQuery) {
      this._matchLines = [];
      return;
    }
    const needle = this._searchQuery.toLowerCase();
    const lines = this._config.getLines();
    this._matchLines = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.toLowerCase().includes(needle)) this._matchLines.push(i);
    }
  }

  /** Raw log-line index corresponding to the topmost visible row. */
  protected topLineIndex(): number {
    if (!this._wrap) return this.scrollOffset;
    return this._wrapRowLine[this.scrollOffset] ?? 0;
  }

  protected jumpToCurrentMatch(): void {
    if (this._matchCursor < 0 || this._matchCursor >= this._matchLines.length) return;
    const lineIdx = this._matchLines[this._matchCursor]!;
    const rowIdx = this._wrap ? (this._wrapLineStartRow[lineIdx] ?? 0) : lineIdx;
    const centered = Math.max(0, rowIdx - Math.floor(this._viewportHeight / 2));
    this._autoScroll = false;
    this.scrollOffset = Math.max(0, Math.min(centered, this.maxScrollOffset));
    this.markDirty();
  }

  measure(parentSize?: Size): Size {
    return { width: parentSize?.width ?? this.rect.width, height: parentSize?.height ?? this.rect.height };
  }

  onLayout(): void {
    this._viewportHeight = this.rect.height;
    const lines = this._config.getLines();
    const prevContentHeight = this.contentHeight;

    if (this._wrap) {
      const cw = this.contentWidth;
      if (cw !== this._wrapWidth || lines.length !== this._wrapLineCount) {
        this._wrapWidth = cw;
        this._wrapLineCount = lines.length;
        this._wrappedRows = [];
        this._wrapRowLine = [];
        this._wrapLineStartRow = [];
        for (let i = 0; i < lines.length; i++) {
          this._wrapLineStartRow.push(this._wrappedRows.length);
          const rows = wrapLogLine(lines[i]!, cw);
          for (const row of rows) {
            this._wrappedRows.push(row);
            this._wrapRowLine.push(i);
          }
        }
      }
      this.contentHeight = this._wrappedRows.length;
    } else {
      this.contentHeight = lines.length;
    }

    const maxScroll = this.maxScrollOffset;
    if (this._autoScroll || this.scrollOffset > maxScroll) {
      this._autoScroll = true;
      this.scrollOffset = maxScroll;
    } else {
      this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));
    }

    if (prevContentHeight !== this.contentHeight) {
      this.markDirty();
    }
  }

  scrollToBottom(): void {
    this._autoScroll = true;
    this.scrollOffset = this.maxScrollOffset;
    this.markDirty();
  }

  draw(ctx: RenderContext): void {
    const canvas = ctx.canvas;
    const { x, y, width, height } = this.rect;

    if (height <= 0) return;

    const totalLines = this._wrap ? this._wrappedRows.length : this._config.getLines().length;
    const cw = this.contentWidth;
    const currentMatchLine = this._matchCursor >= 0 ? this._matchLines[this._matchCursor] : undefined;
    const matchLineSet = this._matchLines.length > 0 ? new Set(this._matchLines) : null;

    if (totalLines === 0 && this._config.emptyMessage) {
      const midY = y + Math.floor(height / 2);
      const pad = Math.max(0, Math.floor((cw - this._config.emptyMessage.length) / 2));
      canvas.moveTo(x + pad, midY);
      fg(canvas, "textMuted", this._config.emptyMessage);
    } else if (this._wrap) {
      for (let i = 0; i < height; i++) {
        const rowIdx = this.scrollOffset + i;
        if (rowIdx >= 0 && rowIdx < totalLines) {
          const lineIdx = this._wrapRowLine[rowIdx];
          this.drawRow(canvas, x, y + i, cw, () => renderLogSegments(canvas, x, y + i, cw, this._wrappedRows[rowIdx]!), lineIdx, currentMatchLine, matchLineSet);
        }
      }
    } else {
      const lines = this._config.getLines();
      for (let i = 0; i < height; i++) {
        const lineIdx = this.scrollOffset + i;
        if (lineIdx >= 0 && lineIdx < totalLines) {
          this.drawRow(canvas, x, y + i, cw, () => renderLogLine(canvas, x, y + i, cw, lines[lineIdx]!), lineIdx, currentMatchLine, matchLineSet);
        }
      }
    }

    if (this.needsScrollbar) {
      this.drawScrollbar(canvas, x + cw, y, this._scrollbarWidth, height);
    }
  }

  /** Draws one row's background highlight (if it's the current or another
   *  search match) before delegating to `renderFn` for the actual text. Always
   *  explicitly sets (or clears) the background so a highlight from an earlier
   *  row in the same draw pass never bleeds into a later, non-matching row. */
  protected drawRow(canvas: FramebufferCanvas, x: number, rowY: number, width: number, renderFn: () => void, lineIdx: number | undefined, currentMatchLine: number | undefined, matchLineSet: Set<number> | null): void {
    const isMatch = !!(matchLineSet && lineIdx !== undefined && matchLineSet.has(lineIdx));
    if (isMatch) {
      canvas.moveTo(x, rowY);
      const isCurrent = lineIdx === currentMatchLine;
      fgBg(canvas, "canvas", isCurrent ? "accent" : "warning", " ".repeat(width));
    } else {
      canvas.setBackgroundColor("None");
    }
    renderFn();
  }

  protected tryScroll(delta: number): boolean {
    const newOffset = this.scrollOffset + delta;
    if (newOffset < 0 || newOffset > this.maxScrollOffset) return false;
    this.scrollOffset = newOffset;
    if (this.scrollOffset === this.maxScrollOffset) {
      this._autoScroll = true;
    } else {
      this._autoScroll = false;
    }
    this.markDirty();
    return true;
  }

  handleKey(key: string): boolean {
    if (this.contentHeight === 0) return false;

    if (key === "UP" || key === "k") {
      if (this.scrollOffset > 0) {
        this._autoScroll = false;
        this.scrollOffset--;
        this.markDirty();
        return true;
      }
      return false;
    }
    if (key === "DOWN" || key === "j") {
      return this.tryScroll(1);
    }
    if (key === "PAGE_UP") {
      if (this.canScrollUp()) {
        this._autoScroll = false;
      }
      return super.handleKey(key);
    }
    if (key === "PAGE_DOWN") {
      return this.tryScroll(this._viewportHeight - 1);
    }
    if (key === "HOME") {
      if (this.scrollOffset !== 0) {
        this._autoScroll = false;
        this.scrollOffset = 0;
        this.markDirty();
      }
      return true;
    }
    if (key === "END") {
      if (this.scrollOffset !== this.maxScrollOffset) {
        this._autoScroll = true;
        this.scrollOffset = this.maxScrollOffset;
        this.markDirty();
      }
      return true;
    }
    return super.handleKey(key);
  }

  onMouseWheel(_point: Point, direction: 'up' | 'down'): boolean {
    if (this.contentHeight === 0) return false;
    if (direction === 'up' && this.scrollOffset > 0) {
      this._autoScroll = false;
      this.scrollOffset--;
      this.markDirty();
      return true;
    }
    if (direction === 'down') {
      return this.tryScroll(1);
    }
    return false;
  }

  onMouseDown(point: Point): boolean {
    if (!this.needsScrollbar) return false;

    const sx = this.rect.x + this.contentWidth;
    const sw = this._scrollbarWidth;

    if (point.x >= sx && point.x < sx + sw) {
      const trackTop = this.rect.y;
      const trackHeight = this.rect.height;
      const clickY = point.y - trackTop;
      const thumbMinHeight = 2;
      const ratio = this._viewportHeight / this.contentHeight;
      const thumbHeight = Math.max(thumbMinHeight, Math.floor(ratio * trackHeight));
      const maxThumbPos = trackHeight - thumbHeight;

      if (maxThumbPos <= 0) return false;

      const newOffset = Math.floor((clickY / maxThumbPos) * this.maxScrollOffset);
      this.scrollOffset = Math.max(0, Math.min(this.maxScrollOffset, newOffset));
      this._autoScroll = this.scrollOffset === this.maxScrollOffset;
      this.markDirty();
      return true;
    }

    return false;
  }
}
