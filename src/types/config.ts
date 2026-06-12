export type FormFactor = "mobile" | "desktop";
export type AuditMode = "static" | "manual-tabs";

export type LighthouseCategory =
  | "performance"
  | "accessibility"
  | "best-practices"
  | "seo"
  | "pwa";

export type ThrottlingPreset = "slow-4g" | "fast-3g" | "slow-3g" | "custom";

export interface CustomThrottling {
  rttMs: number;
  throughputKbps: number;
  cpuSlowdownMultiplier: number;
}

export interface ThrottlingConfig {
  preset: ThrottlingPreset;
  custom?: CustomThrottling | undefined;
}

export interface SecretEnvelope {
  alg: "aes-256-gcm";
  ciphertext: string;
  iv: string;
  tag: string;
}

export type SecretValue = string | SecretEnvelope;

export type ManualChromeCachePolicy = "preserve-profile";
export type ManualChromeEvidenceMode = "none" | "html";

export interface ManualChromeSelection {
  scanId: string;
  targetIds: string[];
  cachePolicy: ManualChromeCachePolicy;
  evidenceMode: ManualChromeEvidenceMode;
  /** When present, run a 2-environment compare audit over the selected tabs. */
  compare?: ManualCompareSelection | undefined;
}

export interface ManualCompareAnchor {
  /** User-given environment name, e.g. "Dev 1". */
  name: string;
  /** Id of a selected tab whose host defines this environment. */
  anchorTargetId: string;
}

export interface ManualCompareSelection {
  environments: [ManualCompareAnchor, ManualCompareAnchor];
}

export interface ManualCompareWarning {
  reason: "UNMATCHED_HOST" | "UNBALANCED_ROUTE" | "DUPLICATE_PATHNAME";
  displayUrl: string;
  detail?: string | undefined;
}

export interface ManualChromeTargetDescriptor {
  targetId: string;
  profileSessionId: string;
  ownerNonce?: string | undefined;
  serverInstanceId?: string | undefined;
  auditUrl: SecretValue;
  displayUrl: string;
  route: string;
  selectedAt: string;
  /** Set only for compare jobs — the environment this tab belongs to. */
  environment?: AuditEnvironment | undefined;
}

export interface ManualChromeQueuedConfig {
  cachePolicy: ManualChromeCachePolicy;
  evidenceMode: ManualChromeEvidenceMode;
  execution: ManualChromeExecutionData | SecretEnvelope;
}

export interface ManualChromeExecutionData {
  profileSessionId: string;
  ownerToken: string;
  fencingNumber: number;
  targets: ManualChromeTargetDescriptor[];
  /** Selection warnings from compare matching, surfaced as report diagnostics. */
  compareWarnings?: ManualCompareWarning[] | undefined;
}

export interface BasicAuthConfig {
  enabled: boolean;
  username?: string | undefined;
  password?: SecretValue | undefined;
}

export type PostLoginMode = "navigation" | "selector" | "delay";

export interface PostLoginConfig {
  mode: PostLoginMode;
  selector?: string | undefined;
  delayMs?: number | undefined;
  timeoutMs: number;
}

export interface FormLoginConfig {
  enabled: boolean;
  loginUrl?: string | undefined;
  usernameSelector: string;
  username?: string | undefined;
  passwordSelector: string;
  password?: SecretValue | undefined;
  submitSelector: string;
  postLogin: PostLoginConfig;
}

export interface AuditEnvironment {
  name: string;
  baseUrl: string;
}

export interface SharedAuditConfig {
  displayName: string;
  formFactors: FormFactor[];
  categories: LighthouseCategory[];
  runsPerPage: number;
  throttling: ThrottlingConfig;
}

export interface StaticAuditConfig extends SharedAuditConfig {
  mode?: "static";
  baseUrl: string;
  environments?: AuditEnvironment[] | undefined;
  paths: string[];
  basicAuth: BasicAuthConfig;
  formLogin: FormLoginConfig;
  manualChrome?: undefined;
}

export interface ManualTabsAuditConfig extends SharedAuditConfig {
  mode: "manual-tabs";
  baseUrl: string;
  environments?: undefined;
  paths: string[];
  basicAuth: BasicAuthConfig;
  formLogin: FormLoginConfig;
  manualChrome: ManualChromeQueuedConfig;
}

export type AuditConfig = StaticAuditConfig | ManualTabsAuditConfig;

export interface ManualTabsAuditRequest {
  mode: "manual-tabs";
  displayName: string;
  formFactors: FormFactor[];
  categories: LighthouseCategory[];
  runsPerPage: number;
  throttling: ThrottlingConfig;
  manualChrome: ManualChromeSelection;
}

export type ParsedAuditRequest = AuditConfig | ManualTabsAuditRequest;
