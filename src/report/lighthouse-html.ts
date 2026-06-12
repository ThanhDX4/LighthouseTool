import { generateReport } from "lighthouse";

export function buildLighthouseHtmlReport(lhr: unknown): string {
  return generateReport(lhr as any, "html");
}
