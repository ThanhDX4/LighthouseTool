import { describe, expect, it } from "vitest";
import { deriveJobDetailState, deriveSubmittedJobState } from "../web/src/job-detail.js";

describe("job detail UI hydration", () => {
  it("maps a completed job detail response back into form and result state without secrets", () => {
    const state = deriveJobDetailState({
      jobId: "job-detail",
      eventsUrl: "/jobs/job-detail/events",
      downloadUrl: "/jobs/job-detail/download",
      queuePosition: 0,
      status: "completed",
      downloadToken: "fresh-token",
      summary: {
        totalRuns: 4,
        successfulRuns: 4,
        status: "completed"
      },
      htmlReports: [
        {
          route: "/orders",
          formFactor: "desktop",
          runIndex: 1,
          fileName: "lighthouse-01-orders-desktop-run-1.html",
          downloadUrl: "/jobs/job-detail/evidence/lighthouse-01-orders-desktop-run-1.html"
        }
      ],
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
      }
    });

    expect(state.job).toEqual({
      jobId: "job-detail",
      eventsUrl: "/jobs/job-detail/events",
      downloadUrl: "/jobs/job-detail/download",
      queuePosition: 0
    });
    expect(state.progress).toEqual({
      percent: 100,
      message: "Report ready",
      status: "done"
    });
    expect(state.downloadToken).toBe("fresh-token");
    expect(state.htmlReports).toHaveLength(1);
    expect(state.form).toMatchObject({
      baseUrl: "https://staging.example.com",
      displayName: "Staging audit",
      pathsText: "/\n/orders",
      formFactors: ["desktop", "mobile"],
      categories: ["performance", "seo"],
      runsPerPage: 2,
      throttlingPreset: "custom",
      customRtt: 80,
      customThroughput: 5000,
      customCpu: 2,
      basicEnabled: true,
      basicUsername: "stage-user",
      basicPassword: "",
      formLoginEnabled: true,
      loginUrl: "https://staging.example.com/login",
      username: "qa@example.com",
      password: "",
      postLoginMode: "selector",
      postLoginSelector: "[data-testid=\"home\"]",
      postLoginDelay: 2000,
      postLoginTimeout: 15000
    });
  });

  it("hydrates compare environments and the shared evidence index link", () => {
    const state = deriveJobDetailState({
      jobId: "job-compare",
      eventsUrl: "/jobs/job-compare/events",
      downloadUrl: "/jobs/job-compare/download",
      queuePosition: 0,
      status: "completed",
      downloadToken: "fresh-token",
      summary: {
        totalRuns: 4,
        successfulRuns: 4,
        status: "completed"
      },
      evidenceIndex: {
        fileName: "index.html",
        downloadUrl: "/jobs/job-compare/evidence/index.html"
      },
      config: {
        baseUrl: "https://dev1.example.com",
        displayName: "Dev compare",
        environments: [
          { name: "Dev 1", baseUrl: "https://dev1.example.com" },
          { name: "Dev 3", baseUrl: "https://dev3.example.com" }
        ],
        paths: ["/mypage"],
        formFactors: ["desktop", "mobile"],
        categories: ["performance"],
        runsPerPage: 1,
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

    expect(state.evidenceIndex).toEqual({
      fileName: "index.html",
      downloadUrl: "/jobs/job-compare/evidence/index.html"
    });
    expect(state.form).toMatchObject({
      compareEnabled: true,
      environmentsText: "Dev 1=https://dev1.example.com\nDev 3=https://dev3.example.com"
    });
  });

  it("starts a newly submitted job in queued progress state so events reconnect after a completed job", () => {
    const state = deriveSubmittedJobState({
      jobId: "new-job",
      eventsUrl: "/jobs/new-job/events",
      downloadUrl: "/jobs/new-job/download",
      queuePosition: 2
    });

    expect(state).toEqual({
      job: {
        jobId: "new-job",
        eventsUrl: "/jobs/new-job/events",
        downloadUrl: "/jobs/new-job/download",
        queuePosition: 2
      },
      progress: {
        percent: 0,
        message: "Queued (position 2)",
        status: "queued"
      }
    });
  });
});
