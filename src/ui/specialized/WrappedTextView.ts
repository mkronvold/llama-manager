import { Scrollable } from "../../framework/widgets/Scrollable";
import { fg } from "../../lib/theme";
import type { Color } from "../../lib/theme";
import type { RenderContext, Size } from "../../framework/types";

export interface TextLine {
  text: string;
  color?: Color;
}

/** Read-only, character-wrapped, scrollable list of colored text lines. */
export class WrappedTextView extends Scrollable {
  focusable = false;
  protected _source: TextLine[] = [];
  protected _lines: TextLine[] = [];

  measure(parentSize?: Size): Size {
    return { width: parentSize?.width ?? this.rect.width, height: parentSize?.height ?? this._lines.length };
  }

  onLayout(): void {
    super.onLayout();
    this.wrap();
  }

  setLines(lines: TextLine[]): void {
    this._source = lines;
    this.scrollOffset = 0;
    this.wrap();
  }

  protected wrap(): void {
    const width = Math.max(1, this.contentWidth || 80);
    this._lines = this._source.flatMap((line) => {
      if (!line.text) return [{ text: "", color: line.color }];
      const chunks: TextLine[] = [];
      for (let start = 0; start < line.text.length; start += width) {
        chunks.push({ text: line.text.slice(start, start + width), color: line.color });
      }
      return chunks;
    });
    this.contentHeight = this._lines.length;
    this.markDirty();
  }

  draw(ctx: RenderContext): void {
    const canvas = ctx.canvas;
    const { x, y, height } = this.rect;
    const cw = this.contentWidth;
    for (let i = 0; i < height; i++) {
      canvas.moveTo(x, y + i);
      const line = this._lines[i + this.scrollOffset];
      fg(canvas, line?.color ?? "textMuted", (line?.text ?? "").padEnd(cw).substring(0, cw));
    }
    if (this.needsScrollbar) this.drawScrollbar(canvas, x + cw, y, this._scrollbarWidth, height);
  }
}
