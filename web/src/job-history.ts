export interface JobHistorySummary {
    totalRoutes?: number;
    totalRuns?: number;
    successfulRuns?: number;
    durationSec?: number;
    status?: string;
}

export interface JobHistoryItem {
    jobId: string;
    detailUrl: string;
    status: string;
    baseUrl?: string;
    displayName: string;
    startedAt?: string;
    finishedAt?: string;
    summary?: JobHistorySummary;
}

export interface JobHistoryResponse {
    jobs: JobHistoryItem[];
}

export function deriveJobHistoryState(
    response: JobHistoryResponse,
): JobHistoryItem[] {
    return response.jobs.map((job) =>
        job.summary
            ? { ...job, summary: { ...job.summary } }
            : { ...job },
    );
}
