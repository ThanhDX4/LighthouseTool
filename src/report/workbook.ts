import ExcelJS from "exceljs";
import { applyMetricFormatting, applyScoreFormatting, SCORE_COLORS, styleHeaderRow } from "./formatting.js";
import { makeUniqueSheetName } from "./sheet-names.js";
import type { AuditReport, FormFactorReport, RawRun, RouteReport } from "../types/report.js";
import type { FormFactor, LighthouseCategory } from "../types/config.js";

const categoryColumns: LighthouseCategory[] = ["performance", "accessibility", "best-practices", "seo", "pwa"];
const metricRows = [
  { key: "lcp", label: "LCP", unit: "ms", target: "<= 2500" },
  { key: "cls", label: "CLS", unit: "unitless", target: "<= 0.1" },
  { key: "tbt", label: "TBT", unit: "ms", target: "<= 200" },
  { key: "fcp", label: "FCP", unit: "ms", target: "<= 1800" },
  { key: "speedIndex", label: "Speed Index", unit: "ms", target: "<= 3400" },
  { key: "tti", label: "TTI", unit: "ms", target: "<= 3800" },
  { key: "maxPotentialFid", label: "Max Pot. FID", unit: "ms", target: "<= 130" }
] as const;

export async function buildAuditWorkbook(report: AuditReport): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Lighthouse Audit Tool";
  workbook.created = new Date(report.startedAt);
  workbook.modified = new Date(report.finishedAt);

  addSummarySheet(workbook, report);
  const hasCompareSheet = hasCompareEnvironments(report);
  if (hasCompareSheet) {
    addCompareSheet(workbook, report);
  }
  const used = new Set<string>(["Summary", "Diagnostics", "Run Configuration"]);
  if (hasCompareSheet) used.add("Compare");
  for (const route of report.routes) {
    const sheetNameInput = route.environment ? `${route.environment.name} ${route.route}` : route.route;
    addRouteSheet(workbook, report, route, makeUniqueSheetName(sheetNameInput, used));
  }
  addDiagnosticsSheet(workbook, report);
  addRunConfigurationSheet(workbook, report);

  return workbook;
}

function addSummarySheet(workbook: ExcelJS.Workbook, report: AuditReport): void {
  const sheet = workbook.addWorksheet("Summary");
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  const includeEnvironment = hasCompareEnvironments(report);
  const columns = [
    { header: "Route (path)", key: "route", width: 28 },
    { header: "Full URL", key: "url", width: 50 },
    { header: "Form factor", key: "formFactor", width: 12 },
    { header: "Performance", key: "performance", width: 14 },
    { header: "Accessibility", key: "accessibility", width: 14 },
    { header: "Best Practices", key: "bestPractices", width: 16 },
    { header: "SEO", key: "seo", width: 10 },
    { header: "PWA", key: "pwa", width: 10 },
    { header: "LCP (ms)", key: "lcp", width: 12 },
    { header: "CLS", key: "cls", width: 10 },
    { header: "TBT (ms)", key: "tbt", width: 12 },
    { header: "FCP (ms)", key: "fcp", width: 12 },
    { header: "Speed Index (ms)", key: "speedIndex", width: 14 },
    { header: "TTI (ms)", key: "tti", width: 12 },
    { header: "Runs OK", key: "runsOk", width: 10 },
    { header: "Status", key: "status", width: 12 }
  ];
  sheet.columns = includeEnvironment
    ? [{ header: "Environment", key: "environment", width: 18 }, ...columns]
    : columns;
  styleHeaderRow(sheet.getRow(1));

  for (const route of report.routes) {
    for (const result of route.results) {
      const row = sheet.addRow({
        environment: route.environment?.name,
        route: route.route,
        url: { text: route.url, hyperlink: route.url },
        formFactor: titleCase(result.formFactor),
        performance: result.scores.performance,
        accessibility: result.scores.accessibility,
        bestPractices: result.scores["best-practices"],
        seo: result.scores.seo,
        pwa: result.scores.pwa ?? "N/A",
        lcp: result.metrics.lcp.value,
        cls: result.metrics.cls.value,
        tbt: result.metrics.tbt.value,
        fcp: result.metrics.fcp.value,
        speedIndex: result.metrics.speedIndex.value,
        tti: result.metrics.tti.value,
        runsOk: `${result.runsOk}/${result.runsTotal}`,
        status: titleCase(result.status)
      });
      row.getCell(includeEnvironment ? 3 : 2).font = { color: { argb: "FF0563C1" }, underline: true };
    }
  }

  const lastDataRow = Math.max(2, sheet.lastRow?.number ?? 2);
  const averageRowNumber = lastDataRow + 1;
  const averageRow = sheet.getRow(averageRowNumber);
  averageRow.getCell(1).value = "AVERAGE";
  const averageColumns = includeEnvironment
    ? ["E", "F", "G", "H", "J", "K", "L", "M", "N", "O"]
    : ["D", "E", "F", "G", "I", "J", "K", "L", "M", "N"];
  for (const column of averageColumns) {
    averageRow.getCell(column).value = { formula: `AVERAGE(${column}2:${column}${lastDataRow})` };
  }
  averageRow.font = { bold: true };
  averageRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: SCORE_COLORS.averageRow } };

  if (includeEnvironment) {
    sheet.autoFilter = { from: "A1", to: `Q${lastDataRow}` };
    applyScoreFormatting(sheet, `E2:I${lastDataRow}`);
    applyMetricFormatting(sheet, `J2:J${lastDataRow}`, "lcp");
    applyMetricFormatting(sheet, `K2:K${lastDataRow}`, "cls");
    applyMetricFormatting(sheet, `L2:L${lastDataRow}`, "tbt");
    applyMetricFormatting(sheet, `M2:M${lastDataRow}`, "fcp");
    applyMetricFormatting(sheet, `N2:N${lastDataRow}`, "speedIndex");
    applyMetricFormatting(sheet, `O2:O${lastDataRow}`, "tti");
  } else {
    sheet.autoFilter = { from: "A1", to: `P${lastDataRow}` };
    applyScoreFormatting(sheet, `D2:H${lastDataRow}`);
    applyMetricFormatting(sheet, `I2:I${lastDataRow}`, "lcp");
    applyMetricFormatting(sheet, `J2:J${lastDataRow}`, "cls");
    applyMetricFormatting(sheet, `K2:K${lastDataRow}`, "tbt");
    applyMetricFormatting(sheet, `L2:L${lastDataRow}`, "fcp");
    applyMetricFormatting(sheet, `M2:M${lastDataRow}`, "speedIndex");
    applyMetricFormatting(sheet, `N2:N${lastDataRow}`, "tti");
  }
}

function addCompareSheet(workbook: ExcelJS.Workbook, report: AuditReport): void {
  const environments = report.environments ?? [];
  const baseline = environments[0];
  if (!baseline) return;

  const sheet = workbook.addWorksheet("Compare");
  sheet.views = [{ state: "frozen", xSplit: 2, ySplit: 2 }];

  const metrics: Array<{ label: string; getValue: (result: FormFactorReport) => number | null }> = [
    { label: "Performance", getValue: (result) => result.scores.performance },
    { label: "Accessibility", getValue: (result) => result.scores.accessibility },
    { label: "Best Practices", getValue: (result) => result.scores["best-practices"] },
    { label: "SEO", getValue: (result) => result.scores.seo },
    { label: "LCP", getValue: (result) => result.metrics.lcp.value },
    { label: "CLS", getValue: (result) => result.metrics.cls.value },
    { label: "TBT", getValue: (result) => result.metrics.tbt.value },
    { label: "FCP", getValue: (result) => result.metrics.fcp.value },
    { label: "Speed Index", getValue: (result) => result.metrics.speedIndex.value },
    { label: "TTI", getValue: (result) => result.metrics.tti.value }
  ];

  const FIXED_COLS = 2;
  const envCount = environments.length;
  const subColsPerMetric = envCount + Math.max(0, envCount - 1);
  const totalCols = FIXED_COLS + metrics.length * subColsPerMetric;

  for (let col = 1; col <= totalCols; col += 1) {
    sheet.getColumn(col).width = col <= FIXED_COLS ? 24 : 14;
  }

  const row1 = sheet.getRow(1);
  const row2 = sheet.getRow(2);

  row1.getCell(1).value = "Route (path)";
  row1.getCell(2).value = "Form factor";

  let headerCol = FIXED_COLS + 1;
  for (const metric of metrics) {
    row1.getCell(headerCol).value = metric.label;
    if (subColsPerMetric > 1) {
      sheet.mergeCells(1, headerCol, 1, headerCol + subColsPerMetric - 1);
    }

    environments.forEach((environment, idx) => {
      row2.getCell(headerCol + idx).value = environment.name;
    });
    environments.slice(1).forEach((environment, idx) => {
      row2.getCell(headerCol + envCount + idx).value = `Delta ${environment.name} - ${baseline.name}`;
    });

    headerCol += subColsPerMetric;
  }

  sheet.mergeCells("A1:A2");
  sheet.mergeCells("B1:B2");

  styleHeaderRow(row1);
  styleHeaderRow(row2);
  for (let col = 1; col <= totalCols; col += 1) {
    row1.getCell(col).alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    row2.getCell(col).alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  }
  row1.height = 22;
  row2.height = 20;

  const routes = Array.from(new Set(report.routes.map((route) => route.route)));
  let dataRow = 3;
  for (const route of routes) {
    for (const formFactor of report.formFactors) {
      const row = sheet.getRow(dataRow);
      row.getCell(1).value = route;
      row.getCell(2).value = titleCase(formFactor);

      let dataCol = FIXED_COLS + 1;
      for (const metric of metrics) {
        const values = environments.map((environment) => {
          const result = findEnvironmentResult(report, environment.name, route, formFactor);
          return result ? metric.getValue(result) : null;
        });
        const baselineValue = values[0];

        values.forEach((value, idx) => {
          row.getCell(dataCol + idx).value = value ?? "N/A";
        });
        values.slice(1).forEach((value, idx) => {
          row.getCell(dataCol + envCount + idx).value =
            typeof value === "number" && typeof baselineValue === "number"
              ? value - baselineValue
              : "N/A";
        });

        dataCol += subColsPerMetric;
      }
      dataRow += 1;
    }
  }

  applyCompareBorders(sheet, FIXED_COLS, metrics.length, subColsPerMetric, dataRow - 1);
}

function applyCompareBorders(
  sheet: ExcelJS.Worksheet,
  fixedCols: number,
  metricCount: number,
  subColsPerMetric: number,
  lastDataRow: number
): void {
  const lastRow = Math.max(2, lastDataRow);
  const groupBoundaryCols = [fixedCols];
  for (let i = 0; i < metricCount; i += 1) {
    groupBoundaryCols.push(fixedCols + (i + 1) * subColsPerMetric);
  }

  for (const boundaryCol of groupBoundaryCols) {
    for (let r = 1; r <= lastRow; r += 1) {
      const cell = sheet.getRow(r).getCell(boundaryCol);
      const existing = cell.border ?? {};
      cell.border = {
        ...existing,
        right: { style: "medium", color: { argb: "FF888888" } }
      };
    }
  }
}

function addRouteSheet(workbook: ExcelJS.Workbook, report: AuditReport, route: RouteReport, sheetName: string): void {
  const sheet = workbook.addWorksheet(sheetName);
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.properties.defaultRowHeight = 18;
  sheet.columns = Array.from({ length: 10 }, () => ({ width: 16 }));

  sheet.mergeCells("A1:H1");
  sheet.getCell("A1").value = `Lighthouse Report - ${route.environment ? `${route.environment.name} - ` : ""}${route.route}`;
  sheet.getCell("A1").font = { bold: true, size: 14 };
  sheet.mergeCells("A2:H2");
  sheet.getCell("A2").value = { text: route.url, hyperlink: route.url };
  sheet.getCell("A2").font = { color: { argb: "FF0563C1" }, underline: true };
  sheet.mergeCells("A3:H3");
  sheet.getCell("A3").value = `Audited at ${report.finishedAt} - Lighthouse ${report.lighthouseVersion} - Chrome ${report.chromeVersion}`;

  sheet.getRow(5).values = ["Form factor", "Performance", "Accessibility", "Best Practices", "SEO", "PWA"];
  styleHeaderRow(sheet.getRow(5));
  for (const [index, formFactor] of (["mobile", "desktop"] as FormFactor[]).entries()) {
    const result = route.results.find((item) => item.formFactor === formFactor);
    const row = sheet.getRow(6 + index);
    row.values = [
      titleCase(formFactor),
      result?.scores.performance ?? "N/A",
      result?.scores.accessibility ?? "N/A",
      result?.scores["best-practices"] ?? "N/A",
      result?.scores.seo ?? "N/A",
      result?.scores.pwa ?? "N/A"
    ];
  }
  applyScoreFormatting(sheet, "B6:F7");

  sheet.getRow(10).values = ["Metric", "Unit", "Mobile value", "Mobile score", "Desktop value", "Desktop score", "Target (Good)"];
  styleHeaderRow(sheet.getRow(10));
  const mobile = route.results.find((item) => item.formFactor === "mobile");
  const desktop = route.results.find((item) => item.formFactor === "desktop");
  metricRows.forEach((metric, offset) => {
    const rowNumber = 11 + offset;
    const row = sheet.getRow(rowNumber);
    row.values = [
      metric.label,
      metric.unit,
      mobile?.metrics[metric.key].value ?? "N/A",
      mobile?.metrics[metric.key].score ?? "N/A",
      desktop?.metrics[metric.key].value ?? "N/A",
      desktop?.metrics[metric.key].score ?? "N/A",
      metric.target
    ];
  });
  applyScoreFormatting(sheet, "D11:D17");
  applyScoreFormatting(sheet, "F11:F17");
  metricRows.forEach((metric, offset) => {
    const rowNumber = 11 + offset;
    applyMetricFormatting(sheet, `C${rowNumber}:C${rowNumber}`, metric.key);
    applyMetricFormatting(sheet, `E${rowNumber}:E${rowNumber}`, metric.key);
  });

  let cursor = 18;
  for (const result of route.results) {
    cursor = addRunsBlock(sheet, result, cursor);
    cursor += 2;
  }
  addOpportunitiesBlock(sheet, route.results, cursor);
}

function addRunsBlock(sheet: ExcelJS.Worksheet, result: FormFactorReport, startRow: number): number {
  sheet.getCell(`A${startRow}`).value = `${titleCase(result.formFactor)} - ${result.runsTotal} runs`;
  sheet.getCell(`A${startRow}`).font = { bold: true };
  const headerRow = sheet.getRow(startRow + 1);
  headerRow.values = ["", "Run 1", "Run 2", "Run 3", "Run 4", "Run 5", "Median", "Min", "Max"];
  styleHeaderRow(headerRow);

  const rows = [
    { label: "Performance", type: "score", getValue: (run: RawRun) => run.scores.performance },
    { label: "Accessibility", type: "score", getValue: (run: RawRun) => run.scores.accessibility },
    { label: "Best Practices", type: "score", getValue: (run: RawRun) => run.scores["best-practices"] },
    { label: "SEO", type: "score", getValue: (run: RawRun) => run.scores.seo },
    { label: "PWA", type: "score", getValue: (run: RawRun) => run.scores.pwa },
    { label: "LCP (ms)", type: "lcp", getValue: (run: RawRun) => run.metrics.lcp },
    { label: "CLS", type: "cls", getValue: (run: RawRun) => run.metrics.cls },
    { label: "TBT (ms)", type: "tbt", getValue: (run: RawRun) => run.metrics.tbt },
    { label: "FCP (ms)", type: "fcp", getValue: (run: RawRun) => run.metrics.fcp },
    { label: "Speed Index", type: "speedIndex", getValue: (run: RawRun) => run.metrics.speedIndex },
    { label: "TTI (ms)", type: "tti", getValue: (run: RawRun) => run.metrics.tti }
  ] as const;

  rows.forEach((definition, offset) => {
    const rowNumber = startRow + 2 + offset;
    const valuesByRunIndex = new Map(result.runs.map((run) => [run.runIndex, definition.getValue(run) ?? "N/A"]));
    const padded = Array.from({ length: 5 }, (_, index) => valuesByRunIndex.get(index + 1) ?? "N/A");
    const values = result.runs.map((run) => definition.getValue(run) ?? "N/A");
    const medianValue = getMedianRunValue(result, definition.getValue);
    const numericValues = values.filter((value): value is number => typeof value === "number");
    sheet.getRow(rowNumber).values = [
      definition.label,
      ...padded,
      medianValue ?? "N/A",
      numericValues.length ? Math.min(...numericValues) : "N/A",
      numericValues.length ? Math.max(...numericValues) : "N/A"
    ];

    if (definition.type === "score") {
      applyScoreFormatting(sheet, `B${rowNumber}:G${rowNumber}`);
    } else {
      applyMetricFormatting(sheet, `B${rowNumber}:G${rowNumber}`, definition.type);
    }
  });

  return startRow + 2 + rows.length;
}

function addOpportunitiesBlock(sheet: ExcelJS.Worksheet, results: FormFactorReport[], startRow: number): void {
  sheet.getCell(`A${startRow}`).value = "Top opportunities";
  sheet.getCell(`A${startRow}`).font = { bold: true };
  const headerRow = sheet.getRow(startRow + 1);
  headerRow.values = ["Form factor", "Audit ID", "Title", "Savings (ms)", "Description"];
  styleHeaderRow(headerRow);
  let rowNumber = startRow + 2;
  for (const result of results) {
    for (const opportunity of result.opportunities.slice(0, 10)) {
      sheet.getRow(rowNumber).values = [
        titleCase(result.formFactor),
        opportunity.auditId,
        opportunity.title,
        opportunity.savingsMs,
        opportunity.description
      ];
      sheet.getRow(rowNumber).getCell(5).alignment = { wrapText: true };
      rowNumber += 1;
    }
  }
}

function addDiagnosticsSheet(workbook: ExcelJS.Workbook, report: AuditReport): void {
  const sheet = workbook.addWorksheet("Diagnostics");
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.columns = [
    { header: "Timestamp", key: "timestamp", width: 26 },
    { header: "Route", key: "route", width: 28 },
    { header: "Form Factor", key: "formFactor", width: 14 },
    { header: "Run", key: "runIndex", width: 8 },
    { header: "Severity", key: "severity", width: 12 },
    { header: "Code", key: "code", width: 18 },
    { header: "Message", key: "message", width: 80 }
  ];
  styleHeaderRow(sheet.getRow(1));
  report.diagnostics.forEach((diagnostic) => sheet.addRow(diagnostic));
  sheet.autoFilter = { from: "A1", to: `G${Math.max(1, sheet.lastRow?.number ?? 1)}` };
}

function addRunConfigurationSheet(workbook: ExcelJS.Workbook, report: AuditReport): void {
  const sheet = workbook.addWorksheet("Run Configuration");
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.columns = [{ width: 30 }, { width: 70 }];
  styleHeaderRow(sheet.getRow(1));
  sheet.getRow(1).values = ["Key", "Value"];

  const entries: Array<[string, string | number]> = [
    ["Base URL", report.baseUrl],
    ["Auditor", report.displayName],
    ["Started at", report.startedAt],
    ["Finished at", report.finishedAt],
    ["Duration", `${report.summary.durationSec}s`],
    ["Lighthouse version", report.lighthouseVersion],
    ["Chrome version", report.chromeVersion],
    ["Node.js version", report.nodeVersion],
    ["Form factors", report.formFactors.join(", ")],
    ["Throttling preset", report.throttlingLabel],
    ["Categories", report.categories.join(", ")],
    ["Runs per page", report.runsPerPage],
    ["Median method", "computeMedianRun (closest to median FCP+TTI)"],
    ["Total routes", report.summary.totalRoutes],
    ["Total runs", report.summary.totalRuns],
    ["Successful runs", report.summary.successfulRuns],
    ["Auth", report.authSummary]
  ];

  if (report.environments?.length) {
    entries.push(["Environments", report.environments.map((environment) => `${environment.name}: ${environment.baseUrl}`).join("; ")]);
  }

  for (const [key, value] of Object.entries(report.throttling)) {
    entries.splice(10, 0, [`  ${key}`, value]);
  }

  entries.push(["Audit mode", report.mode === "manual-tabs" ? "Manual Chrome Tabs" : "Static LP Audit"]);
  if (report.mode === "manual-tabs") {
    entries.push(["Cache policy", report.cachePolicy === "preserve-profile" ? "preserve profile" : (report.cachePolicy ?? "preserve profile")]);
    entries.push(["Evidence mode", report.evidenceMode ?? "none"]);
  }

  entries.forEach(([key, value]) => sheet.addRow([key, value]));
}

function getMedianRunValue(
  result: FormFactorReport,
  getter: (run: RawRun) => number | null | undefined
): number | null | undefined {
  const selectedRun = result.runs.find((run) => run.runIndex === result.medianRunIndex);
  return selectedRun ? getter(selectedRun) : null;
}

function titleCase(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function hasCompareEnvironments(report: AuditReport): boolean {
  return (report.environments?.length ?? 0) > 1;
}

function findEnvironmentResult(
  report: AuditReport,
  environmentName: string,
  routePath: string,
  formFactor: FormFactor
): FormFactorReport | undefined {
  const normalize = (r: string) => {
    const str = String(r ?? "");
    // Trim leading/trailing slashes
    const cleaned = str.replace(/^\/+/g, "").replace(/\/+$/g, "");
    // Remove a leading NN- numeric prefix if present (e.g. "01-")
    const withoutPrefix = cleaned.replace(/^\d{2}-/, "");
    // Strip query string and hash
    const pathnameOnly = withoutPrefix.split(/[?#]/, 1)[0];
    return `/${pathnameOnly || "root"}`;
  };

  const target = normalize(routePath);
  return report.routes
    .find((route) => normalize(route.route) === target && route.environment?.name === environmentName)
    ?.results.find((result) => result.formFactor === formFactor);
}
