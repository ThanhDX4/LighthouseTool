import {
    Download,
    ExternalLink,
    FileText,
    Hourglass,
    Radio,
} from "lucide-react";
import type {
    EvidenceIndexLink,
    HtmlReportLink,
    JobResponse,
    ProgressState,
} from "./job-detail.js";
import {
    EmptyState,
    ProgressBar,
    StatusPill,
    buttonClass,
    cn,
    eyebrowClass,
    surfaceClass,
} from "./ui.js";

interface JobProgressPanelProps {
    apiBase: string;
    progress: ProgressState;
    job: JobResponse | null;
    downloadToken: string | null;
    htmlReports: HtmlReportLink[];
    evidenceIndex: EvidenceIndexLink | null;
    logs: string[];
}

export function JobProgressPanel({
    apiBase,
    progress,
    job,
    downloadToken,
    htmlReports,
    evidenceIndex,
    logs,
}: JobProgressPanelProps) {
    const isRunning =
        progress.status === "running" || progress.status === "queued";

    return (
        <aside className="lg:sticky lg:top-24 lg:self-start">
            <div className={cn(surfaceClass, "overflow-hidden p-6 sm:p-7")}>
                <header className="flex items-start justify-between gap-3">
                    <div>
                        <p className={eyebrowClass}>Run telemetry</p>
                        <h2 className="mt-1 text-[17px] font-semibold tracking-tight text-ink-950">
                            Job progress
                        </h2>
                    </div>
                    <StatusPill status={progress.status} pulse={isRunning} />
                </header>

                <div className="mt-6 space-y-2">
                    <ProgressBar
                        percent={progress.percent}
                        running={isRunning}
                    />
                    <div className="flex items-center justify-between text-[12px] font-medium text-ink-500">
                        <span className="tabular text-ink-950">
                            {Math.round(progress.percent)}%
                        </span>
                        <span className="inline-flex items-center gap-1.5 tabular">
                            {progress.etaSeconds ? (
                                <>
                                    <Hourglass
                                        size={12}
                                        strokeWidth={1.8}
                                        aria-hidden
                                    />
                                    {formatEta(progress.etaSeconds)} ETA
                                </>
                            ) : (
                                <span className="text-ink-400">
                                    ETA pending
                                </span>
                            )}
                        </span>
                    </div>
                </div>

                <p className="mt-4 text-[13.5px] leading-6 text-ink-700">
                    {progress.message || (
                        <span className="text-ink-400">
                            No job running yet. Submit the form to begin.
                        </span>
                    )}
                </p>

                {job && downloadToken ? (
                    <a
                        className={cn(buttonClass("primary"), "mt-6 w-full")}
                        href={`${apiBase}${job.downloadUrl}?token=${encodeURIComponent(downloadToken)}`}
                    >
                        <Download
                            size={16}
                            strokeWidth={1.8}
                            aria-hidden="true"
                        />
                        Download Excel report
                    </a>
                ) : null}

                {job && downloadToken && htmlReports.length > 0 ? (
                    <section className="mt-6 rounded-2xl border border-ink-200/70 bg-ink-50/60 p-4">
                        <div className="flex items-center gap-2">
                            <FileText
                                size={14}
                                strokeWidth={1.8}
                                aria-hidden="true"
                                className="text-ink-500"
                            />
                            <p
                                className={cn(
                                    eyebrowClass,
                                    "text-ink-600",
                                )}
                            >
                                HTML evidence
                            </p>
                        </div>
                        <div className="mt-3 space-y-1.5">
                            {evidenceIndex ? (
                                <EvidenceRow
                                    primary="Evidence index"
                                    href={`${apiBase}${evidenceIndex.downloadUrl}?token=${encodeURIComponent(downloadToken)}`}
                                />
                            ) : null}
                            {htmlReports.map((report) => (
                                <EvidenceRow
                                    key={report.fileName}
                                    primary={`${report.route} · ${report.formFactor} · run ${report.runIndex}`}
                                    secondary={report.environment?.name}
                                    href={`${apiBase}${report.downloadUrl}?token=${encodeURIComponent(downloadToken)}`}
                                />
                            ))}
                        </div>
                    </section>
                ) : null}
            </div>

            <div className="mt-5">
                <div className="mb-3 flex items-center justify-between px-1">
                    <div className="flex items-center gap-2">
                        <Radio
                            size={13}
                            strokeWidth={1.8}
                            aria-hidden
                            className={cn(
                                "text-ink-500",
                                isRunning && "text-accent-600 pulse-soft",
                            )}
                        />
                        <p className={eyebrowClass}>Event stream</p>
                    </div>
                    <span className="text-[11px] font-medium tabular text-ink-400">
                        {logs.length} {logs.length === 1 ? "event" : "events"}
                    </span>
                </div>
                {logs.length === 0 ? (
                    <EmptyState
                        title="Waiting for events"
                        description="Worker logs and progress updates stream in here while the audit runs."
                        icon={<Radio strokeWidth={1.6} />}
                    />
                ) : (
                    <div
                        className="scrollbar-thin max-h-[320px] overflow-y-auto rounded-2xl border border-ink-200/70 bg-ink-950 p-4 font-mono text-[11.5px] leading-[1.7] text-ink-100"
                        aria-live="polite"
                    >
                        {logs.map((line, index) => (
                            <div
                                key={`${line}-${index}`}
                                className="grid grid-cols-[auto_1fr] gap-3"
                            >
                                <span className="select-none tabular text-ink-500">
                                    {String(index + 1).padStart(3, "0")}
                                </span>
                                <span className="break-words">{line}</span>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </aside>
    );
}

function EvidenceRow({
    primary,
    secondary,
    href,
}: {
    primary: string;
    secondary?: string | undefined;
    href: string;
}) {
    return (
        <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="group flex items-center justify-between gap-3 rounded-xl border border-transparent bg-white/80 px-3 py-2 text-[12.5px] text-ink-700 transition duration-150 hover:-translate-y-px hover:border-ink-200 hover:bg-white hover:text-ink-950 hover:shadow-[0_8px_18px_-12px_rgba(15,23,42,0.25)]"
        >
            <span className="min-w-0 truncate">
                {secondary ? (
                    <span className="mr-1 font-mono text-[11px] text-ink-400">
                        {secondary} ›
                    </span>
                ) : null}
                <span>{primary}</span>
            </span>
            <ExternalLink
                size={13}
                strokeWidth={1.8}
                aria-hidden="true"
                className="shrink-0 text-ink-400 transition group-hover:translate-x-0.5 group-hover:text-ink-700"
            />
        </a>
    );
}

export function formatEta(seconds: number) {
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return `${minutes}m ${String(rest).padStart(2, "0")}s`;
}
