export type ManualChromeErrorCode =
  | "MANUAL_CHROME_DISABLED"
  | "MANUAL_CHROME_FORBIDDEN"
  | "MANUAL_CHROME_BUSY"
  | "MANUAL_CHROME_STARTING"
  | "MANUAL_CHROME_PORT_IN_USE"
  | "MANUAL_CHROME_UNOWNED"
  | "MANUAL_CHROME_START_TIMEOUT"
  | "MANUAL_CHROME_UNAVAILABLE"
  | "MANUAL_CHROME_INVALID_SELECTION";

export interface ManualChromeSessionRecord {
  profileSessionId: string;
  ownerNonce: string;
  serverInstanceId: string;
  port: number;
  profileDir: string;
  processId: number;
  startedAt: string;
  expiresAt: string;
}

export interface ManualChromeScanTab {
  id: string;
  title: string;
  rawUrl: string;
  displayUrl: string;
  hasHiddenUrlParts: boolean;
  valid: boolean;
  redirectHosts: string[];
  reason?: string | undefined;
}

export interface ManualChromeScanSnapshot {
  scanId: string;
  profileSessionId: string;
  serverInstanceId: string;
  expiresAt: string;
  tabs: ManualChromeScanTab[];
}

export interface ManualChromeLockRecord {
  jobId: string;
  profileSessionId: string;
  ownerToken: string;
  fencingNumber: number;
  state: "queued" | "running";
  expiresAt: string;
}

export interface ManualChromeLockIdentity {
  profileSessionId: string;
  ownerToken: string;
  fencingNumber: number;
}
