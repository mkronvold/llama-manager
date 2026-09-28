import { describe, it, expect } from "vitest";
import {
  sumByLuid,
  sampleCpuPercent,
  resetCpuSampler,
  cpuPercentBetween,
  smoothCpuPercent,
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
    dedicatedVideoMemoryBytes: 68541677568,
    sharedSystemMemoryBytes: 51166453760,
    localBudgetBytes: 118889820160,
    nonLocalBudgetBytes: null,
  };

  it("prefers the perf-counter Limit value when present", () => {
    expect(resolveAdapterTotalBytes(1000, dxgi, "local")).toBe(1000);
  });

  it("falls back to the DXGI adapter capacity when the Limit counter is missing", () => {
    // Reproduces the observed bug: an AMD unified-memory APU registers
    // Dedicated/Shared Usage counters but never registers a Usage Limit
    // counter, so the Limit map has no entry for this adapter.
    expect(resolveAdapterTotalBytes(null, dxgi, "local")).toBe(68541677568);
    expect(resolveAdapterTotalBytes(undefined, dxgi, "local")).toBe(68541677568);
    expect(resolveAdapterTotalBytes(null, dxgi, "nonLocal")).toBe(51166453760);
  });

  it("prefers the fixed adapter capacity over the dynamic DXGI budget", () => {
    // The budget spans the combined dedicated+shared pool on a unified-memory
    // APU, so using it as the "Dedicated VRAM" total overstated capacity.
    expect(resolveAdapterTotalBytes(null, dxgi, "local")).not.toBe(dxgi.localBudgetBytes);
  });

  it("falls back to the DXGI budget when the descriptor reports no capacity", () => {
    const noCapacity: DxgiAdapterBudget = { ...dxgi, dedicatedVideoMemoryBytes: null };
    expect(resolveAdapterTotalBytes(null, noCapacity, "local")).toBe(118889820160);
  });

  it("does not invent a non-local total when neither capacity nor budget is available", () => {
    const bare: DxgiAdapterBudget = { ...dxgi, sharedSystemMemoryBytes: null, nonLocalBudgetBytes: null };
    expect(resolveAdapterTotalBytes(null, bare, "nonLocal")).toBeNull();
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
    resetCpuSampler();
    const percent = await sampleCpuPercent(50);
    expect(percent === null || (percent >= 0 && percent <= 100)).toBe(true);
  });

  it("reuses the retained sample so a second call does not sleep again", async () => {
    resetCpuSampler();
    await sampleCpuPercent(50);
    // The retained sample must age past the minimum window before it is usable.
    await new Promise((resolve) => setTimeout(resolve, 800));
    const started = Date.now();
    const percent = await sampleCpuPercent();
    expect(Date.now() - started).toBeLessThan(200);
    expect(percent === null || (percent >= 0 && percent <= 100)).toBe(true);
  });
});

describe("cpuPercentBetween", () => {
  it("computes busy percentage from idle/total deltas", () => {
    expect(cpuPercentBetween({ idle: 0, total: 0 }, { idle: 250, total: 1000 })).toBeCloseTo(75);
    expect(cpuPercentBetween({ idle: 100, total: 200 }, { idle: 1100, total: 1200 })).toBeCloseTo(0);
  });

  it("returns null when no time elapsed, instead of dividing by zero", () => {
    expect(cpuPercentBetween({ idle: 5, total: 10 }, { idle: 5, total: 10 })).toBeNull();
  });

  it("clamps out-of-range results that coarse Windows tick accounting can produce", () => {
    // Windows accumulates CPU time on the ~15.6ms scheduler tick, so idle can
    // briefly appear to grow faster than total across a short window.
    expect(cpuPercentBetween({ idle: 0, total: 0 }, { idle: 1200, total: 1000 })).toBe(0);
    expect(cpuPercentBetween({ idle: -50, total: 0 }, { idle: -50, total: 1000 })).toBe(100);
  });
});

describe("smoothCpuPercent", () => {
  it("adopts the first reading verbatim", () => {
    expect(smoothCpuPercent(null, 42)).toBe(42);
  });

  it("damps a spike instead of jumping straight to it", () => {
    // The real-world symptom: consecutive accurate 1s samples legitimately
    // swing between ~10% and 100% under inference, which reads as broken.
    const smoothed = smoothCpuPercent(10, 100);
    expect(smoothed).toBeGreaterThan(10);
    expect(smoothed).toBeLessThan(100);
  });

  it("converges toward a steady value", () => {
    let value: number | null = 0;
    for (let i = 0; i < 25; i++) value = smoothCpuPercent(value, 50);
    expect(value).toBeCloseTo(50, 1);
  });

  it("keeps the previous value when a reading is unavailable", () => {
    expect(smoothCpuPercent(30, null)).toBe(30);
    expect(smoothCpuPercent(null, null)).toBeNull();
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
