import {
    Activity,
    ArrowLeft,
    ChevronDown,
    History as HistoryIcon,
    Layers,
    MonitorSmartphone,
    Play,
    ShieldAlert,
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { JobHistory } from "./JobHistory.js";
import { JobProgressPanel } from "./JobProgressPanel.js";
import { LighthouseSettings } from "./LighthouseSettings.js";
import { ManualAudit } from "./ManualAudit.js";
import { Toggle, toggle } from "./form-controls.js";
import { readAppRoute, type AppRoute } from "./app-route.js";
import { useJobRun } from "./useJobRun.js";
import {
    deriveJobDetailState,
    type AuditFormState,
    type Category,
    type FormFactor,
    type JobDetailResponse,
    type JobResponse,
    type ThrottlingPreset,
} from "./job-detail.js";
import {
    AppHeader,
    AppShell,
    Chip,
    ErrorBanner,
    Field,
    MetricRow,
    MetricTile,
    NavButton,
    Notice,
    PageIntro,
    Panel,
    buttonClass,
    cn,
    eyebrowClass,
    fieldHintClass,
    fieldLabelClass,
    inputClass,
    pageContainerClass,
    selectClass,
    textareaClass,
    workspaceClass,
} from "./ui.js";

const apiBase = import.meta.env.DEV ? "/api" : "";
const defaultCategories: Category[] = [
    "performance",
    "accessibility",
    "best-practices",
    "seo",
    "pwa",
];

type AppView = "audit" | "manual" | "history";

function initialView(): AppView {
    const route = readAppRoute(window.location.pathname);
    if (route.view === "history") return "history";
    if (route.view === "manual") return "manual";
    return "audit";
}

export function App() {
    const [view, setView] = useState<AppView>(initialView);
    const [baseUrl, setBaseUrl] = useState("");
    const [displayName, setDisplayName] = useState("");
    const [compareEnabled, setCompareEnabled] = useState(false);
    const [environmentsText, setEnvironmentsText] = useState(
        "Dev 1=https://dev1.example.com\nDev 3=https://dev3.example.com",
    );
    const [pathsText, setPathsText] = useState("/\n/products\n/cart");
    const [formFactors, setFormFactors] = useState<FormFactor[]>([
        "desktop",
        "mobile",
    ]);
    const [categories, setCategories] = useState<Category[]>(defaultCategories);
    const [runsPerPage, setRunsPerPage] = useState(1);
    const [throttlingPreset, setThrottlingPreset] =
        useState<ThrottlingPreset>("slow-4g");
    const [customRtt, setCustomRtt] = useState(150);
    const [customThroughput, setCustomThroughput] = useState(1638.4);
    const [customCpu, setCustomCpu] = useState(4);
    const [basicEnabled, setBasicEnabled] = useState(false);
    const [basicUsername, setBasicUsername] = useState("");
    const [basicPassword, setBasicPassword] = useState("");
    const [formLoginEnabled, setFormLoginEnabled] = useState(false);
    const [loginUrl, setLoginUrl] = useState("");
    const [usernameSelector, setUsernameSelector] = useState(
        'input[name="email"]',
    );
    const [username, setUsername] = useState("");
    const [passwordSelector, setPasswordSelector] = useState(
        'input[name="password"]',
    );
    const [password, setPassword] = useState("");
    const [submitSelector, setSubmitSelector] = useState(
        'button[type="submit"]',
    );
    const [postLoginMode, setPostLoginMode] = useState<
        "navigation" | "selector" | "delay"
    >("navigation");
    const [postLoginSelector, setPostLoginSelector] = useState("");
    const [postLoginDelay, setPostLoginDelay] = useState(2000);
    const [postLoginTimeout, setPostLoginTimeout] = useState(30000);
    const [manualCapable, setManualCapable] = useState(false);
    const [submitting, setSubmitting] = useState(false);

    const initialRoute = useMemo(
        () => readAppRoute(window.location.pathname),
        [],
    );
    const jobRun = useJobRun(
        apiBase,
        initialRoute.view === "detail"
            ? {
                  jobId: initialRoute.jobId,
                  eventsUrl: `/jobs/${initialRoute.jobId}/events`,
                  downloadUrl: `/jobs/${initialRoute.jobId}/download`,
                  queuePosition: 0,
              }
            : null,
        initialRoute.view === "detail",
        { onDetailLoaded: hydrateFormFromDetail },
    );

    const paths = useMemo(() => parsePathText(pathsText), [pathsText]);
    const environments = useMemo(
        () => parseEnvironmentText(environmentsText),
        [environmentsText],
    );
    const formValid = useMemo(() => {
        if (compareEnabled) {
            if (environments.length < 2) return false;
            if (
                environments.some(
                    (environment) => !isValidUrl(environment.baseUrl),
                )
            )
                return false;
            const names = new Set(
                environments.map((environment) =>
                    environment.name.trim().toLowerCase(),
                ),
            );
            if (names.size !== environments.length) return false;
        } else if (!isValidUrl(baseUrl)) return false;
        if (
            paths.length === 0 ||
            formFactors.length === 0 ||
            categories.length === 0
        )
            return false;
        if (runsPerPage < 1 || runsPerPage > 11) return false;
        if (
            throttlingPreset === "custom" &&
            (customRtt < 0 ||
                customThroughput <= 0 ||
                customCpu < 1 ||
                customCpu > 20)
        )
            return false;
        if (basicEnabled && (!basicUsername || !basicPassword)) return false;
        if (
            formLoginEnabled &&
            (!isValidUrl(loginUrl) ||
                !username ||
                !password ||
                !usernameSelector ||
                !passwordSelector ||
                !submitSelector)
        )
            return false;
        if (
            formLoginEnabled &&
            postLoginMode === "selector" &&
            !postLoginSelector
        )
            return false;
        if (formLoginEnabled && postLoginMode === "delay" && postLoginDelay < 1)
            return false;
        return true;
    }, [
        baseUrl,
        compareEnabled,
        environments,
        paths,
        formFactors,
        categories,
        runsPerPage,
        throttlingPreset,
        customRtt,
        customThroughput,
        customCpu,
        basicEnabled,
        basicUsername,
        basicPassword,
        formLoginEnabled,
        loginUrl,
        username,
        password,
        usernameSelector,
        passwordSelector,
        submitSelector,
        postLoginMode,
        postLoginSelector,
        postLoginDelay,
    ]);

    useEffect(() => {
        let cancelled = false;
        async function loadCapability() {
            try {
                const response = await fetch(`${apiBase}/healthz`, {
                    credentials: "same-origin",
                });
                if (!response.ok) return;
                const body = await response.json().catch(() => ({}));
                if (!cancelled) setManualCapable(Boolean(body.manualChrome));
            } catch {
                if (!cancelled) setManualCapable(false);
            }
        }
        void loadCapability();
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        const handlePopState = () => syncViewWithPath();
        window.addEventListener("popstate", handlePopState);
        return () => window.removeEventListener("popstate", handlePopState);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const running = jobRun.running;

    async function submit(event: FormEvent) {
        event.preventDefault();
        if (!formValid || submitting) return;
        setSubmitting(true);
        jobRun.setError(null);
        try {
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
                body: JSON.stringify(buildPayload()),
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

    function buildPayload() {
        const normalizedEnvironments = compareEnabled
            ? environments.map((environment) => ({
                  name: environment.name,
                  baseUrl: normalizeUrlInput(environment.baseUrl),
              }))
            : undefined;
        const payloadBaseUrl =
            normalizedEnvironments?.[0]?.baseUrl ?? normalizeUrlInput(baseUrl);

        return {
            baseUrl: payloadBaseUrl,
            displayName: displayName || undefined,
            environments: normalizedEnvironments,
            paths,
            formFactors,
            categories,
            runsPerPage,
            throttling: {
                preset: throttlingPreset,
                custom:
                    throttlingPreset === "custom"
                        ? {
                              rttMs: customRtt,
                              throughputKbps: customThroughput,
                              cpuSlowdownMultiplier: customCpu,
                          }
                        : undefined,
            },
            basicAuth: {
                enabled: basicEnabled,
                username: basicEnabled ? basicUsername : undefined,
                password: basicEnabled ? basicPassword : undefined,
            },
            formLogin: {
                enabled: formLoginEnabled,
                loginUrl: formLoginEnabled
                    ? normalizeUrlInput(loginUrl)
                    : undefined,
                usernameSelector,
                username: formLoginEnabled ? username : undefined,
                passwordSelector,
                password: formLoginEnabled ? password : undefined,
                submitSelector,
                postLogin: {
                    mode: postLoginMode,
                    selector:
                        postLoginMode === "selector"
                            ? postLoginSelector
                            : undefined,
                    delayMs:
                        postLoginMode === "delay" ? postLoginDelay : undefined,
                    timeoutMs: postLoginTimeout,
                },
            },
        };
    }

    function hydrateFormFromDetail(detail: JobDetailResponse) {
        const form = deriveJobDetailState(detail).form;
        if (form) applyFormState(form);
    }

    function applyFormState(form: AuditFormState) {
        setBaseUrl(form.baseUrl);
        setDisplayName(form.displayName);
        setCompareEnabled(form.compareEnabled);
        setEnvironmentsText(form.environmentsText || environmentsText);
        setPathsText(form.pathsText);
        setFormFactors(form.formFactors);
        setCategories(form.categories);
        setRunsPerPage(form.runsPerPage);
        setThrottlingPreset(form.throttlingPreset);
        setCustomRtt(form.customRtt);
        setCustomThroughput(form.customThroughput);
        setCustomCpu(form.customCpu);
        setBasicEnabled(form.basicEnabled);
        setBasicUsername(form.basicUsername);
        setBasicPassword(form.basicPassword);
        setFormLoginEnabled(form.formLoginEnabled);
        setLoginUrl(form.loginUrl);
        setUsernameSelector(form.usernameSelector);
        setUsername(form.username);
        setPasswordSelector(form.passwordSelector);
        setPassword(form.password);
        setSubmitSelector(form.submitSelector);
        setPostLoginMode(form.postLoginMode);
        setPostLoginSelector(form.postLoginSelector);
        setPostLoginDelay(form.postLoginDelay);
        setPostLoginTimeout(form.postLoginTimeout);
    }

    function openHistory() {
        setView("history");
        jobRun.clearJobResult();
        window.history.pushState(null, "", "/jobs");
    }

    function openManual() {
        setView("manual");
        jobRun.clearJobResult();
        window.history.pushState(null, "", "/manual");
    }

    function openJobFromHistory(jobId: string, detailUrl: string) {
        setView("audit");
        jobRun.prepareJobDetail(jobId);
        window.history.pushState(null, "", detailUrl);
    }

    function resetJob() {
        setView("audit");
        jobRun.clearJobResult();
        window.history.pushState(null, "", "/");
    }

    function exitManual() {
        setView("audit");
        jobRun.clearJobResult();
        window.history.pushState(null, "", "/");
    }

    function syncViewWithPath() {
        const route: AppRoute = readAppRoute(window.location.pathname);
        if (route.view === "history") {
            setView("history");
            jobRun.clearJobResult();
            return;
        }
        if (route.view === "manual") {
            setView("manual");
            jobRun.clearJobResult();
            return;
        }
        if (route.view === "detail") {
            setView("audit");
            jobRun.prepareJobDetail(route.jobId);
            return;
        }
        setView("audit");
        jobRun.clearJobResult();
    }

    if (view === "manual") {
        return (
            <ManualAudit
                apiBase={apiBase}
                onOpenHistory={openHistory}
                onExit={exitManual}
            />
        );
    }

    const totalRoutes = paths.length;
    const totalEnvs = compareEnabled ? environments.length : 1;
    const totalRuns =
        totalRoutes * formFactors.length * runsPerPage * Math.max(1, totalEnvs);

    const headerActions = (
        <>
            {manualCapable && view !== "history" ? (
                <NavButton
                    icon={<MonitorSmartphone strokeWidth={1.8} />}
                    label="Manual Chrome tabs"
                    onClick={openManual}
                />
            ) : null}
            {view !== "history" ? (
                <NavButton
                    icon={<HistoryIcon strokeWidth={1.8} />}
                    label="Job history"
                    onClick={openHistory}
                />
            ) : null}
            {jobRun.job || view === "history" ? (
                <NavButton
                    icon={<ArrowLeft strokeWidth={1.8} />}
                    label="New audit"
                    onClick={resetJob}
                />
            ) : null}
        </>
    );

    return (
        <AppShell>
            <AppHeader
                description="Internal performance audit runner"
                actions={headerActions}
            />

            {view === "history" ? (
                <JobHistory apiBase={apiBase} onOpenJob={openJobFromHistory} />
            ) : (
                <>
                    <div
                        className={cn(
                            pageContainerClass,
                            "pt-8 pb-7 sm:pt-10 lg:pt-12",
                        )}
                    >
                        <PageIntro
                            eyebrow="Audit setup"
                            title="Measure performance with intent."
                            description="Configure routes, environments, and Lighthouse instruments. Reports stream back as soon as the worker finishes each combination."
                        >
                            <MetricRow>
                                <MetricTile
                                    label="Routes"
                                    value={totalRoutes}
                                    description="Distinct URLs scheduled"
                                />
                                <MetricTile
                                    label="Form factors"
                                    value={formFactors.length}
                                    description={
                                        formFactors.length === 0
                                            ? "Pick at least one"
                                            : formFactors.join(" · ")
                                    }
                                />
                                <MetricTile
                                    label="Categories"
                                    value={categories.length}
                                    description="Lighthouse scoring tracks"
                                />
                                <MetricTile
                                    accent
                                    label="Total runs"
                                    value={totalRuns}
                                    description={`${runsPerPage} per page × ${totalEnvs} env`}
                                />
                            </MetricRow>
                        </PageIntro>
                    </div>

                    <div className={workspaceClass}>
                        <form
                            className="space-y-6"
                            onSubmit={submit}
                            aria-label="Audit configuration"
                        >
                            <Panel
                                eyebrow="01 · Targets"
                                title="Audit input"
                                description="Pick a base URL or compare two environments, then list the paths to score."
                                icon={<Activity />}
                            >
                                <div className="grid gap-4 sm:grid-cols-2">
                                    <Field
                                        label="Base URL"
                                        hint="The origin Lighthouse will measure when compare mode is off."
                                    >
                                        <input
                                            value={baseUrl}
                                            onChange={(event) =>
                                                setBaseUrl(event.target.value)
                                            }
                                            disabled={running || submitting}
                                            placeholder="https://staging.example.com"
                                            className={inputClass}
                                        />
                                    </Field>
                                    <Field
                                        label="Display name"
                                        hint="Shown in history and report headers."
                                    >
                                        <input
                                            value={displayName}
                                            onChange={(event) =>
                                                setDisplayName(
                                                    event.target.value,
                                                )
                                            }
                                            disabled={running || submitting}
                                            placeholder="Staging audit · Q2"
                                            className={inputClass}
                                        />
                                    </Field>
                                </div>

                                <div className="rounded-2xl border border-ink-200/70 bg-ink-50/60 p-4 sm:p-5">
                                    <Toggle
                                        label="Compare multiple environments"
                                        description="Run the same paths against several origins sequentially."
                                        checked={compareEnabled}
                                        disabled={running || submitting}
                                        onChange={() =>
                                            setCompareEnabled(
                                                (value) => !value,
                                            )
                                        }
                                    />
                                    {compareEnabled ? (
                                        <Field
                                            label="Environments"
                                            hint="One per line: name=https://url. Runs sequentially in the order listed."
                                        >
                                            <textarea
                                                value={environmentsText}
                                                onChange={(event) =>
                                                    setEnvironmentsText(
                                                        event.target.value,
                                                    )
                                                }
                                                disabled={running || submitting}
                                                rows={4}
                                                placeholder={
                                                    "Dev 1=https://dev1.example.com\nDev 3=https://dev3.example.com"
                                                }
                                                className={textareaClass}
                                            />
                                        </Field>
                                    ) : null}
                                </div>

                                <Field
                                    label="Pathnames"
                                    hint="One path per line. Each path is paired with every selected form factor."
                                >
                                    <textarea
                                        value={pathsText}
                                        onChange={(event) =>
                                            setPathsText(event.target.value)
                                        }
                                        disabled={running || submitting}
                                        rows={5}
                                        className={textareaClass}
                                    />
                                </Field>

                                <div className="grid gap-4 sm:grid-cols-[1fr_220px]">
                                    <div>
                                        <p
                                            className={cn(
                                                eyebrowClass,
                                                "mb-3",
                                            )}
                                        >
                                            Form factor
                                        </p>
                                        <div className="flex flex-wrap gap-1.5">
                                            <Chip
                                                active={formFactors.includes(
                                                    "desktop",
                                                )}
                                                disabled={running || submitting}
                                                onClick={() =>
                                                    toggle(
                                                        "desktop",
                                                        formFactors,
                                                        setFormFactors,
                                                    )
                                                }
                                            >
                                                Desktop
                                            </Chip>
                                            <Chip
                                                active={formFactors.includes(
                                                    "mobile",
                                                )}
                                                disabled={running || submitting}
                                                onClick={() =>
                                                    toggle(
                                                        "mobile",
                                                        formFactors,
                                                        setFormFactors,
                                                    )
                                                }
                                            >
                                                Mobile
                                            </Chip>
                                        </div>
                                    </div>

                                    <Field label="Runs per page" hint="1 to 11">
                                        <input
                                            type="number"
                                            min={1}
                                            max={11}
                                            value={runsPerPage}
                                            disabled={running || submitting}
                                            onChange={(event) =>
                                                setRunsPerPage(
                                                    Number(event.target.value),
                                                )
                                            }
                                            className={cn(
                                                inputClass,
                                                "font-mono tabular",
                                            )}
                                        />
                                    </Field>
                                </div>
                            </Panel>

                            <LighthouseSettings
                                disabled={running || submitting}
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

                            <details className="group rounded-3xl border border-ink-200/70 bg-white p-6 shadow-[0_1px_0_rgba(15,23,42,0.04),0_18px_42px_-30px_rgba(15,23,42,0.28)] sm:p-7">
                                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 outline-none focus-visible:rounded-2xl focus-visible:ring-4 focus-visible:ring-accent-500/20">
                                    <div className="flex items-start gap-3">
                                        <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-ink-950 text-white">
                                            <ShieldAlert
                                                size={18}
                                                strokeWidth={1.8}
                                                aria-hidden="true"
                                            />
                                        </div>
                                        <div>
                                            <p
                                                className={cn(
                                                    eyebrowClass,
                                                    "mb-1",
                                                )}
                                            >
                                                03 · Optional
                                            </p>
                                            <h2 className="text-[17px] font-semibold tracking-tight text-ink-950">
                                                Authentication
                                            </h2>
                                            <p className="mt-1 max-w-2xl text-[13.5px] leading-6 text-ink-500">
                                                Configure HTTP Basic or scripted
                                                form login so authenticated
                                                pages can be measured.
                                            </p>
                                        </div>
                                    </div>
                                    <ChevronDown
                                        size={18}
                                        strokeWidth={1.8}
                                        aria-hidden="true"
                                        className="shrink-0 text-ink-400 transition duration-200 group-open:rotate-180 group-open:text-ink-700"
                                    />
                                </summary>

                                <div className="mt-6 space-y-5">
                                    <fieldset className="space-y-4 rounded-2xl border border-ink-200/70 bg-ink-50/60 p-5">
                                        <legend className="px-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-600">
                                            HTTP Basic Auth
                                        </legend>
                                        <Toggle
                                            label="Enable Basic Auth"
                                            checked={basicEnabled}
                                            disabled={running || submitting}
                                            onChange={() =>
                                                setBasicEnabled(
                                                    (value) => !value,
                                                )
                                            }
                                        />
                                        {basicEnabled ? (
                                            <div className="grid gap-4 sm:grid-cols-2">
                                                <Field label="Username">
                                                    <input
                                                        type="text"
                                                        value={basicUsername}
                                                        disabled={
                                                            running ||
                                                            submitting
                                                        }
                                                        onChange={(event) =>
                                                            setBasicUsername(
                                                                event.target
                                                                    .value,
                                                            )
                                                        }
                                                        className={inputClass}
                                                    />
                                                </Field>
                                                <Field label="Password">
                                                    <input
                                                        type="password"
                                                        value={basicPassword}
                                                        disabled={
                                                            running ||
                                                            submitting
                                                        }
                                                        onChange={(event) =>
                                                            setBasicPassword(
                                                                event.target
                                                                    .value,
                                                            )
                                                        }
                                                        className={inputClass}
                                                    />
                                                </Field>
                                            </div>
                                        ) : null}
                                    </fieldset>

                                    <fieldset className="space-y-4 rounded-2xl border border-ink-200/70 bg-ink-50/60 p-5">
                                        <legend className="px-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-600">
                                            Form login
                                        </legend>
                                        <Toggle
                                            label="Enable form login"
                                            checked={formLoginEnabled}
                                            disabled={running || submitting}
                                            onChange={() =>
                                                setFormLoginEnabled(
                                                    (value) => !value,
                                                )
                                            }
                                        />
                                        {formLoginEnabled ? (
                                            <div className="space-y-4">
                                                <Field label="Login URL">
                                                    <input
                                                        value={loginUrl}
                                                        disabled={
                                                            running ||
                                                            submitting
                                                        }
                                                        onChange={(event) =>
                                                            setLoginUrl(
                                                                event.target
                                                                    .value,
                                                            )
                                                        }
                                                        placeholder="https://staging.example.com/login"
                                                        className={inputClass}
                                                    />
                                                </Field>
                                                <div className="grid gap-4 sm:grid-cols-2">
                                                    <Field label="Username selector">
                                                        <input
                                                            value={
                                                                usernameSelector
                                                            }
                                                            disabled={
                                                                running ||
                                                                submitting
                                                            }
                                                            onChange={(event) =>
                                                                setUsernameSelector(
                                                                    event.target
                                                                        .value,
                                                                )
                                                            }
                                                            className={cn(
                                                                inputClass,
                                                                "font-mono text-[13px]",
                                                            )}
                                                        />
                                                    </Field>
                                                    <Field label="Username value">
                                                        <input
                                                            value={username}
                                                            disabled={
                                                                running ||
                                                                submitting
                                                            }
                                                            onChange={(event) =>
                                                                setUsername(
                                                                    event.target
                                                                        .value,
                                                                )
                                                            }
                                                            className={
                                                                inputClass
                                                            }
                                                        />
                                                    </Field>
                                                    <Field label="Password selector">
                                                        <input
                                                            value={
                                                                passwordSelector
                                                            }
                                                            disabled={
                                                                running ||
                                                                submitting
                                                            }
                                                            onChange={(event) =>
                                                                setPasswordSelector(
                                                                    event.target
                                                                        .value,
                                                                )
                                                            }
                                                            className={cn(
                                                                inputClass,
                                                                "font-mono text-[13px]",
                                                            )}
                                                        />
                                                    </Field>
                                                    <Field label="Password value">
                                                        <input
                                                            type="password"
                                                            value={password}
                                                            disabled={
                                                                running ||
                                                                submitting
                                                            }
                                                            onChange={(event) =>
                                                                setPassword(
                                                                    event.target
                                                                        .value,
                                                                )
                                                            }
                                                            className={
                                                                inputClass
                                                            }
                                                        />
                                                    </Field>
                                                </div>
                                                <div className="grid gap-4 sm:grid-cols-2">
                                                    <Field label="Submit selector">
                                                        <input
                                                            value={
                                                                submitSelector
                                                            }
                                                            disabled={
                                                                running ||
                                                                submitting
                                                            }
                                                            onChange={(event) =>
                                                                setSubmitSelector(
                                                                    event.target
                                                                        .value,
                                                                )
                                                            }
                                                            className={cn(
                                                                inputClass,
                                                                "font-mono text-[13px]",
                                                            )}
                                                        />
                                                    </Field>
                                                    <Field label="Post-login wait">
                                                        <select
                                                            value={
                                                                postLoginMode
                                                            }
                                                            disabled={
                                                                running ||
                                                                submitting
                                                            }
                                                            onChange={(event) =>
                                                                setPostLoginMode(
                                                                    event.target
                                                                        .value as
                                                                        | "navigation"
                                                                        | "selector"
                                                                        | "delay",
                                                                )
                                                            }
                                                            className={
                                                                selectClass
                                                            }
                                                        >
                                                            <option value="navigation">
                                                                Navigation
                                                            </option>
                                                            <option value="selector">
                                                                Selector
                                                            </option>
                                                            <option value="delay">
                                                                Delay
                                                            </option>
                                                        </select>
                                                    </Field>
                                                </div>
                                                {postLoginMode ===
                                                "selector" ? (
                                                    <Field label="Wait selector">
                                                        <input
                                                            value={
                                                                postLoginSelector
                                                            }
                                                            disabled={
                                                                running ||
                                                                submitting
                                                            }
                                                            onChange={(event) =>
                                                                setPostLoginSelector(
                                                                    event.target
                                                                        .value,
                                                                )
                                                            }
                                                            className={cn(
                                                                inputClass,
                                                                "font-mono text-[13px]",
                                                            )}
                                                        />
                                                    </Field>
                                                ) : null}
                                                {postLoginMode === "delay" ? (
                                                    <Field label="Delay (ms)">
                                                        <input
                                                            type="number"
                                                            min={1}
                                                            value={
                                                                postLoginDelay
                                                            }
                                                            disabled={
                                                                running ||
                                                                submitting
                                                            }
                                                            onChange={(event) =>
                                                                setPostLoginDelay(
                                                                    Number(
                                                                        event
                                                                            .target
                                                                            .value,
                                                                    ),
                                                                )
                                                            }
                                                            className={cn(
                                                                inputClass,
                                                                "font-mono tabular",
                                                            )}
                                                        />
                                                    </Field>
                                                ) : null}
                                                <Field label="Timeout (ms)">
                                                    <input
                                                        type="number"
                                                        min={1000}
                                                        value={postLoginTimeout}
                                                        disabled={
                                                            running ||
                                                            submitting
                                                        }
                                                        onChange={(event) =>
                                                            setPostLoginTimeout(
                                                                Number(
                                                                    event.target
                                                                        .value,
                                                                ),
                                                            )
                                                        }
                                                        className={cn(
                                                            inputClass,
                                                            "font-mono tabular",
                                                        )}
                                                    />
                                                </Field>
                                            </div>
                                        ) : null}
                                    </fieldset>
                                </div>
                            </details>

                            <Notice
                                tone="info"
                                icon={<Layers strokeWidth={1.8} />}
                            >
                                Only audit sites you trust. Credentials are
                                encrypted for queued jobs and are never written
                                into the report.
                            </Notice>

                            {jobRun.error ? (
                                <ErrorBanner>{jobRun.error}</ErrorBanner>
                            ) : null}

                            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                <p className={fieldHintClass}>
                                    {formValid ? (
                                        <span className="inline-flex items-center gap-1.5 text-emerald-700">
                                            <span className="size-1.5 rounded-full bg-emerald-600" />
                                            Ready to queue {totalRuns}{" "}
                                            measurement
                                            {totalRuns === 1 ? "" : "s"}.
                                        </span>
                                    ) : (
                                        <span className="inline-flex items-center gap-1.5 text-ink-500">
                                            <span className="size-1.5 rounded-full bg-ink-300" />
                                            Fill the required fields to enable
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
                                        !formValid || submitting || running
                                    }
                                >
                                    <Play
                                        size={16}
                                        strokeWidth={1.8}
                                        aria-hidden="true"
                                    />
                                    {submitting
                                        ? "Submitting…"
                                        : "Start audit"}
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
                </>
            )}
        </AppShell>
    );
}

function parsePathText(text: string): string[] {
    const unique = new Set<string>();
    text.split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
        const [withoutHash] = withSlash.split("#");
        const [withoutQuery] = (withoutHash ?? "/").split("?");
        unique.add(withoutQuery || "/");
    });
    return Array.from(unique);
}

function parseEnvironmentText(text: string) {
    return text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            const separatorIndex = line.indexOf("=");
            if (separatorIndex < 1) {
                return { name: "", baseUrl: line };
            }
            return {
                name: line.slice(0, separatorIndex).trim(),
                baseUrl: line.slice(separatorIndex + 1).trim(),
            };
        })
        .filter((environment) => environment.name && environment.baseUrl);
}

function isValidUrl(value: string) {
    try {
        const url = new URL(normalizeUrlInput(value));
        return url.protocol === "http:" || url.protocol === "https:";
    } catch {
        return false;
    }
}

function normalizeUrlInput(value: string) {
    const trimmed = value.trim();
    if (!trimmed) return trimmed;
    if (trimmed.startsWith("//")) return `https:${trimmed}`;
    if (/^https?:\/\//i.test(trimmed)) return trimmed;

    const lower = trimmed.toLowerCase();
    const protocol =
        lower.startsWith("localhost") ||
        lower.startsWith("127.") ||
        lower.startsWith("[::1]") ||
        lower.startsWith("::1")
            ? "http"
            : "https";

    return `${protocol}://${trimmed}`;
}
