import { describe, it, expect } from "vitest";
import { isUpdateAvailable } from "../updates";

describe("isUpdateAvailable", () => {
  it("returns false when current and latest are equal", () => {
    expect(isUpdateAvailable("1.9.1", "1.9.1")).toBe(false);
  });

  it("returns true when latest has a higher patch version", () => {
    expect(isUpdateAvailable("1.9.1", "1.9.2")).toBe(true);
  });

  it("returns false when current already exceeds latest", () => {
    expect(isUpdateAvailable("1.9.2", "1.9.1")).toBe(false);
  });

  // This fork tags its own builds with a "-win.N" suffix (e.g. "1.9.1-win.1")
  // that doesn't exist in upstream's numeric-only releases. The comparison must
  // ignore that suffix rather than parsing it as NaN.
  it("ignores this fork's -win.N suffix when comparing against upstream", () => {
    expect(isUpdateAvailable("1.9.1-win.1", "1.9.1")).toBe(false);
    expect(isUpdateAvailable("1.9.1-win.1", "1.9.2")).toBe(true);
    expect(isUpdateAvailable("1.9.1-win.3", "1.9.1")).toBe(false);
  });
});
