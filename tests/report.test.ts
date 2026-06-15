import { describe, expect, it } from "vitest";
import { buildAuditWorkbook } from "../src/report/workbook.js";
import { makeUniqueSheetName, sanitizeSheetName } from "../src/report/sheet-names.js";
import type { AuditReport } from "../src/types/report.js";

const report: AuditReport = {
  jobId: "job-1",
  baseUrl: "https://example.com",
  displayName: "Example",
  startedAt: "2026-06-05T01:00:00.000Z",
  finishedAt: "2026-06-05T01:10:00.000Z",
  lighthouseVersion: "13.3.0",
  chromeVersion: "138.0.0.0",
  nodeVersion: "22.16.0",
  categories: ["performance", "accessibility", "best-practices", "seo", "pwa"],
  formFactors: ["mobile", "desktop"],
  runsPerPage: 5,
  throttlingLabel: "Slow 4G",
  throttling: { rttMs: 150, throughputKbps: 1638.4, cpuSlowdownMultiplier: 4 },
  authSummary: "Basic Auth: disabled; Form Login: disabled",
  routes: [
    {
      route: "/checkout",
      url: "https://example.com/checkout",
      results: [
        {
          route: "/checkout",
          formFactor: "mobile",
          status: "ok",
          runsOk: 5,
          runsTotal: 5,
          medianRunIndex: 3,
          scores: { performance: 85, accessibility: 92, "best-practices": 100, seo: 100, pwa: null },
          metrics: {
            lcp: { value: 2350, score: 91 },
            cls: { value: 0.08, score: 93 },
            tbt: { value: 180, score: 92 },
            fcp: { value: 1620, score: 91 },
            speedIndex: { value: 2990, score: 90 },
            tti: { value: 3460, score: 88 },
            maxPotentialFid: { value: 90, score: 95 }
          },
          runs: [
            { runIndex: 1, scores: { performance: 83, accessibility: 92, "best-practices": 100, seo: 100, pwa: null }, metrics: { lcp: 2410, cls: 0.09, tbt: 190, fcp: 1680, speedIndex: 3050, tti: 3520 } },
            { runIndex: 2, scores: { performance: 84, accessibility: 92, "best-practices": 100, seo: 100, pwa: null }, metrics: { lcp: 2280, cls: 0.07, tbt: 175, fcp: 1590, speedIndex: 2920, tti: 3380 } },
            { runIndex: 3, scores: { performance: 85, accessibility: 92, "best-practices": 100, seo: 100, pwa: null }, metrics: { lcp: 2350, cls: 0.08, tbt: 180, fcp: 1620, speedIndex: 2990, tti: 3460 } }
          ],
          opportunities: [{ auditId: "unused-javascript", title: "Reduce unused JavaScript", savingsMs: 1200, description: "Remove unused code." }]
        }
      ]
    }
  ],
  diagnostics: [
    { timestamp: "2026-06-05T01:02:00.000Z", route: "/checkout", formFactor: "mobile", runIndex: 4, severity: "warning", code: "RUN_SKIPPED", message: "Fixture warning" }
  ],
  summary: { totalRoutes: 1, totalRuns: 5, successfulRuns: 5, durationSec: 600, status: "completed" }
};

describe("Excel report generation", () => {
  it("sanitizes and de-duplicates sheet names for Excel limits", () => {
    expect(sanitizeSheetName("/a/b?c*[d]:e")).toBe("abcde");
    expect(sanitizeSheetName("/")).toBe("root");
    expect(makeUniqueSheetName("/this-is-a-very-long-route-name-that-exceeds-limit", new Set())).toHaveLength(31);

    const used = new Set<string>(["checkout"]);
    expect(makeUniqueSheetName("/checkout", used)).toBe("checkout-2");
  });

  it("builds the required workbook sheets with median-run values preserved", async () => {
    const workbook = await buildAuditWorkbook(report);

    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      "Summary",
      "checkout",
      "Diagnostics",
      "Run Configuration"
    ]);

    const summary = workbook.getWorksheet("Summary");
    expect(summary?.getCell("A2").value).toBe("/checkout");
    expect(summary?.getCell("D2").value).toBe(85);
    expect(summary?.getCell("O2").value).toBe("5/5");

    const routeSheet = workbook.getWorksheet("checkout");
    expect(routeSheet?.getCell("B6").value).toBe(85);
    expect(routeSheet?.getCell("G20").value).toBe(85);
    expect(routeSheet?.getCell("G25").value).toBe(2350);
  });

  it("adds an environment comparison sheet when a report has multiple environments", async () => {
    const workbook = await buildAuditWorkbook(compareReport as AuditReport);

    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      "Summary",
      "Compare",
      "Dev 1 checkout",
      "Dev 3 checkout",
      "Diagnostics",
      "Run Configuration"
    ]);

    const summary = workbook.getWorksheet("Summary");
    expect(summary?.getCell("A1").value).toBe("Environment");
    expect(summary?.getCell("A2").value).toBe("Dev 1");
    expect(summary?.getCell("B2").value).toBe("/checkout");
    expect(summary?.getCell("E2").value).toBe(85);

    const compare = workbook.getWorksheet("Compare");

    expect(compare?.getCell("A1").value).toBe("Route (path)");
    expect(compare?.getCell("B1").value).toBe("Form factor");
    expect(compare?.getCell("C1").value).toBe("Performance");
    expect(compare?.getCell("F1").value).toBe("Accessibility");
    expect(compare?.getCell("I1").value).toBe("Best Practices");
    expect(compare?.getCell("L1").value).toBe("SEO");
    expect(compare?.getCell("O1").value).toBe("LCP");
    expect(compare?.getCell("R1").value).toBe("CLS");
    expect(compare?.getCell("U1").value).toBe("TBT");
    expect(compare?.getCell("X1").value).toBe("FCP");
    expect(compare?.getCell("AA1").value).toBe("Speed Index");
    expect(compare?.getCell("AD1").value).toBe("TTI");

    expect(compare?.getCell("C2").value).toBe("Dev 1");
    expect(compare?.getCell("D2").value).toBe("Dev 3");
    expect(compare?.getCell("E2").value).toBe("Delta Dev 3 - Dev 1");
    expect(compare?.getCell("F2").value).toBe("Dev 1");
    expect(compare?.getCell("G2").value).toBe("Dev 3");
    expect(compare?.getCell("H2").value).toBe("Delta Dev 3 - Dev 1");

    expect(compare?.getCell("A3").value).toBe("/checkout");
    expect(compare?.getCell("B3").value).toBe("Mobile");
    expect(compare?.getCell("C3").value).toBe(85);
    expect(compare?.getCell("D3").value).toBe(78);
    expect(compare?.getCell("E3").value).toBe(-7);
    expect(compare?.getCell("O3").value).toBe(2350);
    expect(compare?.getCell("P3").value).toBe(2700);
    expect(compare?.getCell("Q3").value).toBe(350);

    expect(compare?.getCell("A4").value).toBe("/checkout");
    expect(compare?.getCell("B4").value).toBe("Desktop");
    expect(compare?.getCell("C4").value).toBe("N/A");
    expect(compare?.getCell("E4").value).toBe("N/A");

    const merges = (compare as unknown as { model: { merges: string[] } }).model.merges;
    expect(merges).toContain("A1:A2");
    expect(merges).toContain("B1:B2");
    expect(merges).toContain("C1:E1");
    expect(merges).toContain("F1:H1");
    expect(merges).toContain("O1:Q1");
    expect(merges).toContain("AD1:AF1");

    expect(compare?.getCell("C1").alignment?.horizontal).toBe("center");
    expect(compare?.getCell("C1").font?.bold).toBe(true);
  });

  it("applies exact score and metric conditional formatting rules", async () => {
    const workbook = await buildAuditWorkbook(report);
    const summary = workbook.getWorksheet("Summary") as any;

    const scoreFormatting = summary.conditionalFormattings.find((item: any) => item.ref === "D2:H2");
    expect(scoreFormatting.rules).toMatchObject([
      { operator: "lessThan", formulae: ["50"], style: { fill: { fgColor: { argb: "FFFF4E40" } } } },
      { operator: "between", formulae: ["50", "89"], style: { fill: { fgColor: { argb: "FFFFA400" } } } },
      { operator: "greaterThan", formulae: ["89"], style: { fill: { fgColor: { argb: "FF0CCE6B" } } } }
    ]);

    const lcpFormatting = summary.conditionalFormattings.find((item: any) => item.ref === "I2:I2");
    expect(lcpFormatting.rules).toMatchObject([
      { operator: "between", formulae: ["0", "2500"], style: { fill: { fgColor: { argb: "FF0CCE6B" } } } },
      { operator: "between", formulae: ["2500", "4000"], style: { fill: { fgColor: { argb: "FFFFA400" } } } },
      { operator: "greaterThan", formulae: ["4000"], style: { fill: { fgColor: { argb: "FFFF4E40" } } } }
    ]);
  });

  it("assigns globally unique conditional-formatting priorities within each worksheet", async () => {
    // OOXML (ECMA-376 §18.3.1.18) requires cfRule@priority to be unique across a
    // worksheet. Duplicate priorities load fine in desktop Excel but cause Excel
    // for the web to drop formatting (fill + font color) on some cells.
    for (const fixture of [report, compareReport as AuditReport]) {
      const workbook = await buildAuditWorkbook(fixture);
      for (const sheet of workbook.worksheets) {
        const priorities = ((sheet as any).conditionalFormattings ?? []).flatMap(
          (block: any) => block.rules.map((rule: any) => rule.priority)
        );
        const unique = new Set(priorities);
        expect({ sheet: sheet.name, count: priorities.length, unique: unique.size }).toEqual({
          sheet: sheet.name,
          count: priorities.length,
          unique: priorities.length
        });
      }
    }
  });

  it("labels manual-tabs reports with mode, cache policy, and evidence mode in Run Configuration", async () => {
    const manualReport: AuditReport = {
      ...report,
      mode: "manual-tabs",
      cachePolicy: "preserve-profile",
      evidenceMode: "none",
      authSummary: "Manual browser authentication (Manual Chrome Tabs)",
      routes: [
        {
          route: "/01-dashboard",
          url: "https://app.example.com/dashboard",
          results: report.routes[0]!.results.map((result) => ({ ...result, route: "/01-dashboard" }))
        }
      ]
    };

    const workbook = await buildAuditWorkbook(manualReport);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      "Summary",
      "manual-tabs01-dashboard",
      "Diagnostics",
      "Run Configuration"
    ]);

    const runConfig = workbook.getWorksheet("Run Configuration");
    const keyValues = new Map<string, unknown>();
    runConfig?.eachRow((row) => keyValues.set(String(row.getCell(1).value), row.getCell(2).value));
    expect(keyValues.get("Audit mode")).toBe("Manual Chrome Tabs");
    expect(keyValues.get("Cache policy")).toBe("preserve profile");
    expect(keyValues.get("Evidence mode")).toBe("none");
    expect(keyValues.get("Auth")).toBe("Manual browser authentication (Manual Chrome Tabs)");

    const summary = workbook.getWorksheet("Summary");
    expect(summary?.getCell("A2").value).toBe("/01-dashboard");
  });

  it("renders degraded 4/5 routes with failed run slots and diagnostics", async () => {
    const degraded: AuditReport = {
      ...report,
      summary: { totalRoutes: 1, totalRuns: 5, successfulRuns: 4, durationSec: 600, status: "partial" },
      diagnostics: [
        {
          timestamp: "2026-06-05T01:02:00.000Z",
          route: "/checkout",
          formFactor: "mobile",
          runIndex: 4,
          severity: "error",
          code: "RUN_FAILED",
          message: "Chrome crashed"
        }
      ],
      routes: [
        {
          route: "/checkout",
          url: "https://example.com/checkout",
          results: [
            {
              ...report.routes[0]!.results[0]!,
              status: "degraded",
              runsOk: 4,
              runsTotal: 5,
              medianRunIndex: 5,
              runs: [
                { runIndex: 1, scores: { performance: 83, accessibility: 92, "best-practices": 100, seo: 100, pwa: null }, metrics: { lcp: 2410, cls: 0.09, tbt: 190, fcp: 1680, speedIndex: 3050, tti: 3520 } },
                { runIndex: 2, scores: { performance: 84, accessibility: 92, "best-practices": 100, seo: 100, pwa: null }, metrics: { lcp: 2280, cls: 0.07, tbt: 175, fcp: 1590, speedIndex: 2920, tti: 3380 } },
                { runIndex: 3, scores: { performance: 82, accessibility: 92, "best-practices": 100, seo: 100, pwa: null }, metrics: { lcp: 2500, cls: 0.08, tbt: 180, fcp: 1620, speedIndex: 2990, tti: 3460 } },
                { runIndex: 5, scores: { performance: 86, accessibility: 92, "best-practices": 100, seo: 100, pwa: null }, metrics: { lcp: 2300, cls: 0.08, tbt: 160, fcp: 1500, speedIndex: 2800, tti: 3200 } }
              ]
            }
          ]
        }
      ]
    };

    const workbook = await buildAuditWorkbook(degraded);
    const summary = workbook.getWorksheet("Summary");
    const routeSheet = workbook.getWorksheet("checkout");
    const diagnostics = workbook.getWorksheet("Diagnostics");

    expect(summary?.getCell("O2").value).toBe("4/5");
    expect(summary?.getCell("P2").value).toBe("Degraded");
    expect(routeSheet?.getCell("E20").value).toBe("N/A");
    expect(routeSheet?.getCell("F20").value).toBe(86);
    expect(routeSheet?.getCell("G20").value).toBe(86);
    expect(diagnostics?.getCell("E2").value).toBe("error");
    expect(diagnostics?.getCell("F2").value).toBe("RUN_FAILED");
  });
});

const compareReport = {
  ...report,
  baseUrl: "multiple-environments",
  displayName: "Dev compare",
  environments: [
    { name: "Dev 1", baseUrl: "https://dev1.example.com" },
    { name: "Dev 3", baseUrl: "https://dev3.example.com" }
  ],
  summary: { totalRoutes: 2, totalRuns: 10, successfulRuns: 10, durationSec: 900, status: "completed" },
  routes: [
    {
      route: "/checkout",
      url: "https://dev1.example.com/checkout",
      environment: { name: "Dev 1", baseUrl: "https://dev1.example.com" },
      results: report.routes[0]!.results
    },
    {
      route: "/checkout",
      url: "https://dev3.example.com/checkout",
      environment: { name: "Dev 3", baseUrl: "https://dev3.example.com" },
      results: [
        {
          ...report.routes[0]!.results[0]!,
          scores: { performance: 78, accessibility: 90, "best-practices": 100, seo: 99, pwa: null },
          metrics: {
            ...report.routes[0]!.results[0]!.metrics,
            lcp: { value: 2700, score: 78 }
          }
        }
      ]
    }
  ]
};
