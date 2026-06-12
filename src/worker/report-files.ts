import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import type ExcelJS from "exceljs";
import { redactAuditConfig } from "../config/safe-audit-config.js";
import { buildLighthouseHtmlReport } from "../report/lighthouse-html.js";
import type { AuditConfig, AuditEnvironment } from "../types/config.js";
import type { AuditReport } from "../types/report.js";

export interface LighthouseEvidenceRun {
  environment?: AuditEnvironment | undefined;
  route: string;
  url: string;
  formFactor: string;
  runIndex: number;
  lhr: unknown;
}

export interface LighthouseHtmlReportFile {
  environment?: AuditEnvironment | undefined;
  route: string;
  url: string;
  formFactor: string;
  runIndex: number;
  fileName: string;
  relativePath: string;
}

export interface EvidenceIndexHtmlReportFile {
  fileName: string;
  relativePath: string;
}

export type EvidenceMode = "none" | "html";

export interface EvidenceDiagnostic {
  route: string;
  formFactor: string;
  runIndex: number;
  reason: string;
}

export interface WriteReportFilesOptions {
  auditConfig?: AuditConfig | undefined;
  lighthouseRuns?: readonly LighthouseEvidenceRun[];
  evidenceMode?: EvidenceMode | undefined;
  maxEvidenceFiles?: number | undefined;
  maxEvidenceBytes?: number | undefined;
}

export async function writeReportFiles(dataDir: string, report: AuditReport, workbook: ExcelJS.Workbook, options: WriteReportFilesOptions = {}): Promise<{
  reportDir: string;
  reportPath: string;
  sha256: string;
  htmlReports: LighthouseHtmlReportFile[];
  indexHtmlReport?: EvidenceIndexHtmlReportFile | undefined;
  evidenceDiagnostics: EvidenceDiagnostic[];
}> {
  const reportDir = path.join(dataDir, "jobs", report.jobId);
  await fs.mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, "report.xlsx");
  await workbook.xlsx.writeFile(reportPath);
  const sha256 = await sha256File(reportPath);
  const evidenceMode = options.evidenceMode ?? (report.mode === "manual-tabs" ? "none" : "html");
  const evidenceRuns = evidenceMode === "none" ? [] : options.lighthouseRuns ?? [];
  const { htmlReports, evidenceDiagnostics } = await writeLighthouseHtmlReports(
    reportDir,
    evidenceRuns,
    options.maxEvidenceBytes
  );
  const indexHtmlReport = await writeEvidenceIndexHtmlReport(reportDir, report, htmlReports);
  await fs.writeFile(path.join(reportDir, "report.xlsx.sha256"), `${sha256}\n`, "utf8");
  await fs.writeFile(
  path.join(reportDir, "meta.json"),
    JSON.stringify(
      {
        jobId: report.jobId,
        baseUrl: report.baseUrl,
        displayName: report.displayName,
        mode: report.mode ?? "static",
        cachePolicy: report.cachePolicy,
        evidenceMode: report.mode === "manual-tabs" ? evidenceMode : undefined,
        summary: report.summary,
        lighthouseVersion: report.lighthouseVersion,
        chromeVersion: report.chromeVersion,
        startedAt: report.startedAt,
        finishedAt: report.finishedAt,
        status: report.summary.status,
        config: options.auditConfig ? redactAuditConfig(options.auditConfig) : undefined,
        evidence: {
          htmlReports,
          indexHtmlReport
        }
      },
      null,
      2
    ),
    "utf8"
  );
  return { reportDir, reportPath, sha256, htmlReports, indexHtmlReport, evidenceDiagnostics };
}

export async function cleanupOldReports(dataDir: string): Promise<void> {
  const root = path.join(dataDir, "jobs");
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const dir = path.join(root, entry.name);
          const stat = await fs.stat(dir);
          if (stat.mtimeMs < cutoff) await fs.rm(dir, { recursive: true, force: true });
        })
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function writeLighthouseHtmlReports(
  reportDir: string,
  runs: readonly LighthouseEvidenceRun[],
  maxEvidenceBytes?: number
): Promise<{ htmlReports: LighthouseHtmlReportFile[]; evidenceDiagnostics: EvidenceDiagnostic[] }> {
  if (runs.length === 0) return { htmlReports: [], evidenceDiagnostics: [] };

  const evidenceDir = path.join(reportDir, "evidence");
  await fs.mkdir(evidenceDir, { recursive: true });

  const htmlReports: LighthouseHtmlReportFile[] = [];
  const evidenceDiagnostics: EvidenceDiagnostic[] = [];

  for (const [index, run] of runs.entries()) {
    const fileName = buildEvidenceFileName(run, index);
  const relativePath = path.posix.join("evidence", fileName);
  const absolutePath = path.join(reportDir, "evidence", fileName);
    const html = buildLighthouseHtmlReport(run.lhr);

    if (typeof maxEvidenceBytes === "number" && Buffer.byteLength(html, "utf8") > maxEvidenceBytes) {
      evidenceDiagnostics.push({
        route: run.route,
        formFactor: run.formFactor,
        runIndex: run.runIndex,
        reason: `Evidence file exceeded the ${maxEvidenceBytes}-byte limit and was discarded`
      });
      continue;
    }

    await fs.writeFile(absolutePath, html, "utf8");
    htmlReports.push({
      environment: run.environment ? { ...run.environment } : undefined,
      route: run.route,
      url: run.url,
      formFactor: run.formFactor,
      runIndex: run.runIndex,
      fileName,
      relativePath
    });
  }

  return { htmlReports, evidenceDiagnostics };
}

function buildEvidenceFileName(run: LighthouseEvidenceRun, index: number): string {
  const sequence = String(index + 1).padStart(2, "0");
  const environmentPart = run.environment ? `${sanitizeEvidencePart(run.environment.name)}-` : "";
  return `lighthouse-${sequence}-${environmentPart}${sanitizeEvidencePart(run.route)}-${sanitizeEvidencePart(run.formFactor)}-run-${run.runIndex}.html`;
}

function sanitizeEvidencePart(value: string): string {
  const routePart = value === "/" ? "root" : value.replace(/^\/+/, "");
  return routePart.replace(/[^a-zA-Z0-9.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "report";
}

async function writeEvidenceIndexHtmlReport(
  reportDir: string,
  report: AuditReport,
  htmlReports: readonly LighthouseHtmlReportFile[]
): Promise<EvidenceIndexHtmlReportFile | undefined> {
  if (htmlReports.length === 0) return undefined;

  const evidenceDir = path.join(reportDir, "evidence");
  await fs.mkdir(evidenceDir, { recursive: true });
  const indexHtmlReport = {
    fileName: "index.html",
    relativePath: path.posix.join("evidence", "index.html")
  };
  await fs.writeFile(path.join(reportDir, "evidence", indexHtmlReport.fileName), buildEvidenceIndexHtml(report, htmlReports), "utf8");
  return indexHtmlReport;
}

function buildEvidenceIndexHtml(report: AuditReport, htmlReports: readonly LighthouseHtmlReportFile[]): string {
  const rows = htmlReports
    .map((item) => {
      const environment = item.environment?.name ?? report.displayName;
      return `<tr>
        <td>${escapeHtml(environment)}</td>
        <td>${escapeHtml(item.route)}</td>
        <td>${escapeHtml(item.formFactor)}</td>
        <td>${escapeHtml(String(item.runIndex))}</td>
        <td><a href="./${encodeURIComponent(item.fileName)}">${escapeHtml(item.fileName)}</a></td>
      </tr>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Lighthouse evidence index</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 32px; color: #111827; }
    h1 { margin-bottom: 4px; }
    .muted { color: #6b7280; margin-top: 0; }
    table { border-collapse: collapse; width: 100%; margin-top: 24px; }
    th, td { border: 1px solid #d1d5db; padding: 10px 12px; text-align: left; vertical-align: top; }
    th { background: #1f3864; color: white; }
    tr:nth-child(even) { background: #f9fafb; }
    a { color: #0563c1; }
  </style>
</head>
<body>
  <h1>Lighthouse evidence index</h1>
  <p class="muted">${escapeHtml(report.displayName)} · ${escapeHtml(report.finishedAt)}</p>
  <table>
    <thead>
      <tr>
        <th>Environment</th>
        <th>Route</th>
        <th>Form factor</th>
        <th>Run</th>
        <th>Evidence</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
