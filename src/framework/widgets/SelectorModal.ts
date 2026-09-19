import { Modal } from "./Modal";
import { Column, Row, createButtonRow } from "../Layout";
import { Button } from "./Button";
import { List, ListItem } from "./List";
import { Spacer } from "./Spacer";
import { StyledText } from "./StyledText";
import { modalManager } from "../ModalManager";
import { focusManager } from "../FocusManager";
import type { Size } from "../types";

export interface SelectorItem {
  id: string;
  label: string;
  sublabel?: string;
}

/** Width overhead added by modal borders/padding and the list's scrollbar column. */
const CHROME_WIDTH = 6;

export class SelectorModal extends Modal {
  protected _items: SelectorItem[] = [];
  protected _selectedId: string | null = null;
  protected _list: List<string, SelectorItem>;
  protected _buttonRow: Row;
  protected _preview: StyledText;

  setItems(items: SelectorItem[], selectedId: string | null): void {
    this._items = items;
    this._selectedId = selectedId;
    this._list.items = items.map((item) => ({
      id: item.id,
      label: item.label,
      sublabel: item.sublabel,
      data: item,
    }));
    this._list.selectedId = selectedId;
    const idx = items.findIndex((i) => i.id === selectedId);
    this._list.selectedIndex = idx >= 0 ? idx : 0;
    this.updatePreview();
  }

  constructor() {
    super();
    this._list = new List();
    this._list.flex = 1;
    this._list.truncate = "head";
    this._list.setOnSelect(() => this.confirm());
    this._list.setOnHighlight(() => this.updatePreview());

    this._preview = new StyledText();
    this._preview.truncate = "head";

    const okBtn = new Button({ label: "OK" });
    const cancelBtn = new Button({ label: "Cancel" });

    okBtn.setAction(() => this.confirm());
    cancelBtn.setAction(() => this.closeWithResult(null));

    this._buttonRow = createButtonRow(cancelBtn, okBtn);

    const column = new Column();
    column.add(this._list);
    const midSpacer = new Spacer();
    column.add(midSpacer);
    column.add(this._preview);
    const bottomSpacer = new Spacer();
    column.add(bottomSpacer);
    column.add(this._buttonRow);
    column.flex = 1;
    this.add(column);
  }

  /** Shows the full, untruncated-as-possible name of the highlighted item so long
   *  filenames remain identifiable even when the list column truncates them. */
  protected updatePreview(): void {
    const item = this._list.getSelectedItem();
    this._preview.builder.text("");
    if (item) {
      this._preview.builder.accentColor(item.label);
      if (item.sublabel) {
        this._preview.builder.muted(`  ${item.sublabel}`);
      }
    }
    this.markDirty();
  }

  measure(parentSize?: Size): Size {
    let widest = 0;
    for (const item of this._items) {
      const len = item.label.length + (item.sublabel ? item.sublabel.length + 2 : 0);
      if (len > widest) widest = len;
    }
    const contentWidth = widest + CHROME_WIDTH;
    const availableWidth = parentSize ? parentSize.width - 4 : this._maxWidth;
    const w = Math.max(this._minWidth, Math.min(contentWidth, this._maxWidth, availableWidth));
    const h = Math.max(this._minHeight, Math.min(this._items.length + 8, 22));
    return this._clampSize({ width: w, height: h });
  }

  onFocus(): void {
    super.onFocus();
    focusManager.setFocus(this._list);
  }

  handleKey(key: string): boolean {
    if (key === "RETURN" || key === "ENTER") {
      this.confirm();
      return true;
    }
    if (key === "ESCAPE") {
      this.closeWithResult(null);
      return true;
    }
    return super.handleKey(key);
  }

  protected confirm(): void {
    const item = this._list.getSelectedItem();
    this.closeWithResult(item ? item.id : null);
  }

  public closeWithResult(result: string | null): void {
    super.closeWithResult(result);
  }
}

export function createSelectorModal(
  title: string,
  items: SelectorItem[],
  selectedId: string | null,
): Promise<string | null> {
  return new Promise((resolve) => {
    const modal = new SelectorModal();
    modal.title = title;
    modal.setMinSize(30, 8);
    modal.setMaxSize(80, 22);
    modal.setItems(items, selectedId);
    modal.setResolve(resolve);
    modal.setOnClose(() => modal.closeWithResult(null));
    modalManager.open(modal);
  });
}
