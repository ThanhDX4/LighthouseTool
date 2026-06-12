import {
    ArrowUpRight,
    CheckCircle2,
    Clock3,
    Globe2,
    Inbox,
    RefreshCcw,
    Route,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
    deriveJobHistoryState,
    type JobHistoryItem,
    type JobHistoryResponse,
} from "./job-history.js";
import {
    EmptyState,
    ErrorBanner,
    Panel,
    StatusPill,
    buttonClass,
    cn,
    eyebrowClass,
} from "./ui.js";

export function JobHistory({
    apiBase,
    onOpenJob,
}: {
    apiBase: string;
    onOpenJob: (jobId: string, detailUrl: string) => void;
}) {
    const [jobs, setJobs] = useState<JobHistoryItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const loadJobs = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const response = await fetch(`${apiBase}/jobs`, {
                credentials: "same-origin",
                headers: { Accept: "application/json" },
            });
            if (!response.ok) {
                const body = await response.json().catch(() => ({}));
                throw new Error(body.error ?? `HTTP ${response.status}`);
            }
            const body = (await response.json()) as JobHistoryResponse;
            setJobs(deriveJobHistoryState(body));
        } catch (loadError) {
            setError(
                loadError instanceof Error
                    ? loadError.message
                    : String(loadError),
            );
        } finally {
            setLoading(false);
        }
    }, [apiBase]);

    useEffect(() => {
        void loadJobs();
    }, [loadJobs]);

    return (
        <div className="mx-auto w-full max-w-[1100px] space-y-6 px-5 pb-16 sm:px-8 lg:px-10">
            <Panel
                eyebrow="History"
                title="Audit jobs"
                description="Browse retained audits. Open any entry to review its configuration and download the report."
                actions={
                    <button
                        type="button"
                        onClick={() => void loadJobs()}
                        className={buttonClass("secondary", "sm")}
                    >
                        <RefreshCcw
                            size={14}
                            strokeWidth={1.8}
                            aria-hidden="true"
                            className={cn(loading && "animate-spin")}
                        />
                        Refresh
                    </button>
                }
            >
                {error ? <ErrorBanner>{error}</ErrorBanner> : null}

                {loading ? <HistorySkeleton /> : null}

                {!loading && jobs.length === 0 && !error ? (
                    <EmptyState
                        title="No retained audits yet"
                        description="Submitted audits appear here once the worker stores them. Run a new audit to populate the history."
                        icon={<Inbox strokeWidth={1.6} />}
                    />
                ) : null}

                {!loading && jobs.length > 0 ? (
                    <ul className="divide-y divide-ink-200/70 overflow-hidden rounded-2xl border border-ink-200/70 bg-white">
                        {jobs.map((job) => (
                            <li key={job.jobId}>
                                <a
                                    href={job.detailUrl}
                                    onClick={(event) => {
                                        event.preventDefault();
                                        onOpenJob(job.jobId, job.detailUrl);
                                    }}
                                    className="group flex items-stretch gap-4 px-5 py-4 transition duration-150 hover:bg-ink-50/70 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-accent-500/20 sm:px-6 sm:py-5"
                                >
                                    <div className="hidden flex-col items-center pt-1 sm:flex">
                                        <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-ink-400">
                                            ID
                                        </span>
                                        <span className="mt-1 font-mono text-[12px] tabular text-ink-600">
                                            {job.jobId.slice(0, 6)}
                                        </span>
                                    </div>

                                    <div className="min-w-0 flex-1">
                                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                                            <h3 className="truncate text-[15.5px] font-semibold tracking-tight text-ink-950">
                                                {job.displayName}
                                            </h3>
                                            <StatusPill status={job.status} />
                                        </div>

                                        <div className="mt-1.5 flex items-center gap-1.5 text-[12.5px] text-ink-600">
                                            <Globe2
                                                size={13}
                                                strokeWidth={1.8}
                                                aria-hidden="true"
                                                className="shrink-0 text-ink-400"
                                            />
                                            <span className="truncate font-mono">
                                                {job.baseUrl ??
                                                    "URL unavailable"}
                                            </span>
                                        </div>

                                        <dl className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[12px] text-ink-500">
                                            <div className="flex items-center gap-1.5">
                                                <Clock3
                                                    size={13}
                                                    strokeWidth={1.8}
                                                    aria-hidden
                                                />
                                                <dt className="sr-only">
                                                    Finished
                                                </dt>
                                                <dd className="tabular">
                                                    {formatJobDate(
                                                        job.finishedAt ??
                                                            job.startedAt,
                                                    )}
                                                </dd>
                                            </div>
                                            <div className="flex items-center gap-1.5">
                                                <Route
                                                    size={13}
                                                    strokeWidth={1.8}
                                                    aria-hidden
                                                />
                                                <dt className="sr-only">
                                                    Routes
                                                </dt>
                                                <dd className="tabular">
                                                    {job.summary?.totalRoutes ??
                                                        0}{" "}
                                                    routes
                                                </dd>
                                            </div>
                                            <div className="flex items-center gap-1.5">
                                                <CheckCircle2
                                                    size={13}
                                                    strokeWidth={1.8}
                                                    aria-hidden
                                                />
                                                <dt className="sr-only">
                                                    Runs
                                                </dt>
                                                <dd className="tabular">
                                                    {job.summary
                                                        ?.successfulRuns ?? 0}
                                                    /
                                                    {job.summary?.totalRuns ??
                                                        0}{" "}
                                                    runs
                                                </dd>
                                            </div>
                                        </dl>
                                    </div>

                                    <span
                                        aria-hidden="true"
                                        className="flex items-center self-center text-ink-300 transition duration-200 group-hover:translate-x-0.5 group-hover:text-ink-700"
                                    >
                                        <ArrowUpRight
                                            size={18}
                                            strokeWidth={1.8}
                                        />
                                    </span>
                                </a>
                            </li>
                        ))}
                    </ul>
                ) : null}
            </Panel>
        </div>
    );
}

function HistorySkeleton() {
    return (
        <div className="space-y-2 rounded-2xl border border-ink-200/70 bg-white p-4">
            {Array.from({ length: 3 }).map((_, index) => (
                <div
                    key={index}
                    className="flex items-center gap-4 rounded-xl bg-ink-100/50 px-4 py-4"
                >
                    <div className="size-2 rounded-full bg-ink-200 pulse-soft" />
                    <div className="h-3 w-40 rounded-full bg-ink-200 pulse-soft" />
                    <div className="ml-auto h-3 w-16 rounded-full bg-ink-200/80 pulse-soft" />
                </div>
            ))}
            <p className={cn(eyebrowClass, "px-2 pt-2 text-ink-400")}>
                Loading jobs…
            </p>
        </div>
    );
}

function formatJobDate(value?: string) {
    if (!value) return "Time unavailable";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Time unavailable";
    return new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
    }).format(date);
}
