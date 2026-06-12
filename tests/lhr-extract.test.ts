import { describe, expect, it } from "vitest";
import { extractFormFactorReport } from "../src/lighthouse/extract.js";

describe("Lighthouse result extraction", () => {
  it("maps scores, metrics, PWA absence, warnings, runtime errors, and opportunities", () => {
    const report = extractFormFactorReport({
      route: "/checkout",
      formFactor: "mobile",
      status: "degraded",
      runsOk: 4,
      runsTotal: 5,
      medianRunIndex: 2,
      medianLhr: {
        categories: {
          performance: { score: 0.87 },
          accessibility: { score: 0.91 },
          "best-practices": { score: 1 },
          seo: { score: 0.98 }
        },
        audits: {
          "largest-contentful-paint": { numericValue: 2100, score: 0.9 },
          "cumulative-layout-shift": { numericValue: 0.04, score: 0.95 },
          "total-blocking-time": { numericValue: 120, score: 0.99 },
          "first-contentful-paint": { numericValue: 1050, score: 0.97 },
          "speed-index": { numericValue: 2500, score: 0.89 },
          interactive: { numericValue: 3300, score: 0.86 },
          "max-potential-fid": { numericValue: 80, score: 0.93 },
          "unused-javascript": {
            title: "Reduce unused JavaScript",
            description: "Trim bundles",
            details: { overallSavingsMs: 1500 }
          }
        },
        runWarnings: ["The page redirected."],
        runtimeError: { code: "NO_FCP", message: "No FCP." }
      },
      successfulRuns: [
        {
          runIndex: 1,
          lhr: {
          categories: { performance: { score: 0.8 }, accessibility: { score: 0.9 }, "best-practices": { score: 1 }, seo: { score: 1 } },
          audits: {
            "largest-contentful-paint": { numericValue: 2400 },
            "cumulative-layout-shift": { numericValue: 0.06 },
            "total-blocking-time": { numericValue: 150 },
            "first-contentful-paint": { numericValue: 1200 },
            "speed-index": { numericValue: 2600 },
            interactive: { numericValue: 3500 }
          }
          }
        },
        {
          runIndex: 5,
          lhr: {
          categories: { performance: { score: 0.87 }, accessibility: { score: 0.91 }, "best-practices": { score: 1 }, seo: { score: 0.98 } },
          audits: {
            "largest-contentful-paint": { numericValue: 2100 },
            "cumulative-layout-shift": { numericValue: 0.04 },
            "total-blocking-time": { numericValue: 120 },
            "first-contentful-paint": { numericValue: 1050 },
            "speed-index": { numericValue: 2500 },
            interactive: { numericValue: 3300 }
          }
          }
        }
      ],
      startedAt: "2026-06-05T01:00:00.000Z"
    });

    expect(report.result.scores).toMatchObject({
      performance: 87,
      accessibility: 91,
      "best-practices": 100,
      seo: 98,
      pwa: null
    });
    expect(report.result.metrics.lcp).toEqual({ value: 2100, score: 90 });
    expect(report.result.runs.map((run) => run.runIndex)).toEqual([1, 5]);
    expect(report.result.runs[1]?.metrics.lcp).toBe(2100);
    expect(report.result.opportunities[0]).toMatchObject({ auditId: "unused-javascript", savingsMs: 1500 });
    expect(report.diagnostics.map((item) => item.code)).toEqual(["NO_FCP", "RUN_WARNING"]);
  });
});
