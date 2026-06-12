import type {
  AuditConfig,
  AuditMode,
  AuditEnvironment,
  BasicAuthConfig,
  FormLoginConfig,
  ManualChromeExecutionData,
  ThrottlingConfig
} from "../types/config.js";

export interface SafeAuditConfig {
  mode?: AuditMode | undefined;
  baseUrl: string;
  displayName: string;
  environments?: AuditEnvironment[] | undefined;
  paths: string[];
  formFactors: AuditConfig["formFactors"];
  categories: AuditConfig["categories"];
  runsPerPage: number;
  throttling: ThrottlingConfig;
  basicAuth: Omit<BasicAuthConfig, "password">;
  formLogin: Omit<FormLoginConfig, "password">;
  manualChrome?: {
    cachePolicy: "preserve-profile";
    evidenceMode: "none" | "html";
    targets: Array<{
      displayUrl: string;
      route: string;
    }>;
  } | undefined;
}

export function redactAuditConfig(config: AuditConfig): SafeAuditConfig {
  const { password: _basicPassword, ...basicAuth } = config.basicAuth;
  const { password: _formPassword, ...formLogin } = config.formLogin;

  return {
    mode: config.mode ?? "static",
    baseUrl: config.baseUrl,
    displayName: config.displayName,
    environments: config.environments?.map((environment) => ({ ...environment })),
    paths: [...config.paths],
    formFactors: [...config.formFactors],
    categories: [...config.categories],
    runsPerPage: config.runsPerPage,
    throttling: {
      preset: config.throttling.preset,
      custom: config.throttling.custom
        ? {
            rttMs: config.throttling.custom.rttMs,
            throughputKbps: config.throttling.custom.throughputKbps,
            cpuSlowdownMultiplier: config.throttling.custom.cpuSlowdownMultiplier
          }
        : undefined
    },
    basicAuth: { ...basicAuth },
    formLogin: {
      ...formLogin,
      postLogin: { ...formLogin.postLogin }
    },
    manualChrome: config.mode === "manual-tabs"
      ? {
          cachePolicy: config.manualChrome.cachePolicy,
          evidenceMode: config.manualChrome.evidenceMode,
          targets: (isSafeExecution(config.manualChrome.execution) ? config.manualChrome.execution.targets : []).map((target) => ({
            displayUrl: target.displayUrl,
            route: target.route
          }))
        }
      : undefined
  };
}

function isSafeExecution(value: unknown): value is ManualChromeExecutionData {
  return typeof value === "object" && value !== null && "targets" in value && Array.isArray(value.targets);
}
