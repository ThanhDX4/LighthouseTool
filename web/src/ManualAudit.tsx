import {
    ArrowLeft,
    Chrome,
    FileText,
    History as HistoryIcon,
    Layers,
    Lock,
    Play,
    RefreshCw,
    ScanLine,
} from "lucide-react";
import { FormEvent, useState } from "react";
import { JobProgressPanel } from "./JobProgressPanel.js";
import { LighthouseSettings } from "./LighthouseSettings.js";
import { PlainCheckbox, RadioRow } from "./form-controls.js";
import { useJobRun } from "./useJobRun.js";
import { ManualCompareSection } from "./ManualCompareSection.js";
import {
    buildManualPayload,
    deriveScanState,
    isManualCompareValid,
    isManualSubmissionValid,
    isScanExpired,
    toggleSelectedTab,
    type ManualCompareInput,
    type ManualEvidenceMode,
    type ManualScanResponse,
    type ManualScanState,
    type ManualSessionResponse,
} from "./manual-chrome.js";
import type {
    Category,
    FormFactor,
    JobResponse,
    ThrottlingPreset,
} from "./job-detail.js";
import {
    AppHeader,
    AppShell,
    ErrorBanner,
    Field,
    MetricRow,
    MetricTile,
    NavButton,
    Notice,
    PageIntro,
    Panel,
    StatusPill,
    buttonClass,
    cn,
    eyebrowClass,
    fieldHintClass,
    inputClass,
    pageContainerClass,
    workspaceClass,
} from "./ui.js";

const defaultCategories: Category[] = [
    "performance",
    "accessibility",
    "best-practices",
    "seo",
    "pwa",
];

interface ManualAuditProps {
    apiBase: string;
    onOpenHistory: () => void;
    onExit: () => void;
}

export function ManualAudit({
    apiBase,
    onOpenHistory,
    onExit,
}: ManualAuditProps) {
    const [displayName, setDisplayName] = useState("");
    const [formFactors] = useState<FormFactor[]>(["desktop", "mobile"]);
    const [categories, setCategories] = useState<Category[]>(defaultCategories);
    const [runsPerPage, setRunsPerPage] = useState(1);
    const [throttlingPreset, setThrottlingPreset] =
        useState<ThrottlingPreset>("slow-4g");
    const [customRtt, setCustomRtt] = useState(150);
    const [customThroughput, setCustomThroughput] = useState(1638.4);
    const [customCpu, setCustomCpu] = useState(4);

    const [manualSession, setManualSession] =
        useState<ManualSessionResponse | null>(null);
    const [manualScan, setManualScan] = useState<ManualScanState | null>(null);
    const [manualEvidenceMode, setManualEvidenceMode] =
        useState<ManualEvidenceMode>("none");
    const [manualEvidenceConsent, setManualEvidenceConsent] = useState(false);
    const [manualBusy, setManualBusy] = useState(false);
    const [manualError, setManualError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [compare, setCompare] = useState<ManualCompareInput>({
        enabled: false,
        environments: [
            { name: "", anchorTargetId: "" },
            { name: "", anchorTargetId: "" },
        ],
    });

    const jobRun = useJobRun(apiBase, null, false);

    const compareReady =
        !compare.enabled ||
        (manualScan ? isManualCompareValid(manualScan.tabs, compare) : false);
    const submissionValid =
        isManualSubmissionValid({
            scan: manualScan,
            evidenceMode: manualEvidenceMode,
            evidenceConsent: manualEvidenceConsent,
            formFactors,
            categories,
            runsPerPage,
        }) && compareReady;

    async function submit(event: FormEvent) {
        event.preventDefault();
        if (!submissionValid || submitting || !manualScan) return;
        setSubmitting(true);
        jobRun.setError(null);
        try {
            const payload = buildManualPayload({
                scan: manualScan,
                settings: {
                    displayName,
                    formFactors,
                    categories,
                    runsPerPage,
                    throttlingPreset,
                    custom: {
                        rttMs: customRtt,
                        throughputKbps: customThroughput,
                        cpuSlowdownMultiplier: customCpu,
                    },
                },
                evidenceMode: manualEvidenceMode,
                compare,
            });
            const csrf = await fetch(`${apiBase}/csrf-token`, {
                credentials: "same-origin",
            }).then((response) => response.json());
            const response = await fetch(`${apiBase}/jobs`, {
                method: "POST",
                credentials: "same-origin",
                headers: {
                    "Content-Type": "application/json",
                    "x-csrf-token": csrf.csrfToken,
                },
                body: JSON.stringify(payload),
            });
            if (!response.ok) {
                const body = await response.json().catch(() => ({}));
                throw new Error(body.error ?? `HTTP ${response.status}`);
            }
            const nextJob = (await response.json()) as JobResponse;
            jobRun.startJob(nextJob);
            window.history.pushState(null, "", `/jobs/${nextJob.jobId}`);
        } catch (submitError) {
            jobRun.setError(
                submitError instanceof Error
                    ? submitError.message
                    : String(submitError),
            );
        } finally {
            setSubmitting(false);
        }
    }

    async function openManualSession() {
        setManualBusy(true);
        setManualError(null);
        try {
            const csrf = await fetch(`${apiBase}/csrf-token`, {
                credentials: "same-origin",
            }).then((response) => response.json());
            const response = await fetch(`${apiBase}/manual-chrome/session`, {
                method: "POST",
                credentials: "same-origin",
                headers: { "x-csrf-token": csrf.csrfToken },
            });
            const body = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(body.error ?? `HTTP ${response.status}`);
            }
            setManualSession(body as ManualSessionResponse);
        } catch (sessionError) {
            setManualError(
                sessionError instanceof Error
                    ? sessionError.message
                    : String(sessionError),
            );
        } finally {
            setManualBusy(false);
        }
    }

    async function scanManualTabs() {
        setManualBusy(true);
        setManualError(null);
        try {
            const csrf = await fetch(`${apiBase}/csrf-token`, {
                credentials: "same-origin",
            }).then((response) => response.json());
            const response = await fetch(`${apiBase}/manual-chrome/tabs/scan`, {
                method: "POST",
                credentials: "same-origin",
                headers: { "x-csrf-token": csrf.csrfToken },
            });
            const body = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(body.error ?? `HTTP ${response.status}`);
            }
            setManualScan(deriveScanState(body as ManualScanResponse));
        } catch (scanError) {
            setManualError(
                scanError instanceof Error
                    ? scanError.message
                    : String(scanError),
            );
        } finally {
            setManualBusy(false);
        }
    }

    function toggleManualTab(targetId: string) {
        setManualScan((current) =>
            current ? toggleSelectedTab(current, targetId) : current,
        );
    }

    function selectManualEvidenceMode(mode: ManualEvidenceMode) {
        setManualEvidenceMode(mode);
        if (mode === "none") setManualEvidenceConsent(false);
    }

    const submitError = jobRun.error;
    const selectedCount = manualScan?.selectedIds.length ?? 0;
    const scanExpired = manualScan ? isScanExpired(manualScan) : false;
    const totalRuns = selectedCount * formFactors.length * runsPerPage;

    const sessionStatus: string = manualSession?.running
        ? manualSession.busy
            ? "running"
            : "queued"
        : "idle";
    const sessionStatusLabel = manualSession?.running
        ? manualSession.busy
            ? "Profile busy"
            : "Profile open"
        : "Profile closed";

    return (
        <AppShell>
            <AppHeader
                eyebrow="Manual Chrome session"
                description="Manual Chrome Tabs audit"
                actions={
                    <>
                        <NavButton
                            icon={<HistoryIcon strokeWidth={1.8} />}
                            label="Job history"
                            onClick={onOpenHistory}
                        />
                        <NavButton
                            icon={<ArrowLeft strokeWidth={1.8} />}
                            label="Static LP audit"
                            onClick={onExit}
                        />
                    </>
                }
            />

            <div
                className={cn(
                    pageContainerClass,
                    "pt-8 pb-7 sm:pt-10 lg:pt-12",
                )}
            >
                <PageIntro
                    eyebrow="Manual Chrome tabs"
                    title="Audit authenticated flows from a real session."
                    description="Sign in inside the managed Chrome profile, scan the open tabs, then queue Lighthouse runs against the ones you choose."
                >
                    <MetricRow>
                        <MetricTile
                            label="Profile"
                            value={sessionStatusLabel}
                            description={
                                manualSession?.running
                                    ? "Click scan after authenticating"
                                    : "Open profile to begin"
                            }
                        />
                        <MetricTile
                            label="Open tabs"
                            value={manualScan?.totalOpenTabs ?? 0}
                            description={
                                manualScan
                                    ? `${manualScan.tabs.length} selectable`
                                    : "Awaiting scan"
                            }
                        />
                        <MetricTile
                            label="Selected"
                            value={selectedCount}
                            description="Tabs queued for audit"
                        />
                        <MetricTile
                            accent
                            label="Total runs"
                            value={totalRuns}
                            description={`${formFactors.length} form factors × ${runsPerPage} runs`}
                        />
                    </MetricRow>
                </PageIntro>
            </div>

            <div className={workspaceClass}>
                <form
                    className="space-y-6"
                    onSubmit={submit}
                    aria-label="Manual Chrome Tabs audit"
                >
                    <Panel
                        eyebrow="01 · Chrome session"
                        title="Manual Chrome tabs"
                        description="Lighthouse measures the URL each tab is currently pointing to, so make sure every tab is at the page you want scored."
                        icon={<Chrome />}
                        actions={
                            <StatusPill
                                status={sessionStatus}
                                label={sessionStatusLabel}
                                pulse={manualSession?.busy}
                            />
                        }
                    >
                        <ol className="grid gap-2 sm:grid-cols-3">
                            {[
                                {
                                    title: "Open profile",
                                    body: "Launch the dedicated Chrome window below.",
                                },
                                {
                                    title: "Authenticate",
                                    body: "Sign in, accept OTP, and load each page manually.",
                                },
                                {
                                    title: "Scan tabs",
                                    body: "Capture the URLs Lighthouse should measure.",
                                },
                            ].map((step, index) => (
                                <li
                                    key={step.title}
                                    className="relative rounded-2xl border border-ink-200/70 bg-ink-50/60 p-4"
                                >
                                    <span className="absolute -top-2 left-4 inline-flex h-4 items-center rounded-full bg-ink-950 px-2 font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-white">
                                        {String(index + 1).padStart(2, "0")}
                                    </span>
                                    <p className="text-[13.5px] font-semibold text-ink-950">
                                        {step.title}
                                    </p>
                                    <p className="mt-1 text-[12px] leading-5 text-ink-500">
                                        {step.body}
                                    </p>
                                </li>
                            ))}
                        </ol>

                        <div className="flex flex-wrap items-center gap-2">
                            <button
                                type="button"
                                className={buttonClass("secondary")}
                                disabled={manualBusy || submitting}
                                onClick={() => void openManualSession()}
                            >
                                <Chrome
                                    size={16}
                                    strokeWidth={1.8}
                                    aria-hidden="true"
                                />
                                Open Chrome profile
                            </button>
                            <button
                                type="button"
                                className={buttonClass("secondary")}
                                disabled={manualBusy || submitting}
                                onClick={() => void scanManualTabs()}
                            >
                                <ScanLine
                                    size={16}
                                    strokeWidth={1.8}
                                    aria-hidden="true"
                                    className={cn(
                                        manualBusy && "animate-pulse",
                                    )}
                                />
                                Scan tabs
                            </button>
                        </div>

                        {manualError ? (
                            <ErrorBanner>{manualError}</ErrorBanner>
                        ) : null}

                        {manualScan ? (
                            <div className="space-y-3">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                    <p className="text-[12.5px] tabular text-ink-600">
                                        <span className="font-semibold text-ink-950">
                                            {manualScan.totalOpenTabs}
                                        </span>{" "}
                                        open tab
                                        {manualScan.totalOpenTabs === 1
                                            ? ""
                                            : "s"}{" "}
                                        ·{" "}
                                        <span className="font-semibold text-ink-950">
                                            {manualScan.tabs.length}
                                        </span>{" "}
                                        selectable
                                    </p>
                                    {scanExpired ? (
                                        <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-amber-700">
                                            <RefreshCw
                                                size={11}
                                                strokeWidth={1.8}
                                                aria-hidden
                                            />
                                            Scan expired
                                        </span>
                                    ) : null}
                                </div>

                                <ul className="divide-y divide-ink-200/70 overflow-hidden rounded-2xl border border-ink-200/70 bg-white">
                                    {manualScan.tabs.map((tab) => {
                                        const checked =
                                            manualScan.selectedIds.includes(
                                                tab.id,
                                            );
                                        return (
                                            <li
                                                key={tab.id}
                                                className="hover:bg-ink-50/70"
                                            >
                                                <label
                                                    className={cn(
                                                        "flex cursor-pointer items-start gap-3 px-4 py-3",
                                                        (submitting ||
                                                            scanExpired) &&
                                                            "cursor-not-allowed opacity-60",
                                                    )}
                                                >
                                                    <span className="relative mt-0.5 inline-flex size-4.5 shrink-0 items-center justify-center">
                                                        <input
                                                            type="checkbox"
                                                            checked={checked}
                                                            disabled={
                                                                submitting ||
                                                                scanExpired
                                                            }
                                                            onChange={() =>
                                                                toggleManualTab(
                                                                    tab.id,
                                                                )
                                                            }
                                                            className="peer absolute inset-0 size-full cursor-pointer appearance-none rounded-md border border-ink-300 bg-white outline-none transition duration-150 checked:border-accent-600 checked:bg-accent-600 focus-visible:ring-4 focus-visible:ring-accent-500/25 disabled:cursor-not-allowed"
                                                        />
                                                        <svg
                                                            aria-hidden
                                                            viewBox="0 0 14 14"
                                                            className="pointer-events-none relative size-2.5 scale-0 text-white transition duration-150 peer-checked:scale-100"
                                                            fill="none"
                                                        >
                                                            <path
                                                                d="M3 7.2l2.6 2.6L11 4.3"
                                                                stroke="currentColor"
                                                                strokeWidth={2}
                                                                strokeLinecap="round"
                                                                strokeLinejoin="round"
                                                            />
                                                        </svg>
                                                    </span>
                                                    <div className="min-w-0 flex-1">
                                                        <p className="truncate text-[13.5px] font-medium text-ink-950">
                                                            {tab.title ||
                                                                "Untitled tab"}
                                                        </p>
                                                        <p className="mt-0.5 truncate font-mono text-[11.5px] text-ink-500">
                                                            {tab.displayUrl}
                                                            {tab.hasHiddenUrlParts ? (
                                                                <span className="ml-1 inline-flex items-center gap-1 rounded-full bg-amber-50 px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-amber-700">
                                                                    <Lock
                                                                        size={9}
                                                                        strokeWidth={
                                                                            2
                                                                        }
                                                                        aria-hidden
                                                                    />
                                                                    query/fragment
                                                                    hidden
                                                                </span>
                                                            ) : null}
                                                        </p>
                                                    </div>
                                                </label>
                                            </li>
                                        );
                                    })}
                                </ul>

                                <ManualCompareSection
                                    tabs={manualScan.tabs}
                                    selectedIds={manualScan.selectedIds}
                                    compare={compare}
                                    disabled={submitting || scanExpired}
                                    onChange={setCompare}
                                />

                                {manualScan.skipped.length > 0 ? (
                                    <details className="group rounded-2xl border border-ink-200/70 bg-ink-50/60 px-4 py-3">
                                        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 outline-none focus-visible:rounded focus-visible:ring-4 focus-visible:ring-accent-500/20">
                                            <span className="text-[12.5px] font-medium text-ink-600">
                                                {manualScan.skipped.length}{" "}
                                                skipped tab
                                                {manualScan.skipped.length === 1
                                                    ? ""
                                                    : "s"}
                                            </span>
                                            <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-400 group-open:text-ink-700">
                                                {`Show details`}
                                            </span>
                                        </summary>
                                        <ul className="mt-3 space-y-1.5">
                                            {manualScan.skipped.map((tab) => (
                                                <li
                                                    key={tab.id}
                                                    className="rounded-lg bg-white px-3 py-2 text-[12px] text-ink-600"
                                                >
                                                    <span className="font-mono text-ink-700">
                                                        {tab.displayUrl}
                                                    </span>
                                                    <span className="ml-2 text-ink-400">
                                                        — {tab.reason}
                                                    </span>
                                                </li>
                                            ))}
                                        </ul>
                                    </details>
                                ) : null}
                            </div>
                        ) : null}

                        <Notice tone="warning" icon={<ShieldHint />}>
                            Lighthouse may reload or navigate the selected tab
                            during measurement. Do not audit URLs containing
                            OTPs, password-reset tokens, or one-time session
                            tokens in the query string or fragment.
                        </Notice>

                        <Field
                            label="Display name"
                            hint="Shown in history and report headers."
                        >
                            <input
                                value={displayName}
                                onChange={(event) =>
                                    setDisplayName(event.target.value)
                                }
                                disabled={submitting}
                                placeholder="Manual authenticated flow"
                                className={inputClass}
                            />
                        </Field>
                    </Panel>

                    <LighthouseSettings
                        disabled={submitting}
                        categories={categories}
                        setCategories={setCategories}
                        throttlingPreset={throttlingPreset}
                        setThrottlingPreset={setThrottlingPreset}
                        customRtt={customRtt}
                        setCustomRtt={setCustomRtt}
                        customThroughput={customThroughput}
                        setCustomThroughput={setCustomThroughput}
                        customCpu={customCpu}
                        setCustomCpu={setCustomCpu}
                    />

                    <Panel
                        eyebrow="03 · Optional"
                        title="Evidence"
                        description="Basic Auth and form login are disabled in Manual mode because authentication already happens inside Chrome."
                        icon={<FileText />}
                    >
                        <div>
                            <p className={cn(eyebrowClass, "mb-3")}>
                                HTML evidence
                            </p>
                            <div className="grid gap-2 sm:grid-cols-2">
                                <RadioRow
                                    name="manual-evidence-mode"
                                    label="No HTML evidence"
                                    description="Recommended. Only Excel report is generated."
                                    checked={manualEvidenceMode === "none"}
                                    disabled={submitting}
                                    onChange={() =>
                                        selectManualEvidenceMode("none")
                                    }
                                />
                                <RadioRow
                                    name="manual-evidence-mode"
                                    label="Generate HTML evidence"
                                    description="Saves DOM, screenshots, and request log for each run."
                                    checked={manualEvidenceMode === "html"}
                                    disabled={submitting}
                                    onChange={() =>
                                        selectManualEvidenceMode("html")
                                    }
                                />
                            </div>
                            {manualEvidenceMode === "html" ? (
                                <div className="mt-3">
                                    <PlainCheckbox
                                        label="I understand authenticated page content will be written to disk"
                                        description="Screenshots, DOM snapshots, and network URLs are served through tokenized evidence links."
                                        checked={manualEvidenceConsent}
                                        disabled={submitting}
                                        onChange={() =>
                                            setManualEvidenceConsent(
                                                (value) => !value,
                                            )
                                        }
                                    />
                                </div>
                            ) : null}
                        </div>
                    </Panel>

                    <Notice tone="info" icon={<Layers strokeWidth={1.8} />}>
                        Only audit sites you trust. Authentication happens in
                        your Chrome profile and is never written into the
                        report.
                    </Notice>

                    {submitError ? (
                        <ErrorBanner>{submitError}</ErrorBanner>
                    ) : null}

                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <p className={fieldHintClass}>
                            {submissionValid ? (
                                <span className="inline-flex items-center gap-1.5 text-emerald-700">
                                    <span className="size-1.5 rounded-full bg-emerald-600" />
                                    Ready to queue {totalRuns} measurement
                                    {totalRuns === 1 ? "" : "s"}.
                                </span>
                            ) : (
                                <span className="inline-flex items-center gap-1.5 text-ink-500">
                                    <span className="size-1.5 rounded-full bg-ink-300" />
                                    Scan tabs and pick at least one to enable
                                    submission.
                                </span>
                            )}
                        </p>
                        <button
                            className={cn(
                                buttonClass("primary"),
                                "w-full sm:w-auto",
                            )}
                            type="submit"
                            disabled={
                                !submissionValid || submitting || jobRun.running
                            }
                        >
                            <Play
                                size={16}
                                strokeWidth={1.8}
                                aria-hidden="true"
                            />
                            {submitting ? "Submitting…" : "Start audit"}
                        </button>
                    </div>
                </form>

                <JobProgressPanel
                    apiBase={apiBase}
                    progress={jobRun.progress}
                    job={jobRun.job}
                    downloadToken={jobRun.downloadToken}
                    htmlReports={jobRun.htmlReports}
                    evidenceIndex={jobRun.evidenceIndex}
                    logs={jobRun.logs}
                />
            </div>
        </AppShell>
    );
}

function ShieldHint() {
    return (
        <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
        >
            <path d="M8 14c3.5-1.5 5-4 5-7V3.5L8 2 3 3.5V7c0 3 1.5 5.5 5 7z" />
            <path d="M8 6v3" />
            <path d="M8 11h.01" />
        </svg>
    );
}
