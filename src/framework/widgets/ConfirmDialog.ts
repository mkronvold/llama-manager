import { Modal } from "./Modal";
import { Control } from "../Control";
import { Column, Row, createButtonRow } from "../Layout";
import { Button } from "./Button";
import { Spacer } from "./Spacer";
import { fg } from "../../lib/theme";
import type { RenderContext, Size } from "../types";

class ConfirmMessage extends Control {
  focusable = false;
  protected _message = "";
  protected _lines: string[] = [];

  set message(v: string) {
    this._message = v;
    this._lines = this.wrapLines(v, 72);
    this.markDirty();
  }

  get lines(): string[] {
    return this._lines;
  }

  protected wrapLines(text: string, width: number): string[] {
    const lines: string[] = [];
    for (const rawLine of text.split("\n")) {
      if (rawLine.length <= width) {
        lines.push(rawLine);
        continue;
      }
      let remaining = rawLine;
      while (remaining.length > width) {
        let cut = remaining.lastIndexOf(" ", width);
        if (cut <= 0) cut = width;
        lines.push(remaining.slice(0, cut));
        remaining = remaining.slice(cut).trimStart();
      }
      lines.push(remaining);
    }
    return lines.length > 0 ? lines : [""];
  }

  measure(_parentSize?: Size): Size {
    const width = Math.max(1, ...this._lines.map((line) => line.length));
    return { width, height: this._lines.length };
  }

  draw(ctx: RenderContext): void {
    const { canvas } = ctx;
    const { x, y, width, height } = this.rect;
    for (let i = 0; i < height; i++) {
      canvas.moveTo(x, y + i);
      const line = this._lines[i] || "";
      fg(canvas, "text", line.padEnd(width).slice(0, width));
    }
  }
}

export class ConfirmDialog extends Modal {
  protected _message = "";
  protected _contentColumn: Column;
  protected _messageLabel: ConfirmMessage;
  protected _buttonRow: Row;

  set message(v: string) {
    this._message = v;
    this._messageLabel.message = v;
    this.markDirty();
  }

  constructor() {
    super();
    this._contentColumn = new Column();
    this._messageLabel = new ConfirmMessage();

    const yesBtn = new Button({ label: "Yes" });
    const noBtn = new Button({ label: "No" });

    yesBtn.setAction(() => this.closeWithResult(true));
    noBtn.setAction(() => this.closeWithResult(false));

    this._buttonRow = createButtonRow(yesBtn, noBtn);

    this._contentColumn.add(this._messageLabel);
    const spacer1 = new Spacer();
    spacer1.flex = 1;
    this._contentColumn.add(spacer1);
    this._contentColumn.add(this._buttonRow);
    this._contentColumn.flex = 1;

    this.add(this._contentColumn);
  }

  measure(parentSize?: Size): Size {
    const lines = this._messageLabel.lines;
    const messageWidth = Math.max(0, ...lines.map((line) => line.length));
    const w = Math.max(this._minWidth, messageWidth + 8);
    const h = Math.max(this._minHeight, 8 + lines.length);
    return this._clampSize({ width: w, height: h });
  }

  public closeWithResult(result: boolean): void {
    super.closeWithResult(result);
  }
}

export function createConfirmDialog(title: string, message: string): ConfirmDialog {
  const dialog = new ConfirmDialog();
  dialog.title = title;
  dialog.setMinSize(30, 9);
  dialog.setMaxSize(80, 25);
  dialog.message = message;
  return dialog;
}
