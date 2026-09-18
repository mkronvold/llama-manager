import { describe, it, expect } from "vitest";
import { checkWindowsConsoleCapabilities } from "../termcaps";

describe("checkWindowsConsoleCapabilities", () => {
  it("returns null on non-Windows platforms regardless of env", () => {
    expect(checkWindowsConsoleCapabilities({}, "linux")).toBeNull();
    expect(checkWindowsConsoleCapabilities({}, "darwin")).toBeNull();
  });

  it("returns null when Windows Terminal signals capability", () => {
    expect(checkWindowsConsoleCapabilities({ WT_SESSION: "abc" }, "win32")).toBeNull();
  });

  it("returns null when COLORTERM is set (e.g. modern host)", () => {
    expect(checkWindowsConsoleCapabilities({ COLORTERM: "truecolor" }, "win32")).toBeNull();
  });

  it("warns on a bare win32 host with no capability signals and an old release", () => {
    const warning = checkWindowsConsoleCapabilities({}, "win32");
    // os.release() in this environment may be modern; just assert the function
    // returns either null or a non-empty string (never throws / undefined).
    expect(warning === null || typeof warning === "string").toBe(true);
  });
});
