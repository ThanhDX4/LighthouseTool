import { z } from "zod";
import type {
  AuditConfig,
  LighthouseCategory,
  ManualTabsAuditRequest,
  ParsedAuditRequest
} from "../types/config.js";

const categories: LighthouseCategory[] = [
  "performance",
  "accessibility",
  "best-practices",
  "seo",
  "pwa"
];

const defaultCategories: LighthouseCategory[] = [
  "performance",
  "accessibility",
  "best-practices",
  "seo"
];

const formFactorSchema = z.enum(["mobile", "desktop"]);
const categorySchema = z.enum(categories as [LighthouseCategory, ...LighthouseCategory[]]);
const environmentSchema = z.object({
  name: z.string().trim().min(1, "Environment name is required").max(40, "Environment name must be 40 characters or less"),
  baseUrl: z.string().min(1, "Environment URL is required").url("Environment URL must be a valid URL")
});

const staticSchema = z
  .object({
    mode: z.literal("static").default("static"),
    baseUrl: z.string().min(1, "Base URL is required").url("Base URL must be a valid URL"),
    displayName: z.string().trim().max(80, "Display name must be 80 characters or less").optional(),
    environments: z.array(environmentSchema).min(1).max(6, "No more than 6 environments are allowed").optional(),
    paths: z
      .array(z.string().trim().regex(/^\//, "Each path must start with /"))
      .min(1, "At least one path is required")
      .max(50, "No more than 50 paths are allowed"),
    formFactors: z
      .array(formFactorSchema)
      .min(1, "At least one form factor is required")
      .transform((items) => Array.from(new Set(items))),
    categories: z.array(categorySchema).min(1).default(defaultCategories),
    runsPerPage: z.number().int().min(1).max(11).default(1),
    throttling: z
      .object({
        preset: z.enum(["slow-4g", "fast-3g", "slow-3g", "custom"]).default("slow-4g"),
        custom: z
          .object({
            rttMs: z.number().min(0),
            throughputKbps: z.number().min(0),
            cpuSlowdownMultiplier: z.number().min(1).max(20)
          })
          .optional()
      })
      .default({ preset: "slow-4g" }),
    basicAuth: z
      .object({
        enabled: z.boolean().default(false),
        username: z.string().optional(),
        password: z.union([z.string(), z.any()]).optional()
      })
      .default({ enabled: false }),
    formLogin: z
      .object({
        enabled: z.boolean().default(false),
        loginUrl: z.string().optional(),
        usernameSelector: z.string().default("input[name=\"email\"]"),
        username: z.string().optional(),
        passwordSelector: z.string().default("input[name=\"password\"]"),
        password: z.union([z.string(), z.any()]).optional(),
        submitSelector: z.string().default("button[type=\"submit\"]"),
        postLogin: z
          .object({
            mode: z.enum(["navigation", "selector", "delay"]).default("navigation"),
            selector: z.string().optional(),
            delayMs: z.number().int().positive().optional(),
            timeoutMs: z.number().int().positive().default(30_000)
          })
          .default({ mode: "navigation", timeoutMs: 30_000 })
      })
      .default({
        enabled: false,
        usernameSelector: "input[name=\"email\"]",
        passwordSelector: "input[name=\"password\"]",
        submitSelector: "button[type=\"submit\"]",
        postLogin: { mode: "navigation", timeoutMs: 30_000 }
      })
  })
  .superRefine((value, ctx) => {
    if (value.throttling.preset === "custom" && !value.throttling.custom) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["throttling", "custom"],
        message: "Custom throttling values are required"
      });
    }

    if (!isHttpUrl(value.baseUrl)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["baseUrl"],
        message: "Base URL must use http or https"
      });
    }

    if (value.environments) {
      const names = new Set<string>();
      for (const [index, environment] of value.environments.entries()) {
        const normalizedName = environment.name.trim().toLowerCase();
        if (names.has(normalizedName)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["environments", index, "name"],
            message: "Environment names must be unique"
          });
        }
        names.add(normalizedName);

        if (!isHttpUrl(environment.baseUrl)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["environments", index, "baseUrl"],
            message: "Environment URL must use http or https"
          });
        }
      }
    }

    if (value.basicAuth.enabled) {
      if (!value.basicAuth.username?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["basicAuth", "username"],
          message: "Basic Auth username is required"
        });
      }
      if (typeof value.basicAuth.password !== "string" || !value.basicAuth.password.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["basicAuth", "password"],
          message: "Basic Auth password is required"
        });
      }
    }

    if (value.formLogin.enabled) {
      const loginUrlResult = z.string().url().safeParse(value.formLogin.loginUrl);
      if (!loginUrlResult.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["formLogin", "loginUrl"],
          message: "Login URL must be a valid URL"
        });
      } else if (!isHttpUrl(loginUrlResult.data)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["formLogin", "loginUrl"],
          message: "Login URL must use http or https"
        });
      }
      if (!value.formLogin.username?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["formLogin", "username"],
          message: "Form login username is required"
        });
      }
      if (typeof value.formLogin.password !== "string" || !value.formLogin.password.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["formLogin", "password"],
          message: "Form login password is required"
        });
      }
      if (value.formLogin.postLogin.mode === "selector" && !value.formLogin.postLogin.selector?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["formLogin", "postLogin", "selector"],
          message: "Post-login selector is required"
        });
      }
      if (value.formLogin.postLogin.mode === "delay" && !value.formLogin.postLogin.delayMs) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["formLogin", "postLogin", "delayMs"],
          message: "Post-login delay is required"
        });
      }
    }
  });

const manualSchema = z
  .object({
    mode: z.literal("manual-tabs"),
    displayName: z.string().trim().max(80, "Display name must be 80 characters or less").default("Manual Chrome Tabs"),
    formFactors: z
      .array(formFactorSchema)
      .min(1, "At least one form factor is required")
      .transform((items) => Array.from(new Set(items))),
    categories: z.array(categorySchema).min(1).default(defaultCategories),
    runsPerPage: z.number().int().min(1).max(11).default(1),
    throttling: z
      .object({
        preset: z.enum(["slow-4g", "fast-3g", "slow-3g", "custom"]).default("slow-4g"),
        custom: z
          .object({
            rttMs: z.number().min(0),
            throughputKbps: z.number().positive(),
            cpuSlowdownMultiplier: z.number().min(1).max(20)
          })
          .optional()
      })
      .default({ preset: "slow-4g" }),
    manualChrome: z.object({
      scanId: z.string().trim().min(1, "Scan ID is required"),
      targetIds: z
        .array(z.string().trim().min(1, "Target ID is required"))
        .min(1, "At least one selected tab is required")
        .max(20, "No more than 20 selected tabs are allowed")
        .transform((items) => Array.from(new Set(items))),
      cachePolicy: z.literal("preserve-profile"),
      evidenceMode: z.enum(["none", "html"]),
      compare: z
        .object({
          environments: z.tuple([
            z.object({
              name: z.string().trim().min(1, "Environment name is required"),
              anchorTargetId: z.string().trim().min(1, "Anchor tab is required")
            }),
            z.object({
              name: z.string().trim().min(1, "Environment name is required"),
              anchorTargetId: z.string().trim().min(1, "Anchor tab is required")
            })
          ])
        })
        .optional()
    })
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.throttling.preset === "custom" && !value.throttling.custom) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["throttling", "custom"],
        message: "Custom throttling values are required"
      });
    }
  });

export function parseAuditRequest(input: { mode: "manual-tabs" } & Record<string, unknown>): ManualTabsAuditRequest;
export function parseAuditRequest(input: { mode?: "static"; baseUrl: string } & Record<string, unknown>): AuditConfig;
export function parseAuditRequest(input: unknown): ParsedAuditRequest;
export function parseAuditRequest(input: unknown): ParsedAuditRequest {
  const normalized = normalizeAuditRequestInput(input);
  if (isRecord(normalized) && normalized.mode === "manual-tabs") {
    const parsed = manualSchema.safeParse(normalized);
    if (!parsed.success) {
      throw new Error(parsed.error.issues.map(formatZodIssue).join("; "));
    }
    return {
      ...parsed.data,
      displayName: parsed.data.displayName.trim() || "Manual Chrome Tabs",
      formFactors: [...parsed.data.formFactors],
      categories: [...parsed.data.categories],
      throttling: {
        preset: parsed.data.throttling.preset,
        custom: parsed.data.throttling.custom ? { ...parsed.data.throttling.custom } : undefined
      },
      manualChrome: {
        scanId: parsed.data.manualChrome.scanId,
        targetIds: [...parsed.data.manualChrome.targetIds],
        cachePolicy: parsed.data.manualChrome.cachePolicy,
        evidenceMode: parsed.data.manualChrome.evidenceMode,
        compare: parsed.data.manualChrome.compare
          ? {
              environments: [
                { ...parsed.data.manualChrome.compare.environments[0] },
                { ...parsed.data.manualChrome.compare.environments[1] }
              ] as [{ name: string; anchorTargetId: string }, { name: string; anchorTargetId: string }]
            }
          : undefined
      }
    };
  }

  const parsed = staticSchema.safeParse(normalized);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map(formatZodIssue).join("; "));
  }

  const baseUrl = normalizeBaseUrl(parsed.data.baseUrl);
  const displayName = parsed.data.displayName?.trim() || new URL(baseUrl).hostname;
  const environments = parsed.data.environments?.map((environment) => ({
    name: environment.name.trim(),
    baseUrl: normalizeBaseUrl(environment.baseUrl)
  }));

  return {
    ...parsed.data,
    mode: "static",
    baseUrl,
    displayName,
    environments,
    paths: parsed.data.paths.map(normalizePath),
    categories: Array.from(new Set(parsed.data.categories)),
    basicAuth: parsed.data.basicAuth,
    formLogin: parsed.data.formLogin
  };
}

function formatZodIssue(issue: z.ZodIssue): string {
  if (issue.code === z.ZodIssueCode.unrecognized_keys) {
    return `Unexpected field(s): ${issue.keys.join(", ")}`;
  }
  return issue.message;
}

export function parsePathText(text: string): string[] {
  const unique = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    unique.add(normalizePath(trimmed));
  }
  return Array.from(unique);
}

export function normalizeWebUrlInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;

  const protocol = isLoopbackUrlInput(trimmed) ? "http" : "https";
  return `${protocol}://${trimmed}`;
}

function normalizeAuditRequestInput(input: unknown): unknown {
  if (!isRecord(input)) return input;

  const normalized: Record<string, unknown> = { ...input };
  if (typeof normalized.baseUrl === "string") {
    normalized.baseUrl = normalizeWebUrlInput(normalized.baseUrl);
  }

  if (Array.isArray(normalized.environments)) {
    normalized.environments = normalized.environments.map((environment) => {
      if (!isRecord(environment)) return environment;
      const nextEnvironment = { ...environment };
      if (typeof nextEnvironment.baseUrl === "string") {
        nextEnvironment.baseUrl = normalizeWebUrlInput(nextEnvironment.baseUrl);
      }
      return nextEnvironment;
    });
  }

  if (isRecord(normalized.formLogin)) {
    const formLogin = { ...normalized.formLogin };
    if (typeof formLogin.loginUrl === "string") {
      formLogin.loginUrl = normalizeWebUrlInput(formLogin.loginUrl);
    }
    normalized.formLogin = formLogin;
  }

  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isLoopbackUrlInput(value: string): boolean {
  const lower = value.toLowerCase();
  return lower.startsWith("localhost") || lower.startsWith("127.") || lower.startsWith("[::1]") || lower.startsWith("::1");
}

function normalizePath(value: string): string {
  const withSlash = value.startsWith("/") ? value : `/${value}`;
  const [withoutHash] = withSlash.split("#");
  const [withoutQuery] = (withoutHash ?? "/").split("?");
  const normalized = withoutQuery || "/";
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

function normalizeBaseUrl(value: string): string {
  const parsed = new URL(value);
  return parsed.origin + parsed.pathname.replace(/\/+$/, "");
}
