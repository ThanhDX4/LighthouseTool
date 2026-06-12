import { describe, expect, it } from "vitest";
import { readAppRoute } from "../web/src/app-route.js";

describe("client app routes", () => {
  it("distinguishes audit form, job history, and job detail paths", () => {
    expect(readAppRoute("/")).toEqual({ view: "audit" });
    expect(readAppRoute("/jobs")).toEqual({ view: "history" });
    expect(readAppRoute("/jobs/job-one")).toEqual({ view: "detail", jobId: "job-one" });
    expect(readAppRoute("/jobs/job%20one")).toEqual({ view: "audit" });
    expect(readAppRoute("/jobs/job-one/detail")).toEqual({ view: "audit" });
    expect(readAppRoute("/jobs/%E0%A4%A")).toEqual({ view: "audit" });
    expect(readAppRoute("/jobs/%2Fetc")).toEqual({ view: "audit" });
    expect(readAppRoute("/unknown")).toEqual({ view: "audit" });
  });
});
