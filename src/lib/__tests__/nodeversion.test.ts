import { describe, it, expect } from "vitest";
import { checkNodeVersionCompatibility } from "../nodeversion";

describe("checkNodeVersionCompatibility", () => {
  it("returns null for versions within the tested range", () => {
    expect(checkNodeVersionCompatibility("v18.20.4")).toBeNull();
    expect(checkNodeVersionCompatibility("v20.11.0")).toBeNull();
    expect(checkNodeVersionCompatibility("v22.9.0")).toBeNull();
  });

  it("warns about the confirmed Node 24 zlib extraction hang", () => {
    const warning = checkNodeVersionCompatibility("v24.17.0");
    expect(warning).not.toBeNull();
    expect(warning).toMatch(/zlib/i);
    expect(warning).toMatch(/hang/i);
  });

  it("warns (differently) for versions older than the minimum", () => {
    const warning = checkNodeVersionCompatibility("v16.20.2");
    expect(warning).not.toBeNull();
    expect(warning).toMatch(/older/i);
  });

  it("does not throw on an unparsable version string", () => {
    expect(checkNodeVersionCompatibility("not-a-version")).toBeNull();
  });
});
