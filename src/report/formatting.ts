import type ExcelJS from "exceljs";

export const SCORE_COLORS = {
  good: "FF0CCE6B",
  average: "FFFFA400",
  poor: "FFFF4E40",
  header: "FF1F3864",
  averageRow: "FFF2F2F2"
};

export const metricThresholds = {
  lcp: { good: 2500, average: 4000 },
  cls: { good: 0.1, average: 0.25 },
  tbt: { good: 200, average: 600 },
  fcp: { good: 1800, average: 3000 },
  speedIndex: { good: 3400, average: 5800 },
  tti: { good: 3800, average: 7300 },
  maxPotentialFid: { good: 130, average: 250 },
  inp: { good: 200, average: 500 }
};

// OOXML (ECMA-376 §18.3.1.18) requires every cfRule@priority to be unique within
// a worksheet. Each addConditionalFormatting call would otherwise restart at 1/2/3,
// producing duplicate priorities that desktop Excel tolerates but Excel for the web
// mis-resolves — dropping fill and font color on some cells. We hand out a unique,
// monotonically increasing priority per worksheet instead.
const worksheetPriorityCounters = new WeakMap<ExcelJS.Worksheet, number>();

function nextPriority(sheet: ExcelJS.Worksheet): number {
  const next = (worksheetPriorityCounters.get(sheet) ?? 0) + 1;
  worksheetPriorityCounters.set(sheet, next);
  return next;
}

export function styleHeaderRow(row: ExcelJS.Row): void {
  row.eachCell((cell) => {
    // Keep header bold but avoid setting colors/fills for Excel web compatibility
    cell.font = { bold: true };
    cell.alignment = { vertical: "middle" };
  });
}

export function applyScoreFormatting(sheet: ExcelJS.Worksheet, ref: string): void {
  sheet.addConditionalFormatting({
    ref,
    rules: [
      {
        type: "cellIs",
        operator: "lessThan",
        formulae: ["50"],
        priority: nextPriority(sheet),
        style: {
          // Avoid color/fill for compatibility with Excel for the web; use bold instead
          font: { bold: true }
        }
      },
      {
        type: "cellIs",
        operator: "between",
        formulae: ["50", "89"],
        priority: nextPriority(sheet),
        style: {
          font: { bold: true }
        }
      },
      {
        type: "cellIs",
        operator: "greaterThan",
        formulae: ["89"],
        priority: nextPriority(sheet),
        style: {
          font: { bold: true }
        }
      }
    ]
  });
}

export function applyMetricFormatting(sheet: ExcelJS.Worksheet, ref: string, metric: keyof typeof metricThresholds): void {
  const thresholds = metricThresholds[metric];
  sheet.addConditionalFormatting({
    ref,
    rules: [
      {
        type: "cellIs",
        operator: "between",
        formulae: ["0", String(thresholds.good)],
        priority: nextPriority(sheet),
        // Avoid fill color for Excel web compatibility
        style: { font: { bold: true } }
      },
      {
        type: "cellIs",
        operator: "between",
        formulae: [String(thresholds.good), String(thresholds.average)],
        priority: nextPriority(sheet),
        style: { font: { bold: true } }
      },
      {
        type: "cellIs",
        operator: "greaterThan",
        formulae: [String(thresholds.average)],
        priority: nextPriority(sheet),
        style: {
          font: { bold: true }
        }
      }
    ]
  });
}
