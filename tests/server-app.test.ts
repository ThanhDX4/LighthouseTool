import { promises as fs } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import { isEncryptedSecret } from "../src/security/credentials.js";
import { createDownloadTokenService } from "../src/server/download-token.js";

const encryptionKey = Buffer.alloc(32, 4).toString("base64");
const tokenSecret = Buffer.alloc(32, 5).toString("base64");

describe("Fastify app job submission", () => {
  it("lists persisted jobs newest first without exposing saved config", async () => {
    const dataDir = await fs.mkdtemp(join(tmpdir(), "lh-job-list-"));
    const jobsDir = join(dataDir, "jobs");
    await fs.mkdir(join(jobsDir, "older-job"), { recursive: true });
    await fs.mkdir(join(jobsDir, "newer-job"), { recursive: true });
    await fs.mkdir(join(jobsDir, "invalid-job"), { recursive: true });
    await fs.mkdir(join(jobsDir, "non-object-job"), { recursive: true });
    await fs.writeFile(
      join(jobsDir, "older-job", "meta.json"),
      JSON.stringify({
        jobId: "older-job",
        baseUrl: "https://older.example.com",
        startedAt: "2026-06-05T09:00:00.000Z",
        finishedAt: "2026-06-05T09:10:00.000Z",
        status: "completed",
        summary: { totalRoutes: 2, totalRuns: 4, successfulRuns: 4, durationSec: 600, status: "completed" },
        config: { displayName: "Older audit", formLogin: { username: "private@example.com" } }
      })
    );
    await fs.writeFile(
      join(jobsDir, "newer-job", "meta.json"),
      JSON.stringify({
        jobId: "newer-job",
        baseUrl: "https://newer.example.com",
        startedAt: "2026-06-06T09:00:00.000Z",
        finishedAt: "2026-06-06T09:05:00.000Z",
        summary: { totalRoutes: 1, totalRuns: 2, successfulRuns: 1, durationSec: 300, status: "partial" },
        config: { displayName: "Newer audit", basicAuth: { username: "private-user" } }
      })
    );
    await fs.writeFile(join(jobsDir, "invalid-job", "meta.json"), "{invalid");
    await fs.writeFile(join(jobsDir, "non-object-job", "meta.json"), "null");
    const app = await buildApp({
      encryptionKey,
      downloadTokenSecret: tokenSecret,
      dataDir,
      queue: { add: async () => ({ id: "unused" }), getJobs: async () => [] } as any,
      tokenStore: new Map()
    });

    const response = await app.inject({
      method: "GET",
      url: "/jobs",
      headers: { accept: "application/json" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      jobs: [
        {
          jobId: "newer-job",
          detailUrl: "/jobs/newer-job",
          status: "partial",
          baseUrl: "https://newer.example.com",
          displayName: "Newer audit",
          startedAt: "2026-06-06T09:00:00.000Z",
          finishedAt: "2026-06-06T09:05:00.000Z",
          summary: { totalRoutes: 1, totalRuns: 2, successfulRuns: 1, durationSec: 300, status: "partial" }
        },
        {
          jobId: "older-job",
          detailUrl: "/jobs/older-job",
          status: "completed",
          baseUrl: "https://older.example.com",
          displayName: "Older audit",
          startedAt: "2026-06-05T09:00:00.000Z",
          finishedAt: "2026-06-05T09:10:00.000Z",
          summary: { totalRoutes: 2, totalRuns: 4, successfulRuns: 4, durationSec: 600, status: "completed" }
        }
      ]
    });
    expect(response.body).not.toContain("config");
    expect(response.body).not.toContain("private");

    await app.close();
  });

  it("serves the SPA for an HTML navigation to the jobs history route", async () => {
    const dataDir = await fs.mkdtemp(join(tmpdir(), "lh-job-list-page-"));
    const staticDir = await fs.mkdtemp(join(tmpdir(), "lh-static-"));
    await fs.writeFile(join(staticDir, "index.html"), "<!doctype html><title>Audit UI</title>");
    const app = await buildApp({
      encryptionKey,
      downloadTokenSecret: tokenSecret,
      dataDir,
      staticDir,
      queue: { add: async () => ({ id: "unused" }), getJobs: async () => [] } as any,
      tokenStore: new Map()
    });

    const response = await app.inject({
      method: "GET",
      url: "/jobs",
      headers: { accept: "text/html" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("<title>Audit UI</title>");

    await app.close();
  });

  it("requires CSRF, validates payload, encrypts credentials, and enqueues the audit job", async () => {
    const enqueued: any[] = [];
    const app = await buildApp({
      encryptionKey,
      downloadTokenSecret: tokenSecret,
      dataDir: "/tmp/lh-audit-test",
      queue: {
        add: async (name: string, data: any, options: any) => {
          enqueued.push({ name, data, options });
          return { id: data.jobId };
        },
        getJobs: async () => []
      } as any,
      tokenStore: new Map()
    });

    const missingCsrf = await app.inject({
      method: "POST",
      url: "/jobs",
      payload: { baseUrl: "https://example.com", paths: ["/"], formFactors: ["mobile"] }
    });
    expect(missingCsrf.statusCode).toBe(403);

    const csrf = await app.inject({ method: "GET", url: "/csrf-token" });
    const csrfBody = csrf.json<{ csrfToken: string }>();
    const cookie = csrf.headers["set-cookie"];

    const response = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: {
        "x-csrf-token": csrfBody.csrfToken,
        cookie: Array.isArray(cookie) ? cookie[0] : cookie
      },
      payload: {
        baseUrl: "https://example.com",
        paths: ["/"],
        formFactors: ["mobile"],
        basicAuth: { enabled: true, username: "stage", password: "top-secret" }
      }
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      eventsUrl: expect.stringMatching(/^\/jobs\/.+\/events$/),
      downloadUrl: expect.stringMatching(/^\/jobs\/.+\/download$/)
    });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].name).toBe("run-audit");
    expect(enqueued[0].options.removeOnComplete).toEqual({ age: 60 });
    expect(isEncryptedSecret(enqueued[0].data.config.basicAuth.password)).toBe(true);
    expect(JSON.stringify(enqueued[0].data)).not.toContain("top-secret");

    await app.close();
  });

  it("sets Secure CSRF cookies in production mode and downloads with host timestamp filename", async () => {
    const dataDir = await fs.mkdtemp(join(tmpdir(), "lh-download-"));
    const jobId = "job-download";
    const reportDir = join(dataDir, "jobs", jobId);
    await fs.mkdir(reportDir, { recursive: true });
    await fs.writeFile(join(reportDir, "report.xlsx"), "xlsx");
    await fs.writeFile(
      join(reportDir, "meta.json"),
      JSON.stringify({
        baseUrl: "https://staging.example.com",
        finishedAt: "2026-06-05T09:10:00.000Z"
      })
    );
    const tokenStore = new Map();
    const app = await buildApp({
      encryptionKey,
      downloadTokenSecret: tokenSecret,
      dataDir,
      secureCookies: true,
      queue: { add: async () => ({ id: "unused" }), getJobs: async () => [] } as any,
      tokenStore
    });

    const csrf = await app.inject({ method: "GET", url: "/csrf-token" });
    expect(String(csrf.headers["set-cookie"])).toContain("Secure");

    const token = await createDownloadTokenService({ secret: tokenSecret, store: tokenStore }).issue(jobId);
    const download = await app.inject({
      method: "GET",
      url: `/jobs/${jobId}/download?token=${encodeURIComponent(token)}`
    });

    expect(download.statusCode).toBe(200);
    expect(download.headers["content-disposition"]).toContain(
      'filename="lighthouse-staging.example.com-20260605-0910.xlsx"'
    );

    await app.close();
  });

  it("serves generated Lighthouse HTML evidence reports with a reusable job-scoped token", async () => {
    const dataDir = await fs.mkdtemp(join(tmpdir(), "lh-evidence-download-"));
    const jobId = "job-evidence";
    const evidenceDir = join(dataDir, "jobs", jobId, "evidence");
    await fs.mkdir(evidenceDir, { recursive: true });
    await fs.writeFile(join(evidenceDir, "lighthouse-01-root-desktop-run-1.html"), "<!doctype html><title>Lighthouse</title>");
    const tokenStore = new Map();
    const app = await buildApp({
      encryptionKey,
      downloadTokenSecret: tokenSecret,
      dataDir,
      queue: { add: async () => ({ id: "unused" }), getJobs: async () => [] } as any,
      tokenStore
    });
    const token = await createDownloadTokenService({ secret: tokenSecret, store: tokenStore }).issue(jobId);

    const firstView = await app.inject({
      method: "GET",
      url: `/jobs/${jobId}/evidence/lighthouse-01-root-desktop-run-1.html?token=${encodeURIComponent(token)}`
    });
    const secondView = await app.inject({
      method: "GET",
      url: `/jobs/${jobId}/evidence/lighthouse-01-root-desktop-run-1.html?token=${encodeURIComponent(token)}`
    });

    expect(firstView.statusCode).toBe(200);
    expect(firstView.headers["content-type"]).toContain("text/html");
    expect(firstView.headers["content-disposition"]).toContain("inline");
    expect(firstView.headers["content-security-policy"]).toContain("sandbox allow-scripts");
    expect(firstView.headers["content-security-policy"]).not.toContain("allow-same-origin");
    expect(firstView.body).toContain("<title>Lighthouse</title>");
    expect(secondView.statusCode).toBe(200);

    await app.close();
  });

  it("returns persisted job detail with safe input config and fresh report links", async () => {
    const dataDir = await fs.mkdtemp(join(tmpdir(), "lh-job-detail-"));
    const jobId = "job-detail";
    const reportDir = join(dataDir, "jobs", jobId);
    await fs.mkdir(reportDir, { recursive: true });
    await fs.writeFile(join(reportDir, "report.xlsx"), "xlsx");
    await fs.writeFile(
      join(reportDir, "meta.json"),
      JSON.stringify({
        jobId,
        baseUrl: "https://staging.example.com",
        displayName: "Staging audit",
        startedAt: "2026-06-05T09:00:00.000Z",
        finishedAt: "2026-06-05T09:10:00.000Z",
        status: "completed",
        summary: {
          totalRoutes: 2,
          totalRuns: 4,
          successfulRuns: 4,
          durationSec: 600,
          status: "completed"
        },
        config: {
          baseUrl: "https://staging.example.com",
          displayName: "Staging audit",
          paths: ["/", "/orders"],
          formFactors: ["desktop", "mobile"],
          categories: ["performance", "seo"],
          runsPerPage: 2,
          throttling: {
            preset: "custom",
            custom: {
              rttMs: 80,
              throughputKbps: 5000,
              cpuSlowdownMultiplier: 2
            }
          },
          basicAuth: {
            enabled: true,
            username: "stage-user"
          },
          formLogin: {
            enabled: true,
            loginUrl: "https://staging.example.com/login",
            usernameSelector: "input[name=\"email\"]",
            username: "qa@example.com",
            passwordSelector: "input[name=\"password\"]",
            submitSelector: "button[type=\"submit\"]",
            postLogin: {
              mode: "selector",
              selector: "[data-testid=\"home\"]",
              timeoutMs: 15000
            }
          }
        },
        evidence: {
          indexHtmlReport: {
            fileName: "index.html",
            relativePath: "evidence/index.html"
          },
          htmlReports: [
            {
              route: "/orders",
              url: "https://staging.example.com/orders",
              formFactor: "desktop",
              runIndex: 1,
              fileName: "lighthouse-01-orders-desktop-run-1.html",
              relativePath: "evidence/lighthouse-01-orders-desktop-run-1.html"
            }
          ]
        }
      })
    );
    const app = await buildApp({
      encryptionKey,
      downloadTokenSecret: tokenSecret,
      dataDir,
      queue: { add: async () => ({ id: "unused" }), getJobs: async () => [] } as any,
      tokenStore: new Map()
    });

    const detail = await app.inject({
      method: "GET",
      url: `/jobs/${jobId}/detail`
    });

    expect(detail.statusCode).toBe(200);
    const body = detail.json<any>();
    expect(body).toMatchObject({
      jobId,
      eventsUrl: `/jobs/${jobId}/events`,
      downloadUrl: `/jobs/${jobId}/download`,
      queuePosition: 0,
      status: "completed",
      summary: {
        totalRuns: 4,
        successfulRuns: 4,
        status: "completed"
      },
      config: {
        baseUrl: "https://staging.example.com",
        displayName: "Staging audit",
        paths: ["/", "/orders"],
        formFactors: ["desktop", "mobile"],
        categories: ["performance", "seo"],
        runsPerPage: 2,
        throttling: {
          preset: "custom",
          custom: {
            rttMs: 80,
            throughputKbps: 5000,
            cpuSlowdownMultiplier: 2
          }
        },
        basicAuth: {
          enabled: true,
          username: "stage-user"
        },
        formLogin: {
          enabled: true,
          loginUrl: "https://staging.example.com/login",
          username: "qa@example.com",
          postLogin: {
            mode: "selector",
            selector: "[data-testid=\"home\"]",
            timeoutMs: 15000
          }
        }
      },
      htmlReports: [
        {
          route: "/orders",
          formFactor: "desktop",
          runIndex: 1,
          downloadUrl: `/jobs/${jobId}/evidence/lighthouse-01-orders-desktop-run-1.html`
        }
      ],
      evidenceIndex: {
        fileName: "index.html",
        downloadUrl: `/jobs/${jobId}/evidence/index.html`
      }
    });
    expect(body.downloadToken).toEqual(expect.any(String));
    expect(body.config.basicAuth).not.toHaveProperty("password");
    expect(body.config.formLogin).not.toHaveProperty("password");

    const download = await app.inject({
      method: "GET",
      url: `/jobs/${jobId}/download?token=${encodeURIComponent(body.downloadToken)}`
    });
    expect(download.statusCode).toBe(200);

    await app.close();
  });

  it("derives safe input config from legacy metadata when config is missing", async () => {
    const dataDir = await fs.mkdtemp(join(tmpdir(), "lh-job-detail-legacy-"));
    const jobId = "job-detail-legacy";
    const reportDir = join(dataDir, "jobs", jobId);
    await fs.mkdir(reportDir, { recursive: true });
    await fs.writeFile(join(reportDir, "report.xlsx"), "xlsx");
    await fs.writeFile(
      join(reportDir, "meta.json"),
      JSON.stringify({
        jobId,
        baseUrl: "https://aefoodstore.us",
        status: "completed",
        summary: {
          totalRoutes: 1,
          totalRuns: 10,
          successfulRuns: 10,
          durationSec: 155,
          status: "completed"
        },
        evidence: {
          htmlReports: [
            {
              route: "/home",
              url: "https://aefoodstore.us/home",
              formFactor: "desktop",
              runIndex: 1,
              fileName: "lighthouse-01-home-desktop-run-1.html",
              relativePath: "evidence/lighthouse-01-home-desktop-run-1.html"
            },
            {
              route: "/home",
              url: "https://aefoodstore.us/home",
              formFactor: "desktop",
              runIndex: 5,
              fileName: "lighthouse-05-home-desktop-run-5.html",
              relativePath: "evidence/lighthouse-05-home-desktop-run-5.html"
            },
            {
              route: "/home",
              url: "https://aefoodstore.us/home",
              formFactor: "mobile",
              runIndex: 5,
              fileName: "lighthouse-10-home-mobile-run-5.html",
              relativePath: "evidence/lighthouse-10-home-mobile-run-5.html"
            }
          ]
        }
      })
    );
    const app = await buildApp({
      encryptionKey,
      downloadTokenSecret: tokenSecret,
      dataDir,
      queue: { add: async () => ({ id: "unused" }), getJobs: async () => [] } as any,
      tokenStore: new Map()
    });

    const detail = await app.inject({
      method: "GET",
      url: `/jobs/${jobId}/detail`
    });

    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      jobId,
      status: "completed",
      config: {
        baseUrl: "https://aefoodstore.us",
        displayName: "aefoodstore.us",
        paths: ["/home"],
        formFactors: ["desktop", "mobile"],
        categories: ["performance", "accessibility", "best-practices", "seo", "pwa"],
        runsPerPage: 5,
        throttling: { preset: "slow-4g" },
        basicAuth: { enabled: false },
        formLogin: {
          enabled: false,
          usernameSelector: "input[name=\"email\"]",
          passwordSelector: "input[name=\"password\"]",
          submitSelector: "button[type=\"submit\"]",
          postLogin: { mode: "navigation", timeoutMs: 30000 }
        }
      }
    });

    await app.close();
  });

  it("verifies evidence tokens before revealing whether an HTML file exists", async () => {
    const dataDir = await fs.mkdtemp(join(tmpdir(), "lh-evidence-token-"));
    const jobId = "job-evidence";
    const evidenceDir = join(dataDir, "jobs", jobId, "evidence");
    await fs.mkdir(evidenceDir, { recursive: true });
    await fs.writeFile(join(evidenceDir, "lighthouse-01-root-desktop-run-1.html"), "<!doctype html>");
    const app = await buildApp({
      encryptionKey,
      downloadTokenSecret: tokenSecret,
      dataDir,
      queue: { add: async () => ({ id: "unused" }), getJobs: async () => [] } as any,
      tokenStore: new Map()
    });
    const wrongJobToken = await createDownloadTokenService({ secret: tokenSecret, store: new Map() }).issue("other-job");

    const existing = await app.inject({
      method: "GET",
      url: `/jobs/${jobId}/evidence/lighthouse-01-root-desktop-run-1.html?token=${encodeURIComponent(wrongJobToken)}`
    });
    const missing = await app.inject({
      method: "GET",
      url: `/jobs/${jobId}/evidence/missing.html?token=${encodeURIComponent(wrongJobToken)}`
    });

    expect(existing.statusCode).toBe(401);
    expect(missing.statusCode).toBe(401);

    await app.close();
  });

  it("reports queuePosition 1 for the second waiting job", async () => {
    const jobs: Array<{ id: string }> = [];
    const app = await buildApp({
      encryptionKey,
      downloadTokenSecret: tokenSecret,
      dataDir: "/tmp/lh-audit-test",
      queue: {
        add: async (_name: string, data: any) => {
          jobs.push({ id: data.jobId });
          return { id: data.jobId };
        },
        getJobs: async () => jobs
      } as any,
      tokenStore: new Map()
    });

    const first = await postValidJob(app);
    const second = await postValidJob(app);

    expect(first.queuePosition).toBe(0);
    expect(second.queuePosition).toBe(1);

    await app.close();
  });

  it("streams queued, mapped progress events, completion, and closes QueueEvents", async () => {
    const queueEvents = new FakeQueueEvents();
    const app = await buildApp({
      encryptionKey,
      downloadTokenSecret: tokenSecret,
      dataDir: "/tmp/lh-audit-test",
      queue: {
        add: async () => ({ id: "job-1" }),
        getJobs: async () => [{ id: "job-1" }]
      } as any,
      queueEventsFactory: () => queueEvents,
      tokenStore: new Map()
    });

    const stream = app.inject({ method: "GET", url: "/jobs/job-1/events" });
    await waitForListeners(queueEvents, "progress", 1);
    queueEvents.emit("progress", { jobId: "other", data: { eventName: "warn", message: "ignored" } });
    queueEvents.emit("progress", { jobId: "job-1", data: { phase: "started", totalRuns: 2 } });
    queueEvents.emit("progress", { jobId: "job-1", data: { percent: 50, message: "halfway" } });
    queueEvents.emit("progress", { jobId: "job-1", data: { eventName: "warn", message: "run failed" } });
    queueEvents.emit("progress", { jobId: "job-1", data: { eventName: "route-completed", route: "/" } });
    queueEvents.emit("completed", { jobId: "job-1", returnvalue: { downloadUrl: "/jobs/job-1/download" } });

    const response = await stream;
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("event: queued");
    expect(response.body).toContain("event: started");
    expect(response.body).toContain("event: progress");
    expect(response.body).toContain("event: warn");
    expect(response.body).toContain("event: route-completed");
    expect(response.body).toContain("event: done");
    expect(response.body).not.toContain("ignored");
    expect(queueEvents.closed).toBe(true);

    await app.close();
  });
});

async function postValidJob(app: Awaited<ReturnType<typeof buildApp>>) {
  const csrf = await app.inject({ method: "GET", url: "/csrf-token" });
  const csrfBody = csrf.json<{ csrfToken: string }>();
  const cookie = csrf.headers["set-cookie"];
  const response = await app.inject({
    method: "POST",
    url: "/jobs",
    headers: {
      "x-csrf-token": csrfBody.csrfToken,
      cookie: Array.isArray(cookie) ? cookie[0] : cookie
    },
    payload: {
      baseUrl: "https://example.com",
      paths: ["/"],
      formFactors: ["mobile"]
    }
  });
  expect(response.statusCode).toBe(202);
  return response.json<{ queuePosition: number }>();
}

class FakeQueueEvents extends EventEmitter {
  closed = false;

  on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  off(event: string, listener: (...args: any[]) => void): this {
    return super.off(event, listener);
  }

  async close() {
    this.closed = true;
  }
}

async function waitForListeners(emitter: EventEmitter, event: string, count: number) {
  const startedAt = Date.now();
  while (emitter.listenerCount(event) < count) {
    if (Date.now() - startedAt > 1000) throw new Error(`Timed out waiting for ${event} listeners`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
