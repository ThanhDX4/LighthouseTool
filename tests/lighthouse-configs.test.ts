import { describe, expect, it } from "vitest";
import { resolveLighthouseOnlyCategories } from "../src/lighthouse/configs.js";

describe("Lighthouse config helpers", () => {
  it("omits the deprecated PWA category from Lighthouse flags while preserving runnable categories", () => {
    expect(
      resolveLighthouseOnlyCategories(["performance", "accessibility", "best-practices", "seo", "pwa"])
    ).toEqual(["performance", "accessibility", "best-practices", "seo"]);
  });

  it("falls back to runnable defaults when PWA is the only selected category", () => {
    expect(resolveLighthouseOnlyCategories(["pwa"])).toEqual([
      "performance",
      "accessibility",
      "best-practices",
      "seo"
    ]);
  });
});
