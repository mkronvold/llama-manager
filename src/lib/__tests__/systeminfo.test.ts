import { describe, it, expect } from "vitest";
import {
  sumByLuid,
  sampleCpuPercent,
  parseNvidiaSmiCsv,
  parseAmdSmiJson,
  parseVulkanProbeOutput,
  resolveAdapterTotalBytes,
  type DxgiAdapterBudget,
} from "../systeminfo";

describe("resolveAdapterTotalBytes", () => {
  const dxgi: DxgiAdapterBudget = {
    luidKey: "luid_0x00000000_0xa672528b_phys_0",
    name: "AMD Radeon(TM) 8060S Graphics",
    isSoftware: false,
    localBudgetBytes: 118889820160,
    nonLocalBudgetBytes: null,
  };

  it("prefers the perf-counter Limit value when present", () => {
    expect(resolveAdapterTotalBytes(1000, dxgi, "local")).toBe(1000);
  });

  it("falls back to the DXGI local budget when the Limit counter is missing", () => {
    // Reproduces the observed bug: an AMD unified-memory APU registers
    // Dedicated/Shared Usage counters but never registers a Usage Limit
    // counter, so the Limit map has no entry for this adapter.
    expect(resolveAdapterTotalBytes(null, dxgi, "local")).toBe(118889820160);
    expect(resolveAdapterTotalBytes(undefined, dxgi, "local")).toBe(118889820160);
  });

  it("does not use the DXGI non-local budget when it is zero/unavailable", () => {
    expect(resolveAdapterTotalBytes(null, dxgi, "nonLocal")).toBeNull();
  });

  it("never uses budgets from a software/basic-render adapter", () => {
    const software: DxgiAdapterBudget = { ...dxgi, isSoftware: true };
    expect(resolveAdapterTotalBytes(null, software, "local")).toBeNull();
  });

  it("returns null when no DXGI data is available at all", () => {
    expect(resolveAdapterTotalBytes(null, undefined, "local")).toBeNull();
  });
});

describe("sumByLuid (GPU perf-counter aggregation)", () => {
  it("sums multiple per-engine samples into a single per-adapter total", () => {
    // Real-shaped output from `Get-Counter '\GPU Engine(*)\Utilization Percentage'`:
    // many rows per adapter (one per engine type/process), keyed by a shared luid.
    const lines = [
      "pid_12388_luid_0x00000000_0x000158d5_phys_0_eng_0_engtype_3d,12.5",
      "pid_12388_luid_0x00000000_0x000158d5_phys_0_eng_1_engtype_copy,0.5",
      "pid_9999_luid_0x00000000_0x000158d5_phys_0_eng_2_engtype_compute,2.0",
      "pid_1_luid_0x00000000_0x00017b69_phys_0_eng_0_engtype_3d,0.0",
    ];
    const totals = sumByLuid(lines);
    expect(totals.get("luid_0x00000000_0x000158d5_phys_0")).toBeCloseTo(15.0);
    expect(totals.get("luid_0x00000000_0x00017b69_phys_0")).toBeCloseTo(0.0);
  });

  it("treats one-row-per-adapter memory counters as already-aggregated", () => {
    // Real-shaped output from `Get-Counter '\GPU Adapter Memory(*)\Dedicated Usage'`:
    // exactly one row per physical adapter.
    const lines = [
      "luid_0x00000000_0x000158d5_phys_0,2545651712",
      "luid_0x00000000_0x00017b69_phys_0,0",
    ];
    const totals = sumByLuid(lines);
    expect(totals.get("luid_0x00000000_0x000158d5_phys_0")).toBe(2545651712);
    expect(totals.get("luid_0x00000000_0x00017b69_phys_0")).toBe(0);
  });

  it("ignores malformed lines instead of throwing", () => {
    const totals = sumByLuid(["not a valid line", "", "luid_0x1_0x2_phys_0,abc"]);
    expect(totals.size).toBe(0);
  });
});

describe("sampleCpuPercent", () => {
  it("resolves a percentage between 0 and 100", async () => {
    const percent = await sampleCpuPercent(50);
    expect(percent === null || (percent >= 0 && percent <= 100)).toBe(true);
  });
});

describe("parseNvidiaSmiCsv", () => {
  it("parses utilization and VRAM from nvidia-smi CSV output", () => {
    const gpus = parseNvidiaSmiCsv([
      "0, NVIDIA GeForce RTX 4090, 73, 10240, 24564",
      "1, NVIDIA RTX 6000 Ada Generation, [N/A], [N/A], 49140",
    ].join("\n"));

    expect(gpus).toHaveLength(2);
    expect(gpus[0]).toMatchObject({
      label: "NVIDIA GeForce RTX 4090",
      source: "nvidia-smi",
      utilizationPercent: 73,
      dedicatedUsedBytes: 10240 * 1024 * 1024,
      dedicatedTotalBytes: 24564 * 1024 * 1024,
    });
    expect(gpus[1]!.utilizationPercent).toBeNull();
    expect(gpus[1]!.dedicatedUsedBytes).toBeNull();
    expect(gpus[1]!.dedicatedTotalBytes).toBe(49140 * 1024 * 1024);
  });

  it("keeps GPU names containing commas by parsing numeric fields from the tail", () => {
    const gpus = parseNvidiaSmiCsv("0, NVIDIA, GPU With Comma, 10, 512, 8192");
    expect(gpus[0]!.label).toBe("NVIDIA, GPU With Comma");
    expect(gpus[0]!.utilizationPercent).toBe(10);
  });
});

describe("parseAmdSmiJson", () => {
  it("parses modern amd-smi mem_usage and usage shapes", () => {
    const gpus = parseAmdSmiJson(JSON.stringify({
      gpu_data: [
        {
          gpu: 0,
          market_name: "AMD Radeon RX 7900 XTX",
          usage: { gfx_activity: 42 },
          mem_usage: {
            used_vram: { value: 6144, unit: "MiB" },
            total_vram: { value: 24, unit: "GiB" },
          },
        },
      ],
    }));

    expect(gpus).toHaveLength(1);
    expect(gpus[0]).toMatchObject({
      label: "AMD Radeon RX 7900 XTX",
      source: "amd-smi",
      utilizationPercent: 42,
      dedicatedUsedBytes: 6144 * 1024 * 1024,
      dedicatedTotalBytes: 24 * 1024 * 1024 * 1024,
    });
  });

  describe("parseVulkanProbeOutput", () => {
    it("parses ggml Vulkan free/total bytes output as memory usage", () => {
      const total = 24 * 1024 * 1024 * 1024;
      const free = 18 * 1024 * 1024 * 1024;
      const gpus = parseVulkanProbeOutput(`0,${free},${total}`);

      expect(gpus).toHaveLength(1);
      expect(gpus[0]).toMatchObject({
        label: "Vulkan GPU 1",
        source: "Vulkan (ggml)",
        utilizationPercent: null,
        dedicatedUsedBytes: total - free,
        dedicatedTotalBytes: total,
      });
    });

    it("ignores malformed or zero-capacity Vulkan rows", () => {
      expect(parseVulkanProbeOutput("bad\n1,100,0\n2,x,10")).toEqual([]);
    });
  });

  it("parses older vram/fb_memory_usage style output and ignores invalid JSON", () => {
    const gpus = parseAmdSmiJson(JSON.stringify([
      {
        name: "AMD GPU",
        gpu_activity: { gpu_use_percent: "11" },
        fb_memory_usage: { used: "1024 MiB", total: "8192 MiB" },
      },
    ]));

    expect(gpus).toHaveLength(1);
    expect(gpus[0]!.utilizationPercent).toBe(11);
    expect(gpus[0]!.dedicatedUsedBytes).toBe(1024 * 1024 * 1024);
    expect(gpus[0]!.dedicatedTotalBytes).toBe(8192 * 1024 * 1024);
    expect(parseAmdSmiJson("not-json")).toEqual([]);
  });
});
