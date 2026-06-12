import { describe, expect, it } from "vitest";
import { buildAllRunsFailedMessage } from "../src/worker/audit-worker.js";

describe("audit worker failures", () => {
  it("includes the first Lighthouse failure reason when all runs fail", () => {
    expect(
      buildAllRunsFailedMessage([
        {
          timestamp: "2026-06-05T00:00:00.000Z",
          route: "/",
          formFactor: "desktop",
          runIndex: 1,
          severity: "error",
          code: "RUN_FAILED",
          message: "Navigation timed out after 120000 ms"
        }
      ])
    ).toBe("All Lighthouse runs failed. First error: Navigation timed out after 120000 ms");
  });
});
