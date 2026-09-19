import { describe, it, expect } from "vitest";
import { parseFolderNameV2, detectForkFromFolder } from "../forks";

describe("Unsloth fork folder-name round-trip (parseFolderNameV2 / detectForkFromFolder)", () => {
  it("detects the unsloth fork from its folder prefix", () => {
    expect(detectForkFromFolder("unsloth-b11030-mix-5ff778e").id).toBe("unsloth");
    expect(detectForkFromFolder("unsloth-b11030-mix-5ff778e-cuda12-portable").id).toBe("unsloth");
  });

  it("parses the default (cpu) folder name, whose tag itself contains hyphens", () => {
    const parsed = parseFolderNameV2("unsloth-b11030-mix-5ff778e");
    expect(parsed).toEqual({ fork: "unsloth", tag: "b11030-mix-5ff778e", backend: "cpu" });
  });

  it("parses a multi-segment backend suffix (cuda12-portable) without truncating the tag", () => {
    const parsed = parseFolderNameV2("unsloth-b11030-mix-5ff778e-cuda12-portable");
    expect(parsed).toEqual({ fork: "unsloth", tag: "b11030-mix-5ff778e", backend: "cuda12-portable" });
  });

  it("parses a ROCm gfx-code backend suffix", () => {
    const parsed = parseFolderNameV2("unsloth-b11030-mix-5ff778e-rocm-gfx1151");
    expect(parsed).toEqual({ fork: "unsloth", tag: "b11030-mix-5ff778e", backend: "rocm-gfx1151" });
  });
});
