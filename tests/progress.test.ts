import { describe, expect, it } from "vitest";
import { buildProgressPayload } from "../src/worker/progress.js";

describe("worker progress payload", () => {
  it("computes percent and ETA from completed run durations", () => {
    const progress = buildProgressPayload({
      route: "/home",
      formFactor: "mobile",
      runIndex: 3,
      runsTotal: 5,
      completedRuns: 12,
      totalRuns: 30,
      completedRunDurationsMs: [20_000, 30_000, 40_000]
    });

    expect(progress).toMatchObject({
      percent: 40,
      phase: "lighthouse-run",
      message: "Running Lighthouse 3/5 on /home (mobile)",
      currentRoute: "/home",
      formFactor: "mobile",
      runIndex: 3,
      runsTotal: 5,
      completedRuns: 12,
      totalRuns: 30,
      etaSeconds: 540
    });
  });
});
