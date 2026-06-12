export type FormFactor = "mobile" | "desktop";
export type Category =
    | "performance"
    | "accessibility"
    | "best-practices"
    | "seo"
    | "pwa";
export type ThrottlingPreset = "slow-4g" | "fast-3g" | "slow-3g" | "custom";
export type PostLoginMode = "navigation" | "selector" | "delay";

export interface JobResponse {
    jobId: string;
    eventsUrl: string;
    downloadUrl: string;
    queuePosition: number;
}

export interface ProgressState {
    percent: number;
    message: string;
    etaSeconds?: number;
    status: "idle" | "queued" | "running" | "done" | "failed";
}

export interface HtmlReportLink {
    environment?: AuditEnvironment;
    route: string;
    formFactor: FormFactor;
    runIndex: number;
    fileName: string;
    downloadUrl: string;
}

export interface EvidenceIndexLink {
    fileName: string;
    downloadUrl: string;
}

export interface AuditEnvironment {
    name: string;
    baseUrl: string;
}

export interface SafeAuditConfig {
    baseUrl: string;
    displayName: string;
    environments?: AuditEnvironment[];
    paths: string[];
    formFactors: FormFactor[];
    categories: Category[];
    runsPerPage: number;
    throttling: {
        preset: ThrottlingPreset;
        custom?: {
            rttMs: number;
            throughputKbps: number;
            cpuSlowdownMultiplier: number;
        };
    };
    basicAuth: {
        enabled: boolean;
        username?: string;
    };
    formLogin: {
        enabled: boolean;
        loginUrl?: string;
        usernameSelector: string;
        username?: string;
        passwordSelector: string;
        submitSelector: string;
        postLogin: {
            mode: PostLoginMode;
            selector?: string;
            delayMs?: number;
            timeoutMs: number;
        };
    };
}

export interface JobDetailResponse extends JobResponse {
    status?: string;
    createdAt?: string;
    startedAt?: string;
    finishedAt?: string;
    summary?: {
        status?: string;
        totalRuns?: number;
        successfulRuns?: number;
    };
    config?: SafeAuditConfig;
    downloadToken?: string;
    htmlReports?: HtmlReportLink[];
    evidenceIndex?: EvidenceIndexLink;
}

export interface AuditFormState {
    baseUrl: string;
    displayName: string;
    compareEnabled: boolean;
    environmentsText: string;
    pathsText: string;
    formFactors: FormFactor[];
    categories: Category[];
    runsPerPage: number;
    throttlingPreset: ThrottlingPreset;
    customRtt: number;
    customThroughput: number;
    customCpu: number;
    basicEnabled: boolean;
    basicUsername: string;
    basicPassword: string;
    formLoginEnabled: boolean;
    loginUrl: string;
    usernameSelector: string;
    username: string;
    passwordSelector: string;
    password: string;
    submitSelector: string;
    postLoginMode: PostLoginMode;
    postLoginSelector: string;
    postLoginDelay: number;
    postLoginTimeout: number;
}

export interface DerivedJobDetailState {
    job: JobResponse;
    progress: ProgressState;
    form: AuditFormState | null;
    downloadToken: string | null;
    htmlReports: HtmlReportLink[];
    evidenceIndex: EvidenceIndexLink | null;
}

export interface SubmittedJobState {
    job: JobResponse;
    progress: ProgressState;
}

export function deriveJobDetailState(detail: JobDetailResponse): DerivedJobDetailState {
    return {
        job: {
            jobId: detail.jobId,
            eventsUrl: detail.eventsUrl,
            downloadUrl: detail.downloadUrl,
            queuePosition: detail.queuePosition ?? 0,
        },
        progress: deriveProgress(detail),
        form: detail.config ? deriveFormState(detail.config) : null,
        downloadToken: detail.downloadToken ?? null,
        htmlReports: Array.isArray(detail.htmlReports) ? [...detail.htmlReports] : [],
        evidenceIndex: detail.evidenceIndex ?? null,
    };
}

export function deriveSubmittedJobState(job: JobResponse): SubmittedJobState {
    return {
        job,
        progress: {
            percent: 0,
            message: `Queued (position ${job.queuePosition ?? 0})`,
            status: "queued",
        },
    };
}

function deriveProgress(detail: JobDetailResponse): ProgressState {
    const status = detail.summary?.status ?? detail.status;
    if (status === "completed" || status === "partial") {
        return {
            percent: 100,
            message: "Report ready",
            status: "done",
        };
    }
    if (status === "failed") {
        return {
            percent: 100,
            message: "Job failed",
            status: "failed",
        };
    }
    if (status === "running" || status === "active") {
        return {
            percent: 0,
            message: "Reconnected to running job",
            status: "running",
        };
    }
    return {
        percent: 0,
        message: `Queued (position ${detail.queuePosition ?? 0})`,
        status: "queued",
    };
}

function deriveFormState(config: SafeAuditConfig): AuditFormState {
    return {
        baseUrl: config.baseUrl,
        displayName: config.displayName,
        compareEnabled: (config.environments?.length ?? 0) > 1,
        environmentsText: (config.environments ?? [])
            .map((environment) => `${environment.name}=${environment.baseUrl}`)
            .join("\n"),
        pathsText: config.paths.join("\n"),
        formFactors: [...config.formFactors],
        categories: [...config.categories],
        runsPerPage: config.runsPerPage,
        throttlingPreset: config.throttling.preset,
        customRtt: config.throttling.custom?.rttMs ?? 150,
        customThroughput: config.throttling.custom?.throughputKbps ?? 1638.4,
        customCpu: config.throttling.custom?.cpuSlowdownMultiplier ?? 4,
        basicEnabled: config.basicAuth.enabled,
        basicUsername: config.basicAuth.username ?? "",
        basicPassword: "",
        formLoginEnabled: config.formLogin.enabled,
        loginUrl: config.formLogin.loginUrl ?? "",
        usernameSelector: config.formLogin.usernameSelector,
        username: config.formLogin.username ?? "",
        passwordSelector: config.formLogin.passwordSelector,
        password: "",
        submitSelector: config.formLogin.submitSelector,
        postLoginMode: config.formLogin.postLogin.mode,
        postLoginSelector: config.formLogin.postLogin.selector ?? "",
        postLoginDelay: config.formLogin.postLogin.delayMs ?? 2000,
        postLoginTimeout: config.formLogin.postLogin.timeoutMs,
    };
}
