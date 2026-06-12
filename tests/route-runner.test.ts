import { describe, expect, it, vi } from "vitest";
import { runRouteAudits } from "../src/lighthouse/run-route.js";

describe("route runner", () => {
  it("runs sequentially, reports degraded when at least 3 of 5 runs succeed, and selects median from successful runs", async () => {
    const calls: number[] = [];
    const runner = vi.fn(async (_url: string, runIndex: number) => {
      calls.push(runIndex);
      if (runIndex === 4) throw new Error("Chrome crashed");
      return { id: runIndex, categories: { performance: { score: runIndex / 10 } }, audits: {} };
    });
    const medianSelector = vi.fn((lhrs: any[]) => lhrs[2]);

    const result = await runRouteAudits({
      url: "https://example.com/home",
      route: "/home",
      formFactor: "mobile",
      runsTotal: 5,
      runOnce: runner,
      selectMedian: medianSelector,
      onRunComplete: vi.fn()
    });

    expect(calls).toEqual([1, 2, 3, 4, 5]);
    expect(result.status).toBe("degraded");
    expect(result.lhrs).toHaveLength(4);
    expect(result.errors).toHaveLength(1);
    expect(result.successfulRuns.map((run) => run.runIndex)).toEqual([1, 2, 3, 5]);
    expect(result.medianLhr).toMatchObject({ id: 3 });
    expect(result.medianRunIndex).toBe(3);
    expect(medianSelector).toHaveBeenCalledWith(result.lhrs);
  });

  it("fails a route when fewer than 3 runs succeed", async () => {
    const result = await runRouteAudits({
      url: "https://example.com/home",
      route: "/home",
      formFactor: "mobile",
      runsTotal: 5,
      runOnce: async (_url, runIndex) => {
        if (runIndex > 2) throw new Error("timeout");
        return { id: runIndex, categories: {}, audits: {} };
      },
      selectMedian: (lhrs: any[]) => lhrs[0],
      onRunComplete: vi.fn()
    });

    expect(result.status).toBe("failed");
    expect(result.medianLhr).toBeNull();
    expect(result.errors).toHaveLength(3);
  });
});
