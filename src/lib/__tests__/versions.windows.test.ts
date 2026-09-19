import { describe, it, expect, vi } from "vitest";

// Force a deterministic architecture regardless of the machine/CI runner this test
// executes on (getArchKey() reads os.arch() internally).
vi.mock("os", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    default: { ...(actual.default as object), arch: () => "x64", platform: () => "win32" },
    arch: () => "x64",
    platform: () => "win32",
  };
});

import { getAvailableBackends } from "../versions";

/**
 * Fixtures below are real asset filenames captured live from each fork's GitHub
 * releases API (see windows-support-enhancement-plan.md, section "Windows asset
 * name verification") at the time this fix was authored. They intentionally include
 * the full real-world asset list (other platforms/arches too) so the tests also
 * guard against the OS/arch filtering excluding assets it shouldn't.
 */

const LLAMA_CPP_ASSETS_B11036 = [
  "llama-b11036-bin-android-arm64.tar.gz",
  "llama-b11036-bin-macos-arm64.tar.gz",
  "llama-b11036-bin-macos-x64.tar.gz",
  "llama-b11036-bin-ubuntu-arm64.tar.gz",
  "llama-b11036-bin-ubuntu-cuda-12.8-x64.tar.gz",
  "llama-b11036-bin-ubuntu-x64.tar.gz",
  "llama-b11036-bin-win-cpu-arm64.zip",
  "llama-b11036-bin-win-cpu-x64.zip",
  "llama-b11036-bin-win-cuda-12.4-x64.zip",
  "llama-b11036-bin-win-cuda-13.4-arm64.zip",
  "llama-b11036-bin-win-cuda-13.4-x64.zip",
  "llama-b11036-bin-win-opencl-adreno-arm64.zip",
  "llama-b11036-bin-win-openvino-2026.4-x64.zip",
  "llama-b11036-bin-win-rocm-10.0-x64.zip",
  "llama-b11036-bin-win-sycl-x64.zip",
  "llama-b11036-bin-win-vulkan-x64.zip",
  "llama-b11036-ui.tar.gz",
  "llama-b11036-xcframework.zip",
].map((name) => ({ name }));

const KOBOLDCPP_ASSETS = [
  "koboldcpp-linux-x64",
  "koboldcpp-linux-x64-nocuda",
  "koboldcpp-linux-x64-oldpc",
  "koboldcpp-mac-arm64",
  "koboldcpp-nocuda.exe",
  "koboldcpp-oldpc.exe",
  "koboldcpp.exe",
].map((name) => ({ name }));

const BEELLAMA_ASSETS = [
  "beellama-v0.4.6-bin-macos-arm64.tar.gz",
  "beellama-v0.4.6-bin-ubuntu-arm64.tar.gz",
  "beellama-v0.4.6-bin-ubuntu-cuda-12.4-x64.tar.gz",
  "beellama-v0.4.6-bin-ubuntu-x64.tar.gz",
  "beellama-v0.4.6-bin-win-cpu-x64.zip",
  "beellama-v0.4.6-bin-win-cuda-12.4-x64.zip",
  "beellama-v0.4.6-bin-win-cuda-13.3-x64.zip",
  "beellama-v0.4.6-bin-win-hip-radeon-x64.zip",
  "beellama-v0.4.6-bin-win-sycl-x64.zip",
  "beellama-v0.4.6-bin-win-vulkan-x64.zip",
  "beellama-v0.4.6-cudart-win-cuda-12.4-x64.zip",
  "SHA256SUMS.txt",
].map((name) => ({ name }));

const LLAMACPP_ROCM_ASSETS = [
  "llama-b1328-ubuntu-rocm-gfx103X-x64.zip",
  "llama-b1328-ubuntu-rocm-gfx90a-x64.zip",
  "llama-b1328-windows-rocm-gfx103X-x64.zip",
  "llama-b1328-windows-rocm-gfx110X-x64.zip",
  "llama-b1328-windows-rocm-gfx1150-x64.zip",
  "llama-b1328-windows-rocm-gfx1151-x64.zip",
  "llama-b1328-windows-rocm-gfx120X-x64.zip",
  "llama-b1328-windows-rocm-gfx908-x64.zip",
  "llama-b1328-windows-rocm-gfx90a-x64.zip",
].map((name) => ({ name }));

// Captured live from unslothai/llama.cpp's GitHub releases API (tag "b11030-mix-5ff778e").
const UNSLOTH_ASSETS = [
  "app-b11030-mix-5ff778e-linux-arm64-cpu.tar.gz",
  "app-b11030-mix-5ff778e-linux-arm64-cuda13-portable.tar.gz",
  "app-b11030-mix-5ff778e-linux-arm64-vulkan.tar.gz",
  "app-b11030-mix-5ff778e-linux-x64-cpu.tar.gz",
  "app-b11030-mix-5ff778e-linux-x64-cuda12-legacy.tar.gz",
  "app-b11030-mix-5ff778e-linux-x64-cuda12-newer.tar.gz",
  "app-b11030-mix-5ff778e-linux-x64-cuda12-older.tar.gz",
  "app-b11030-mix-5ff778e-linux-x64-cuda12-portable.tar.gz",
  "app-b11030-mix-5ff778e-linux-x64-cuda13-newer.tar.gz",
  "app-b11030-mix-5ff778e-linux-x64-cuda13-older.tar.gz",
  "app-b11030-mix-5ff778e-linux-x64-cuda13-portable.tar.gz",
  "app-b11030-mix-5ff778e-linux-x64-rocm-gfx103X.tar.gz",
  "app-b11030-mix-5ff778e-linux-x64-rocm-gfx110X.tar.gz",
  "app-b11030-mix-5ff778e-linux-x64-rocm-gfx1150.tar.gz",
  "app-b11030-mix-5ff778e-linux-x64-rocm-gfx1151.tar.gz",
  "app-b11030-mix-5ff778e-linux-x64-rocm-gfx120X.tar.gz",
  "app-b11030-mix-5ff778e-linux-x64-rocm-gfx908.tar.gz",
  "app-b11030-mix-5ff778e-linux-x64-rocm-gfx90a.tar.gz",
  "app-b11030-mix-5ff778e-linux-x64-vulkan.tar.gz",
  "app-b11030-mix-5ff778e-windows-arm64-cpu.zip",
  "app-b11030-mix-5ff778e-windows-arm64-cuda13-portable.zip",
  "app-b11030-mix-5ff778e-windows-x64-cpu.zip",
  "app-b11030-mix-5ff778e-windows-x64-cuda12-legacy.zip",
  "app-b11030-mix-5ff778e-windows-x64-cuda12-newer.zip",
  "app-b11030-mix-5ff778e-windows-x64-cuda12-older.zip",
  "app-b11030-mix-5ff778e-windows-x64-cuda12-portable.zip",
  "app-b11030-mix-5ff778e-windows-x64-cuda13-newer.zip",
  "app-b11030-mix-5ff778e-windows-x64-cuda13-older.zip",
  "app-b11030-mix-5ff778e-windows-x64-cuda13-portable.zip",
  "app-b11030-mix-5ff778e-windows-x64-rocm-gfx103X.zip",
  "app-b11030-mix-5ff778e-windows-x64-rocm-gfx110X.zip",
  "app-b11030-mix-5ff778e-windows-x64-rocm-gfx1150.zip",
  "app-b11030-mix-5ff778e-windows-x64-rocm-gfx1151.zip",
  "app-b11030-mix-5ff778e-windows-x64-rocm-gfx120X.zip",
  "app-b11030-mix-5ff778e-windows-x64-rocm-gfx908.zip",
  "app-b11030-mix-5ff778e-windows-x64-rocm-gfx90a.zip",
  "app-b11030-mix-5ff778e-windows-x64-vulkan.zip",
  "llama-b11030-mix-5ff778e-bin-macos-arm64.tar.gz",
  "llama-b11030-mix-5ff778e-bin-macos-x64.tar.gz",
  "llama-prebuilt-manifest.json",
  "llama-prebuilt-sha256.json",
  "llama.cpp-source-b11030-mix-5ff778e.tar.gz",
].map((name) => ({ name }));

describe("getAvailableBackends on win32 (regression: previously returned [])", () => {
  it("finds Windows backends for the default llama.cpp fork", () => {
    const backends = getAvailableBackends("b11036", "win", LLAMA_CPP_ASSETS_B11036, "llama.cpp");
    const ids = backends.map((b) => b.id);

    expect(ids.length).toBeGreaterThan(0);
    expect(ids).toContain("cpu");
    expect(ids.some((id) => id.startsWith("cuda12"))).toBe(true);
    expect(ids).toContain("vulkan");
    expect(ids).toContain("sycl");
    expect(ids.some((id) => id.startsWith("openvino"))).toBe(true);
    expect(ids.some((id) => id.startsWith("rocm") && !id.startsWith("rocm-gfx"))).toBe(true);
    // arm64-only assets must not leak into an x64 install's backend list
    expect(backends.find((b) => b.assetName.includes("arm64"))).toBeUndefined();
  });

  it("finds Windows backends for koboldcpp (raw .exe assets with no OS token)", () => {
    const backends = getAvailableBackends("v1.100", "win", KOBOLDCPP_ASSETS, "koboldcpp");
    const ids = backends.map((b) => b.id);

    expect(ids.length).toBeGreaterThan(0);
    expect(ids).toContain("cuda");
    expect(ids).toContain("cpu");
    expect(ids).toContain("oldpc");
    // "metal" is macOS-only for koboldcpp; must not appear on Windows
    expect(ids).not.toContain("metal");
    // Assets must resolve to their exact Windows filenames, not the Linux ones
    const cuda = backends.find((b) => b.id === "cuda");
    expect(cuda?.assetName).toBe("koboldcpp.exe");
  });

  it("finds Windows backends for beellama.cpp", () => {
    const backends = getAvailableBackends("v0.4.6", "win", BEELLAMA_ASSETS, "beellama");
    const ids = backends.map((b) => b.id);

    expect(ids.length).toBeGreaterThan(0);
    expect(ids).toContain("cpu");
    expect(ids).toContain("hip");
    expect(ids).toContain("vulkan");
    expect(ids).toContain("sycl");
  });

  it("finds Windows backends for llamacpp-rocm (real asset OS token is 'windows', runtime platform key is 'win')", () => {
    const backends = getAvailableBackends("b1328", "win", LLAMACPP_ROCM_ASSETS, "llamacpp_rocm");
    const ids = backends.map((b) => b.id);

    expect(ids.length).toBeGreaterThan(0);
    expect(ids).toContain("rocm-gfx103X");
    expect(ids).toContain("rocm-gfx120X");
    // Ubuntu-only gfx90a build must not leak into the Windows list
    expect(backends.find((b) => b.assetName.includes("ubuntu"))).toBeUndefined();
  });

  it("finds Windows backends for the Unsloth llama.cpp fork (app-{tag}-{os}-{arch}-{backend} naming)", () => {
    const backends = getAvailableBackends("b11030-mix-5ff778e", "win", UNSLOTH_ASSETS, "unsloth");
    const ids = backends.map((b) => b.id);

    expect(ids).toContain("cpu");
    expect(ids).toContain("vulkan");
    expect(ids).toContain("cuda12-portable");
    expect(ids).toContain("cuda13-portable");
    expect(ids).toContain("rocm-gfx1151");
    // arm64-only assets must not leak into an x64 install's backend list
    expect(backends.find((b) => b.assetName.includes("arm64"))).toBeUndefined();
    // Linux-only assets must not leak into the Windows list
    expect(backends.find((b) => b.assetName.includes("-linux-"))).toBeUndefined();
  });
});

describe("getAvailableBackends on non-Windows platforms (no regression)", () => {
  it("still finds Linux backends for the default llama.cpp fork", () => {
    const backends = getAvailableBackends("b11036", "ubuntu", LLAMA_CPP_ASSETS_B11036, "llama.cpp");
    const ids = backends.map((b) => b.id);
    expect(ids).toContain("cpu");
    expect(ids.some((id) => id.startsWith("cuda12"))).toBe(true);
  });

  it("still finds Linux backends for koboldcpp", () => {
    const backends = getAvailableBackends("v1.100", "ubuntu", KOBOLDCPP_ASSETS, "koboldcpp");
    const ids = backends.map((b) => b.id);
    expect(ids).toContain("cuda");
    expect(ids).toContain("cpu");
    expect(ids).toContain("oldpc");
  });

  it("still finds Linux backends for the Unsloth llama.cpp fork", () => {
    const backends = getAvailableBackends("b11030-mix-5ff778e", "ubuntu", UNSLOTH_ASSETS, "unsloth");
    const ids = backends.map((b) => b.id);
    expect(ids).toContain("cpu");
    expect(ids).toContain("vulkan");
    expect(ids).toContain("cuda12-portable");
    expect(ids).toContain("cuda13-portable");
    expect(ids).toContain("rocm-gfx1151");
    // Windows-only assets must not leak into the Linux list
    expect(backends.find((b) => b.assetName.includes("-windows-"))).toBeUndefined();
  });
});
