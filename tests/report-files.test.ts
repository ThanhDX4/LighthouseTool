import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupOldReports, writeReportFiles } from "../src/worker/report-files.js";
import type { AuditConfig } from "../src/types/config.js";
import type { AuditReport } from "../src/types/report.js";

describe("report file cleanup", () => {
  it("deletes job report directories older than 24 hours and keeps recent reports", async () => {
    const dataDir = await fs.mkdtemp(join(tmpdir(), "lh-cleanup-"));
    const oldDir = join(dataDir, "jobs", "old-job");
    const freshDir = join(dataDir, "jobs", "fresh-job");
    await fs.mkdir(oldDir, { recursive: true });
    await fs.mkdir(freshDir, { recursive: true });
    await fs.writeFile(join(oldDir, "report.xlsx"), "old");
    await fs.writeFile(join(freshDir, "report.xlsx"), "fresh");

    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await fs.utimes(oldDir, oldTime, oldTime);

    await cleanupOldReports(dataDir);

    await expect(fs.stat(oldDir)).rejects.toThrow(/ENOENT/);
    await expect(fs.stat(freshDir)).resolves.toBeTruthy();
  });

  it("does not fail when no jobs directory exists", async () => {
    const dataDir = await fs.mkdtemp(join(tmpdir(), "lh-cleanup-empty-"));

    await expect(cleanupOldReports(dataDir)).resolves.toBeUndefined();
  });
});

describe("report file evidence", () => {
  it("writes one Lighthouse HTML evidence file for each successful run and records them in metadata", async () => {
    const dataDir = await fs.mkdtemp(join(tmpdir(), "lh-report-files-"));
    const workbook = {
      xlsx: {
        writeFile: async (path: string) => {
          await fs.writeFile(path, "xlsx");
        }
      }
    };

    const result = await writeReportFiles(dataDir, minimalReport, workbook as any, {
      auditConfig: sensitiveAuditConfig,
      lighthouseRuns: [
        { route: "/", url: "https://example.com/", formFactor: "desktop", runIndex: 1, lhr: minimalLhr("/") },
        { route: "/orders", url: "https://example.com/orders", formFactor: "mobile", runIndex: 2, lhr: minimalLhr("/orders") }
      ]
    });

    expect(result.htmlReports).toEqual([
      expect.objectContaining({ route: "/", formFactor: "desktop", runIndex: 1, fileName: expect.stringMatching(/01-root-desktop-run-1\.html$/) }),
      expect.objectContaining({ route: "/orders", formFactor: "mobile", runIndex: 2, fileName: expect.stringMatching(/02-orders-mobile-run-2\.html$/) })
    ]);

    const firstHtml = await fs.readFile(join(result.reportDir, "evidence", result.htmlReports[0]!.fileName), "utf8");
    expect(firstHtml).toContain("<!doctype html>");
    expect(firstHtml).toContain("Performance");

    const meta = JSON.parse(await fs.readFile(join(result.reportDir, "meta.json"), "utf8"));
    expect(meta.displayName).toBe("Example");
    expect(meta.evidence.htmlReports).toEqual(result.htmlReports);
    expect(meta.config).toMatchObject({
      baseUrl: "https://example.com",
      displayName: "Example",
      paths: ["/", "/orders"],
      formFactors: ["desktop", "mobile"],
      categories: ["performance", "seo"],
      runsPerPage: 2,
      throttling: {
        preset: "custom",
        custom: {
          rttMs: 75,
          throughputKbps: 4096,
          cpuSlowdownMultiplier: 2
        }
      },
      basicAuth: {
        enabled: true,
        username: "stage-user"
      },
      formLogin: {
        enabled: true,
        loginUrl: "https://example.com/login",
        usernameSelector: "input[name=\"email\"]",
        username: "qa@example.com",
        passwordSelector: "input[name=\"password\"]",
        submitSelector: "button[type=\"submit\"]",
        postLogin: {
          mode: "delay",
          delayMs: 1000,
          timeoutMs: 30000
        }
      }
    });
    expect(meta.config.basicAuth).not.toHaveProperty("password");
    expect(meta.config.formLogin).not.toHaveProperty("password");
    expect(JSON.stringify(meta)).not.toContain("basic-secret");
    expect(JSON.stringify(meta)).not.toContain("login-secret");
  });

  it("writes a shared evidence index that groups Lighthouse reports by environment", async () => {
    const dataDir = await fs.mkdtemp(join(tmpdir(), "lh-report-index-"));
    const workbook = {
      xlsx: {
        writeFile: async (path: string) => {
          await fs.writeFile(path, "xlsx");
        }
      }
    };

    const result = await writeReportFiles(dataDir, compareReport as AuditReport, workbook as any, {
      auditConfig: compareAuditConfig as AuditConfig,
      lighthouseRuns: [
        {
          environment: { name: "Dev 1", baseUrl: "https://dev1.example.com" },
          route: "/mypage",
          url: "https://dev1.example.com/mypage",
          formFactor: "desktop",
          runIndex: 1,
          lhr: minimalLhr("/mypage")
        },
        {
          environment: { name: "Dev 3", baseUrl: "https://dev3.example.com" },
          route: "/mypage",
          url: "https://dev3.example.com/mypage",
          formFactor: "mobile",
          runIndex: 1,
          lhr: minimalLhr("/mypage")
        }
      ]
    });

    expect(result.indexHtmlReport).toEqual({
      fileName: "index.html",
      relativePath: "evidence/index.html"
    });
    expect(result.htmlReports).toEqual([
      expect.objectContaining({ environment: { name: "Dev 1", baseUrl: "https://dev1.example.com" } }),
      expect.objectContaining({ environment: { name: "Dev 3", baseUrl: "https://dev3.example.com" } })
    ]);

    const indexHtml = await fs.readFile(join(result.reportDir, "evidence", "index.html"), "utf8");
    expect(indexHtml).toContain("Lighthouse evidence index");
    expect(indexHtml).toContain("Dev 1");
    expect(indexHtml).toContain("Dev 3");
    expect(indexHtml).toContain(result.htmlReports[0]!.fileName);
    expect(indexHtml).toContain(result.htmlReports[1]!.fileName);

    const meta = JSON.parse(await fs.readFile(join(result.reportDir, "meta.json"), "utf8"));
    expect(meta.evidence.indexHtmlReport).toEqual(result.indexHtmlReport);
  });
});

describe("manual tabs evidence privacy", () => {
  it("writes no HTML evidence when evidenceMode is none", async () => {
    const dataDir = await fs.mkdtemp(join(tmpdir(), "lh-manual-none-"));
    const result = await writeReportFiles(dataDir, manualReport, fakeWorkbook() as any, {
      auditConfig: manualAuditConfig,
      evidenceMode: "none",
      lighthouseRuns: [
        { route: "/manual-tabs/01-dashboard", url: "https://app.example.com/dashboard", formFactor: "desktop", runIndex: 1, lhr: minimalLhr("/dashboard") }
      ]
    });

    expect(result.htmlReports).toEqual([]);
    expect(result.indexHtmlReport).toBeUndefined();
    await expect(fs.stat(join(result.reportDir, "evidence"))).rejects.toThrow(/ENOENT/);

    const meta = JSON.parse(await fs.readFile(join(result.reportDir, "meta.json"), "utf8"));
    expect(meta.mode).toBe("manual-tabs");
    expect(meta.evidenceMode).toBe("none");
    expect(meta.evidence.htmlReports).toEqual([]);
  });

  it("writes HTML evidence when evidenceMode is html", async () => {
    const dataDir = await fs.mkdtemp(join(tmpdir(), "lh-manual-html-"));
    const result = await writeReportFiles(dataDir, manualReport, fakeWorkbook() as any, {
      auditConfig: manualAuditConfig,
      evidenceMode: "html",
      lighthouseRuns: [
        { route: "/manual-tabs/01-dashboard", url: "https://app.example.com/dashboard", formFactor: "desktop", runIndex: 1, lhr: minimalLhr("/dashboard") }
      ]
    });

    expect(result.htmlReports).toHaveLength(1);
    expect(result.evidenceDiagnostics).toEqual([]);
    await expect(fs.stat(join(result.reportDir, "evidence", result.htmlReports[0]!.fileName))).resolves.toBeTruthy();
  });

  it("discards an oversized evidence file and records a diagnostic", async () => {
    const dataDir = await fs.mkdtemp(join(tmpdir(), "lh-manual-oversized-"));
    const result = await writeReportFiles(dataDir, manualReport, fakeWorkbook() as any, {
      auditConfig: manualAuditConfig,
      evidenceMode: "html",
      maxEvidenceBytes: 10,
      lighthouseRuns: [
        { route: "/manual-tabs/01-dashboard", url: "https://app.example.com/dashboard", formFactor: "desktop", runIndex: 1, lhr: minimalLhr("/dashboard") }
      ]
    });

    expect(result.htmlReports).toEqual([]);
    expect(result.evidenceDiagnostics).toHaveLength(1);
    expect(result.evidenceDiagnostics[0]).toMatchObject({
      route: "/manual-tabs/01-dashboard",
      formFactor: "desktop",
      runIndex: 1
    });
  });

  it("never writes the raw manual auditUrl query string into meta.json", async () => {
    const dataDir = await fs.mkdtemp(join(tmpdir(), "lh-manual-redact-"));
    const result = await writeReportFiles(dataDir, manualReport, fakeWorkbook() as any, {
      auditConfig: manualAuditConfig,
      evidenceMode: "none"
    });

    const meta = await fs.readFile(join(result.reportDir, "meta.json"), "utf8");
    expect(meta).not.toContain("token=secret-query");
    expect(meta).not.toContain("super-secret");
  });
});

function fakeWorkbook() {
  return {
    xlsx: {
      writeFile: async (path: string) => {
        await fs.writeFile(path, "xlsx");
      }
    }
  };
}

const manualReport: AuditReport = {
  jobId: "job-manual",
  baseUrl: "https://app.example.com",
  displayName: "Manual checkout",
  mode: "manual-tabs",
  cachePolicy: "preserve-profile",
  evidenceMode: "none",
  startedAt: "2026-06-11T01:00:00.000Z",
  finishedAt: "2026-06-11T01:05:00.000Z",
  lighthouseVersion: "13.3.0",
  chromeVersion: "138.0.0.0",
  nodeVersion: "22.16.0",
  categories: ["performance"],
  formFactors: ["desktop"],
  runsPerPage: 1,
  throttlingLabel: "Slow 4G",
  throttling: {},
  authSummary: "Manual browser authentication (Manual Chrome Tabs)",
  routes: [],
  diagnostics: [],
  summary: { totalRoutes: 1, totalRuns: 1, successfulRuns: 1, durationSec: 300, status: "completed" }
};

const manualAuditConfig = {
  mode: "manual-tabs",
  displayName: "Manual checkout",
  baseUrl: "https://app.example.com",
  paths: ["/manual-tabs/01-dashboard"],
  formFactors: ["desktop"],
  categories: ["performance"],
  runsPerPage: 1,
  throttling: { preset: "slow-4g" },
  basicAuth: { enabled: false },
  formLogin: {
    enabled: false,
    usernameSelector: "input[name=\"email\"]",
    passwordSelector: "input[name=\"password\"]",
    submitSelector: "button[type=\"submit\"]",
    postLogin: { mode: "navigation", timeoutMs: 30_000 }
  },
  manualChrome: {
    cachePolicy: "preserve-profile",
    evidenceMode: "none",
    execution: {
      profileSessionId: "profile-1",
      ownerToken: "super-secret",
      fencingNumber: 7,
      targets: [
        {
          targetId: "target-1",
          profileSessionId: "profile-1",
          ownerNonce: "nonce-1",
          serverInstanceId: "boot-1",
          auditUrl: "https://app.example.com/dashboard?token=secret-query",
          displayUrl: "https://app.example.com/dashboard",
          route: "/manual-tabs/01-dashboard",
          selectedAt: "2026-06-11T00:00:00.000Z"
        }
      ]
    }
  }
} as unknown as AuditConfig;

const minimalReport: AuditReport = {
  jobId: "job-1",
  baseUrl: "https://example.com",
  displayName: "Example",
  startedAt: "2026-06-05T01:00:00.000Z",
  finishedAt: "2026-06-05T01:10:00.000Z",
  lighthouseVersion: "13.3.0",
  chromeVersion: "138.0.0.0",
  nodeVersion: "22.16.0",
  categories: ["performance"],
  formFactors: ["desktop"],
  runsPerPage: 2,
  throttlingLabel: "Desktop",
  throttling: {},
  authSummary: "Basic Auth: disabled; Form Login: disabled",
  routes: [],
  diagnostics: [],
  summary: { totalRoutes: 1, totalRuns: 2, successfulRuns: 2, durationSec: 600, status: "completed" }
};

const sensitiveAuditConfig: AuditConfig = {
  baseUrl: "https://example.com",
  displayName: "Example",
  paths: ["/", "/orders"],
  formFactors: ["desktop", "mobile"],
  categories: ["performance", "seo"],
  runsPerPage: 2,
  throttling: {
    preset: "custom",
    custom: {
      rttMs: 75,
      throughputKbps: 4096,
      cpuSlowdownMultiplier: 2
    }
  },
  basicAuth: {
    enabled: true,
    username: "stage-user",
    password: "basic-secret"
  },
  formLogin: {
    enabled: true,
    loginUrl: "https://example.com/login",
    usernameSelector: "input[name=\"email\"]",
    username: "qa@example.com",
    passwordSelector: "input[name=\"password\"]",
    password: "login-secret",
    submitSelector: "button[type=\"submit\"]",
    postLogin: {
      mode: "delay",
      delayMs: 1000,
      timeoutMs: 30000
    }
  }
};

const compareAuditConfig = {
  ...sensitiveAuditConfig,
  baseUrl: "https://dev1.example.com",
  displayName: "Dev compare",
  environments: [
    { name: "Dev 1", baseUrl: "https://dev1.example.com" },
    { name: "Dev 3", baseUrl: "https://dev3.example.com" }
  ],
  paths: ["/mypage"]
};

const compareReport = {
  ...minimalReport,
  jobId: "job-compare",
  baseUrl: "multiple-environments",
  displayName: "Dev compare",
  environments: [
    { name: "Dev 1", baseUrl: "https://dev1.example.com" },
    { name: "Dev 3", baseUrl: "https://dev3.example.com" }
  ]
};

function minimalLhr(path: string) {
  return {
    requestedUrl: `https://example.com${path}`,
    finalDisplayedUrl: `https://example.com${path}`,
    fetchTime: "2026-06-05T09:10:00.000Z",
    lighthouseVersion: "13.3.0",
    categories: {
      performance: {
        id: "performance",
        title: "Performance",
        score: 0.91,
        auditRefs: []
      }
    },
    audits: {},
    configSettings: { output: "html" }
  };
}
