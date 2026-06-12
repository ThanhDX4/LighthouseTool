import { describe, expect, it } from "vitest";
import { createDownloadTokenService } from "../src/server/download-token.js";

const secret = Buffer.alloc(32, 9).toString("base64");

describe("download token service", () => {
  it("issues a one-time token scoped to the job id", async () => {
    const service = createDownloadTokenService({ secret, store: new Map() });
    const token = await service.issue("job-123");

    await expect(service.verify("job-123", token)).resolves.toEqual({ jobId: "job-123" });
    await expect(service.verify("job-123", token)).resolves.toEqual({ jobId: "job-123" });
    await expect(service.consume("job-123", token)).resolves.toEqual({ jobId: "job-123" });
    await expect(service.consume("job-123", token)).rejects.toThrow(/already used/i);
    await expect(service.consume("other-job", token)).rejects.toThrow(/job/i);
  });
});
