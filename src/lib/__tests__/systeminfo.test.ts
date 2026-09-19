import { describe, it, expect } from "vitest";
import { sumByLuid, sampleCpuPercent } from "../systeminfo";

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
