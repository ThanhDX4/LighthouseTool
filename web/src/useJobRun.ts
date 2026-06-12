import { useEffect, useState } from "react";
import {
    deriveJobDetailState,
    deriveSubmittedJobState,
    type EvidenceIndexLink,
    type HtmlReportLink,
    type JobDetailResponse,
    type JobResponse,
    type ProgressState,
} from "./job-detail.js";

export interface UseJobRunResult {
    job: JobResponse | null;
    progress: ProgressState;
    downloadToken: string | null;
    htmlReports: HtmlReportLink[];
    evidenceIndex: EvidenceIndexLink | null;
    logs: string[];
    error: string | null;
    loadingJobDetail: boolean;
    running: boolean;
    setError: (error: string | null) => void;
    startJob: (job: JobResponse) => void;
    prepareJobDetail: (jobId: string) => void;
    clearJobResult: () => void;
}

export interface UseJobRunOptions {
    onDetailLoaded?: (detail: JobDetailResponse) => void;
}

/**
 * Owns the run-and-watch lifecycle shared by the static and manual audit
 * screens: job/progress/result state, the job-detail hydration fetch, and the
 * SSE subscription. Form-specific hydration is delegated via `onDetailLoaded`.
 */
export function useJobRun(
    apiBase: string,
    initialJob: JobResponse | null,
    initialLoadingDetail: boolean,
    options: UseJobRunOptions = {},
): UseJobRunResult {
    const { onDetailLoaded } = options;
    const [job, setJob] = useState<JobResponse | null>(initialJob);
    const [loadingJobDetail, setLoadingJobDetail] =
        useState(initialLoadingDetail);
    const [progress, setProgress] = useState<ProgressState>(() =>
        initialLoadingDetail
            ? { percent: 0, message: "Loading job...", status: "queued" }
            : { percent: 0, message: "", status: "idle" },
    );
    const [downloadToken, setDownloadToken] = useState<string | null>(null);
    const [htmlReports, setHtmlReports] = useState<HtmlReportLink[]>([]);
    const [evidenceIndex, setEvidenceIndex] =
        useState<EvidenceIndexLink | null>(null);
    const [logs, setLogs] = useState<string[]>([]);
    const [error, setError] = useState<string | null>(null);

    const running =
        Boolean(job) &&
        progress.status !== "done" &&
        progress.status !== "failed";

    useEffect(() => {
        if (!job || !loadingJobDetail) return;
        let cancelled = false;
        const jobId = job.jobId;

        async function loadJobDetail() {
            try {
                const response = await fetch(
                    `${apiBase}/jobs/${encodeURIComponent(jobId)}/detail`,
                    { credentials: "same-origin" },
                );
                if (!response.ok) {
                    const body = await response.json().catch(() => ({}));
                    throw new Error(body.error ?? `HTTP ${response.status}`);
                }

                const detail = (await response.json()) as JobDetailResponse;
                if (cancelled) return;

                const nextState = deriveJobDetailState(detail);
                setJob(nextState.job);
                onDetailLoaded?.(detail);
                setProgress(nextState.progress);
                setDownloadToken(nextState.downloadToken);
                setHtmlReports(nextState.htmlReports);
                setEvidenceIndex(nextState.evidenceIndex);
                setLogs(
                    nextState.progress.status === "done"
                        ? [
                              `done: ${detail.summary?.successfulRuns ?? 0}/${detail.summary?.totalRuns ?? 0} runs`,
                          ]
                        : [],
                );
                setError(null);
            } catch (detailError) {
                if (cancelled) return;
                setError(
                    detailError instanceof Error
                        ? detailError.message
                        : String(detailError),
                );
                setJob(null);
            } finally {
                if (!cancelled) setLoadingJobDetail(false);
            }
        }

        void loadJobDetail();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [job, loadingJobDetail]);

    useEffect(() => {
        if (
            !job ||
            loadingJobDetail ||
            progress.status === "done" ||
            progress.status === "failed"
        )
            return;
        const source = new EventSource(`${apiBase}${job.eventsUrl}`);
        const append = (line: string) =>
            setLogs((items) => [line, ...items].slice(0, 200));
        const parse = (event: MessageEvent) => JSON.parse(event.data || "{}");

        source.addEventListener("queued", (event) => {
            const data = parse(event as MessageEvent);
            setProgress({
                percent: 0,
                message: `Queued (position ${data.queuePosition ?? 0})`,
                status: "queued",
            });
            append("queued");
        });
        source.addEventListener("started", (event) => {
            const data = parse(event as MessageEvent);
            setProgress({
                percent: 0,
                message: `Started ${data.totalRuns ?? ""} runs`,
                status: "running",
            });
            append("started");
        });
        source.addEventListener("progress", (event) => {
            const data = parse(event as MessageEvent);
            setProgress({
                percent: data.percent ?? 0,
                message: data.message ?? "Running Lighthouse",
                etaSeconds: data.etaSeconds,
                status: "running",
            });
            append(data.message ?? "progress");
        });
        source.addEventListener("warn", (event) => {
            const data = parse(event as MessageEvent);
            append(`warning: ${data.message ?? "run failed"}`);
        });
        source.addEventListener("route-completed", (event) => {
            const data = parse(event as MessageEvent);
            append(`route completed: ${data.route} (${data.formFactor})`);
        });
        source.addEventListener("excel-generating", () => {
            setProgress((current) => ({
                ...current,
                message: "Generating Excel and HTML reports...",
            }));
            append("excel-generating");
        });
        source.addEventListener("done", (event) => {
            const data = parse(event as MessageEvent);
            const nextHtmlReports = Array.isArray(data.htmlReports)
                ? data.htmlReports
                : [];
            setDownloadToken(data.downloadToken);
            setHtmlReports(nextHtmlReports);
            setEvidenceIndex(data.evidenceIndex ?? null);
            setProgress({
                percent: 100,
                message: "Report ready",
                status: "done",
            });
            append(
                `done: ${data.summary?.successfulRuns ?? 0}/${data.summary?.totalRuns ?? 0} runs`,
            );
            if (nextHtmlReports.length > 0) {
                append(`html evidence: ${nextHtmlReports.length} reports`);
            }
            if (data.evidenceIndex) append("html evidence index ready");
            source.close();
        });
        source.addEventListener("failed", (event) => {
            const data = parse(event as MessageEvent);
            setError(data.error ?? "Job failed");
            setProgress((current) => ({
                ...current,
                status: "failed",
                message: data.error ?? "Job failed",
            }));
            append(`failed: ${data.error ?? "unknown error"}`);
            source.close();
        });

        return () => source.close();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [job, loadingJobDetail]);

    function startJob(nextJob: JobResponse) {
        const submittedState = deriveSubmittedJobState(nextJob);
        setLoadingJobDetail(false);
        setDownloadToken(null);
        setHtmlReports([]);
        setEvidenceIndex(null);
        setLogs([]);
        setError(null);
        setProgress(submittedState.progress);
        setJob(submittedState.job);
    }

    function prepareJobDetail(jobId: string) {
        setJob({
            jobId,
            eventsUrl: `/jobs/${jobId}/events`,
            downloadUrl: `/jobs/${jobId}/download`,
            queuePosition: 0,
        });
        setLoadingJobDetail(true);
        setProgress({
            percent: 0,
            message: "Loading job...",
            status: "queued",
        });
        setDownloadToken(null);
        setHtmlReports([]);
        setEvidenceIndex(null);
        setLogs([]);
        setError(null);
    }

    function clearJobResult() {
        setJob(null);
        setLoadingJobDetail(false);
        setProgress({ percent: 0, message: "", status: "idle" });
        setDownloadToken(null);
        setHtmlReports([]);
        setEvidenceIndex(null);
        setLogs([]);
        setError(null);
    }

    return {
        job,
        progress,
        downloadToken,
        htmlReports,
        evidenceIndex,
        logs,
        error,
        loadingJobDetail,
        running,
        setError,
        startJob,
        prepareJobDetail,
        clearJobResult,
    };
}
