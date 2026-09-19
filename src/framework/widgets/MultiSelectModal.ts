import { Modal } from "./Modal";
import { Column, Row, createButtonRow } from "../Layout";
import { Button } from "./Button";
import { Checkbox } from "./Checkbox";
import { Spacer } from "./Spacer";
import { modalManager } from "../ModalManager";
import { focusManager } from "../FocusManager";
import type { Size } from "../types";

export interface MultiSelectItem {
  id: string;
  label: string;
}

/**
 * A modal that presents a checklist of options and resolves with the array of
 * selected item ids (or null if cancelled). Used for fields whose flag accepts
 * a comma-separated list of values (e.g. --spec-type).
 */
export class MultiSelectModal extends Modal {
  protected _items: MultiSelectItem[] = [];
  protected _checkboxes: Checkbox[] = [];
  protected _checkboxColumn: Column;
  protected _buttonRow: Row;

  constructor() {
    super();
    this._checkboxColumn = new Column();

    const okBtn = new Button({ label: "OK" });
    const cancelBtn = new Button({ label: "Cancel" });
    okBtn.setAction(() => this.confirm());
    cancelBtn.setAction(() => this.closeWithResult(null));
    this._buttonRow = createButtonRow(cancelBtn, okBtn);

    const column = new Column();
    column.add(this._checkboxColumn);
    const spacer = new Spacer();
    spacer.flex = 1;
    column.add(spacer);
    column.add(this._buttonRow);
    column.flex = 1;
    this.add(column);
  }

  setItems(items: MultiSelectItem[], selectedIds: string[]): void {
    this._items = items;
    this._checkboxColumn.clear();
    this._checkboxes = [];
    const selectedSet = new Set(selectedIds);
    for (const item of items) {
      const cb = new Checkbox({ label: item.label, checked: selectedSet.has(item.id) });
      this._checkboxes.push(cb);
      this._checkboxColumn.add(cb);
    }
  }

  measure(parentSize?: Size): Size {
    let widest = 0;
    for (const item of this._items) {
      if (item.label.length > widest) widest = item.label.length;
    }
    const w = Math.max(this._minWidth, Math.min(widest + 10, this._maxWidth));
    const h = Math.max(this._minHeight, Math.min(this._items.length + 7, 26));
    return this._clampSize({ width: w, height: h });
  }

  onFocus(): void {
    super.onFocus();
    if (this._checkboxes.length > 0) {
      focusManager.setFocus(this._checkboxes[0]!);
    }
  }

  handleKey(key: string): boolean {
    if (key === "ESCAPE") {
      this.closeWithResult(null);
      return true;
    }
    return super.handleKey(key);
  }

  protected confirm(): void {
    const result = this._items
      .filter((_item, idx) => this._checkboxes[idx]?.checked)
      .map((item) => item.id);
    this.closeWithResult(result);
  }

  public closeWithResult(result: string[] | null): void {
    super.closeWithResult(result);
  }
}

export function createMultiSelectModal(
  title: string,
  items: MultiSelectItem[],
  selectedIds: string[],
): Promise<string[] | null> {
  return new Promise((resolve) => {
    const modal = new MultiSelectModal();
    modal.title = title;
    modal.hint = "tab move · space/enter toggle";
    modal.setMinSize(30, 8);
    modal.setMaxSize(80, 26);
    modal.setItems(items, selectedIds);
    modal.setResolve(resolve);
    modal.setOnClose(() => modal.closeWithResult(null));
    modalManager.open(modal);
  });
}
