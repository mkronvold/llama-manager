import { afterEach, describe, expect, it } from "vitest";
import { MetricsPanel } from "../../ui/specialized/MetricsPanel";
import { BarChart } from "../../framework/widgets/BarChart";
import { parseStrataMetrics } from "../stratametrics";
import { setStrataMetrics } from "../metricstracker";
import { taskNumber, taskRate, taskTime } from "../taskformat";
import { metricsFixture } from "./fixtures/stratametrics";

class TestMetricsPanel extends MetricsPanel {
  lines(): string[] { return this.strataLines(); }
  rows() { return this.strataRows(); }
}

class TestChart extends BarChart {
  hover(values: (number | null)[]): string { return this.buildHoverSubtitle("task", values); }
}

describe("runtime-aware measurement presentation", () => {
  afterEach(() => setStrataMetrics(null));

  it("distinguishes real zero from unknown tokens, rates and time", () => {
    expect(taskNumber(null)).toBe("n/a");
    expect(taskNumber(0)).toBe("0");
    expect(taskRate(null)).toBe("n/a");
    expect(taskRate(0)).toBe("0.0 t/s");
    expect(taskTime(null)).toBe("n/a");
    const chart = new TestChart();
    chart.setData([1, null, 0]);
    expect(chart.data).toEqual([1, null, 0]);
    expect(chart.hover([null, 0])).toMatch(/^task: n\/a,\s+0$/);
    chart.destroy();
  });

  it("labels service activity and session/history distinctions without a synthetic slot", () => {
    setStrataMetrics({ snapshot: parseStrataMetrics(metricsFixture()), receivedAt: Date.now(),
      error: null, historyError: null, missingRequests: 5 });
    const panel = new TestMetricsPanel();
    try {
      const text = panel.lines().join("\n");
      expect(text).toContain("Session  Tasks 1");
      expect(text).toContain("TG (history) 31.6 t/s");
      expect(text).toContain("Service  \u25cb idle  Last task #1");
      expect(text).toContain("  In   8  ·  Out 8");
      const speed = panel.lines().find(line => line.startsWith("  PP   "))!;
      expect(speed.indexOf("TG   ")).toBe(42);
      expect(speed).toContain("17.6 t/s");
      expect(speed).toContain("31.6 t/s");
      expect(panel.rows().flat()).toContainEqual({ text: "31.6 t/s", color: "success" });
      expect(text).toContain("History missing: 5");
      expect(text).not.toContain("Slot 0");
    } finally { panel.destroy(); }
  });

  it("keeps last completion at idle but never substitutes its rates for the active request", () => {
    const fixture = metricsFixture();
    const snapshot = parseStrataMetrics(fixture);
    const panel = new TestMetricsPanel();
    try {
      snapshot.live.state = "reading";
      snapshot.live.promptRead = 10;
      snapshot.live.promptTotal = 20;
      snapshot.live.promptRate = 100;
      setStrataMetrics({ snapshot, receivedAt: Date.now(), error: null, historyError: null, missingRequests: 0 });
      expect(panel.lines().find(line => line.startsWith("  PP   "))).toMatch(/100.0 t\/s\s+TG   n\/a$/);
      expect(panel.lines().join("\n")).toContain("Last task #1");
      expect(panel.lines().join("\n")).toContain("10 / 20 (50%) processed");
      snapshot.live.state = "idle";
      snapshot.live.promptRate = null;
      snapshot.live.promptRead = null;
      snapshot.live.promptTotal = null;
      expect(panel.lines().find(line => line.startsWith("  PP   "))).toMatch(/17.6 t\/s\s+TG   31.6 t\/s$/);
      panel.detailLevel = "middle";
      expect(panel.lines().join("\n")).toContain("Last task #1");
      expect(panel.lines().join("\n")).toContain("  In   8  ·  Out 8");
      panel.detailLevel = "basic";
      expect(panel.lines().join("\n")).toContain("Last task #1");
      expect(panel.lines().join("\n")).toContain("31.6 t/s");
    } finally { panel.destroy(); }
  });

  it("orders real slots without inventing task IDs or assigning a completion to an idle slot", () => {
    const snapshot = parseStrataMetrics(metricsFixture());
    snapshot.live.slots = [
      { slot: 2, state: "decoding", generated: 4, promptTokens: 18, rate: 12, elapsedSeconds: 1 },
      { slot: 0, state: "idle", generated: null, promptTokens: null, rate: null, elapsedSeconds: null },
    ];
    setStrataMetrics({ snapshot, receivedAt: Date.now(), error: null, historyError: null, missingRequests: 0 });
    const panel = new TestMetricsPanel();
    try {
      const text = panel.lines().join("\n");
      expect(text.indexOf("Slot 0")).toBeLessThan(text.indexOf("Slot 2"));
      expect(text).toContain("TG   12.0 t/s (4 tok)");
      expect(text).toContain("Last service completion #1 (slot unavailable)");
      expect(text).not.toContain("Task #");
      expect(text).not.toContain("Ctx");
      expect(text).toContain("Active 1");
    } finally { panel.destroy(); }
  });

  it("keeps faults and history warnings visible even at basic detail", () => {
    setStrataMetrics({ snapshot: parseStrataMetrics(metricsFixture()), receivedAt: Date.now() - 5000,
      error: "HTTP 401", historyError: "counter regressed", missingRequests: 0 });
    const panel = new TestMetricsPanel();
    try {
      panel.detailLevel = "basic";
      expect(panel.lines()[0]).toContain("last good data");
      expect(panel.lines()[1]).toContain("History recovery paused");
    } finally { panel.destroy(); }
  });
});
