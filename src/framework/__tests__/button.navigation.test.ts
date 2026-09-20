import { describe, it, expect, beforeEach } from "vitest";
import { Row } from "../Layout";
import { Button } from "../widgets/Button";
import { focusManager } from "../FocusManager";

// Regression coverage for arrow-key navigation between buttons in a
// horizontal button row (as used by ExitDialog, ConfirmDialog, InputDialog,
// and every other dialog built with createButtonRow()/createSplitButtonRow()
// in Layout.ts). Enter/Space activation and Tab/Shift-Tab navigation already
// worked; Left/Right (and h/l) previously did nothing while a Button was
// focused because Button.handleKey() called FocusManager.handleNavKeys()
// without bidirectional=true.
describe("Button arrow-key navigation in a horizontal Row", () => {
  let row: Row;
  let cancelBtn: Button;
  let okBtn: Button;
  let okPressed = false;
  let cancelPressed = false;

  beforeEach(() => {
    okPressed = false;
    cancelPressed = false;
    row = new Row();
    cancelBtn = new Button({ label: "Cancel" });
    okBtn = new Button({ label: "OK" });
    cancelBtn.setAction(() => { cancelPressed = true; });
    okBtn.setAction(() => { okPressed = true; });
    row.add(cancelBtn);
    row.add(okBtn);
    focusManager.setRoot(row);
    focusManager.setFocus(cancelBtn);
  });

  it("moves focus with Right/l and Left/h between buttons", () => {
    expect(focusManager.getFocused()).toBe(cancelBtn);

    cancelBtn.handleKey("RIGHT");
    expect(focusManager.getFocused()).toBe(okBtn);

    okBtn.handleKey("LEFT");
    expect(focusManager.getFocused()).toBe(cancelBtn);

    cancelBtn.handleKey("l");
    expect(focusManager.getFocused()).toBe(okBtn);

    okBtn.handleKey("h");
    expect(focusManager.getFocused()).toBe(cancelBtn);
  });

  it("still moves focus with Up/Down (k/j), unaffected by the bidirectional change", () => {
    cancelBtn.handleKey("DOWN");
    expect(focusManager.getFocused()).toBe(okBtn);

    okBtn.handleKey("UP");
    expect(focusManager.getFocused()).toBe(cancelBtn);
  });

  it("activates the focused button with Enter/Return/Space, not arrow keys", () => {
    cancelBtn.handleKey("RIGHT"); // move focus to okBtn, should not activate anything
    expect(okPressed).toBe(false);
    expect(cancelPressed).toBe(false);

    okBtn.handleKey("ENTER");
    expect(okPressed).toBe(true);
    expect(cancelPressed).toBe(false);
  });

  it("does not move focus off a disabled button's neighbors onto it", () => {
    okBtn.disabled = true;
    cancelBtn.handleKey("RIGHT");
    // With only one enabled button, focus should stay put rather than land
    // on the disabled one.
    expect(focusManager.getFocused()).toBe(cancelBtn);
  });
});
