import type { AuditConfig, CustomThrottling, LighthouseCategory } from "../types/config.js";

const runnableDefaultCategories: Exclude<LighthouseCategory, "pwa">[] = [
  "performance",
  "accessibility",
  "best-practices",
  "seo"
];

export const THROTTLING_PRESETS = {
  "slow-4g": {
    rttMs: 150,
    throughputKbps: 1638.4,
    requestLatencyMs: 562.5,
    downloadThroughputKbps: 1474.56,
    uploadThroughputKbps: 675,
    cpuSlowdownMultiplier: 4
  },
  "fast-3g": {
    rttMs: 80,
    throughputKbps: 1638.4,
    requestLatencyMs: 150,
    downloadThroughputKbps: 1638.4,
    uploadThroughputKbps: 750,
    cpuSlowdownMultiplier: 2
  },
  "slow-3g": {
    rttMs: 300,
    throughputKbps: 700,
    requestLatencyMs: 300,
    downloadThroughputKbps: 500,
    uploadThroughputKbps: 300,
    cpuSlowdownMultiplier: 8
  }
} satisfies Record<string, CustomThrottling & Record<string, number>>;

export function resolveMobileThrottling(config: AuditConfig): Record<string, number> {
  if (config.throttling.preset === "custom") {
    if (!config.throttling.custom) throw new Error("Custom throttling values are required");
    return { ...config.throttling.custom };
  }
  return THROTTLING_PRESETS[config.throttling.preset];
}

export function throttlingLabel(config: AuditConfig): string {
  const labels = {
    "slow-4g": "Slow 4G",
    "fast-3g": "Fast 3G",
    "slow-3g": "Slow 3G",
    custom: "Custom"
  };
  return labels[config.throttling.preset];
}

export function resolveLighthouseOnlyCategories(categories: LighthouseCategory[]): Exclude<LighthouseCategory, "pwa">[] {
  const runnable = categories.filter((category): category is Exclude<LighthouseCategory, "pwa"> => category !== "pwa");
  return runnable.length > 0 ? runnable : runnableDefaultCategories;
}
