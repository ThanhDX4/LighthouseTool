import { describe, expect, it } from "vitest";
import { buildLighthouseHtmlReport } from "../src/report/lighthouse-html.js";

describe("Lighthouse HTML report generation", () => {
  it("renders the standalone Lighthouse report HTML and sanitizes embedded JSON", () => {
    const html = buildLighthouseHtmlReport({
      requestedUrl: "https://example.com/",
      finalDisplayedUrl: "https://example.com/",
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
      audits: {
        "script-safety": {
          id: "script-safety",
          title: "Script Safety",
          description: "</script><script>alert(1)</script>",
          score: 1,
          scoreDisplayMode: "binary"
        }
      },
      configSettings: { output: "html" }
    });

    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Performance");
    expect(html).toContain("\\u003c/script>");
    expect(html).not.toContain("</script><script>alert(1)</script>");
  });
});
