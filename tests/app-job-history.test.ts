import { describe, expect, it } from "vitest";
import { deriveJobHistoryState } from "../web/src/job-history.js";

describe("job history UI state", () => {
  it("maps jobs into immutable history items with safe defaults", () => {
    const response = {
      jobs: [
        {
          jobId: "job-1",
          detailUrl: "/jobs/job-1",
          status: "partial",
          baseUrl: "https://example.com",
          displayName: "Example audit",
          startedAt: "2026-06-06T09:00:00.000Z",
          finishedAt: "2026-06-06T09:05:00.000Z",
          summary: {
            totalRoutes: 2,
            totalRuns: 4,
            successfulRuns: 3,
            durationSec: 300,
            status: "partial"
          }
        }
      ]
    };

    const state = deriveJobHistoryState(response);

    expect(state).toEqual([
      {
        jobId: "job-1",
        detailUrl: "/jobs/job-1",
        status: "partial",
        baseUrl: "https://example.com",
        displayName: "Example audit",
        startedAt: "2026-06-06T09:00:00.000Z",
        finishedAt: "2026-06-06T09:05:00.000Z",
        summary: {
          totalRoutes: 2,
          totalRuns: 4,
          successfulRuns: 3,
          durationSec: 300,
          status: "partial"
        }
      }
    ]);
    expect(state).not.toBe(response.jobs);
    expect(state[0]?.summary).not.toBe(response.jobs[0]?.summary);
  });
});
