import { Gauge } from "lucide-react";
import type { PropsWithChildren, ReactNode } from "react";

type ClassValue = string | false | null | undefined;
type ButtonVariant = "primary" | "secondary" | "ghost" | "success" | "danger";
type ButtonSize = "sm" | "md";
type NoticeTone = "info" | "warning" | "danger" | "success";
type StatusTone =
    | "idle"
    | "queued"
    | "running"
    | "done"
    | "completed"
    | "partial"
    | "failed";

export function cn(...classes: ClassValue[]) {
    return classes.filter(Boolean).join(" ");
}

export const pageContainerClass =
    "mx-auto w-full max-w-[1440px] px-5 sm:px-8 lg:px-10";

export const workspaceClass =
    "mx-auto grid w-full max-w-[1440px] gap-7 px-5 pb-16 sm:px-8 lg:grid-cols-[minmax(0,1fr)_380px] lg:px-10 xl:grid-cols-[minmax(0,1fr)_420px]";

export const surfaceClass =
    "relative overflow-hidden rounded-3xl border border-ink-200/70 bg-white shadow-[0_1px_0_rgba(15,23,42,0.04),0_18px_42px_-30px_rgba(15,23,42,0.28)]";

export const panelClass = cn(surfaceClass, "p-6 sm:p-7");

export const subtleSurfaceClass =
    "rounded-2xl border border-ink-200/70 bg-ink-50/60 px-4 py-4 sm:px-5";

export const eyebrowClass =
    "text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-500";

export const fieldLabelClass =
    "block text-sm font-medium tracking-tight text-ink-800";

export const fieldHintClass =
    "mt-1.5 block text-xs leading-5 text-ink-500";

export const inputBaseClass =
    "min-h-11 w-full rounded-xl border border-ink-200 bg-white px-3.5 py-2.5 text-sm text-ink-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.6),inset_0_-1px_0_rgba(15,23,42,0.04)] outline-none transition duration-150 placeholder:text-ink-400 hover:border-ink-300 focus:border-accent-500 focus:ring-4 focus:ring-accent-500/15 disabled:cursor-not-allowed disabled:border-ink-200 disabled:bg-ink-100 disabled:text-ink-500";

export const inputClass = cn("mt-1.5 block", inputBaseClass);

export const textareaClass = cn(
    inputClass,
    "min-h-32 resize-y font-mono text-[13px] leading-6 tracking-tight",
);

export const selectClass = cn(
    inputClass,
    "cursor-pointer appearance-none bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 12 12%22 fill=%22none%22 stroke=%22%2371717a%22 stroke-width=%221.5%22 stroke-linecap=%22round%22><path d=%22M3 4.5l3 3 3-3%22/></svg>')] bg-[length:12px_12px] bg-[right_14px_center] bg-no-repeat pr-10",
);

export const fieldsetClass = cn(subtleSurfaceClass, "space-y-3 p-4 sm:p-5");

export const legendClass =
    "px-1 text-xs font-semibold uppercase tracking-[0.16em] text-ink-600";

export function buttonClass(
    variant: ButtonVariant = "secondary",
    size: ButtonSize = "md",
) {
    const base =
        "group/btn inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-xl font-semibold tracking-tight transition duration-150 ease-out focus-visible:outline-none focus-visible:ring-4 disabled:pointer-events-none disabled:opacity-50 active:translate-y-px";
    const sizes: Record<ButtonSize, string> = {
        sm: "min-h-9 px-3 text-[13px]",
        md: "min-h-11 px-4 text-sm",
    };
    const variants: Record<ButtonVariant, string> = {
        primary:
            "border border-accent-700/60 bg-accent-600 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_8px_24px_-12px_rgba(48,79,254,0.65)] hover:bg-accent-700 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_10px_28px_-12px_rgba(48,79,254,0.75)] focus-visible:ring-accent-500/30",
        secondary:
            "border border-ink-200 bg-white text-ink-800 shadow-[inset_0_1px_0_rgba(255,255,255,0.8),0_1px_2px_rgba(15,23,42,0.04)] hover:border-ink-300 hover:bg-ink-50 focus-visible:ring-ink-400/25",
        ghost:
            "border border-transparent bg-transparent text-ink-700 hover:bg-ink-100/80 focus-visible:ring-ink-400/25",
        success:
            "border border-emerald-700/60 bg-emerald-600 text-white shadow-[0_8px_24px_-12px_rgba(5,150,105,0.55)] hover:bg-emerald-700 focus-visible:ring-emerald-500/30",
        danger:
            "border border-rose-700/60 bg-rose-600 text-white shadow-[0_8px_24px_-12px_rgba(190,18,60,0.55)] hover:bg-rose-700 focus-visible:ring-rose-500/30",
    };
    return cn(base, sizes[size], variants[variant]);
}

export function statusToneClass(status: string) {
    const fallback = "bg-ink-100 text-ink-600 ring-ink-200";
    const tones: Record<StatusTone, string> = {
        idle: "bg-ink-100 text-ink-600 ring-ink-200",
        queued: "bg-amber-50 text-amber-700 ring-amber-200",
        running: "bg-accent-50 text-accent-700 ring-accent-300",
        done: "bg-emerald-50 text-emerald-700 ring-emerald-200",
        completed: "bg-emerald-50 text-emerald-700 ring-emerald-200",
        partial: "bg-amber-50 text-amber-700 ring-amber-200",
        failed: "bg-rose-50 text-rose-700 ring-rose-200",
    };
    return (tones as Record<string, string>)[status] ?? fallback;
}

export function statusBadgeClass(status: string) {
    return cn(
        "inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-[11px] font-semibold uppercase tracking-[0.12em] ring-1 ring-inset tabular",
        statusToneClass(status),
    );
}

export function AppShell({ children }: PropsWithChildren) {
    return (
        <main className="relative min-h-[100dvh] overflow-x-hidden bg-ink-50 text-ink-950">
            <div
                aria-hidden
                className="pointer-events-none absolute inset-0 -z-10 ambient-grid opacity-60"
            />
            <div
                aria-hidden
                className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[480px] bg-[radial-gradient(80%_60%_at_18%_0%,oklch(94%_0.05_252/0.55),transparent_60%),radial-gradient(60%_50%_at_88%_4%,oklch(96%_0.018_252/0.6),transparent_55%)]"
            />
            {children}
        </main>
    );
}

export function BrandMark() {
    return (
        <span className="relative inline-flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-ink-950 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_8px_22px_-12px_rgba(15,23,42,0.6)]">
            <span
                aria-hidden
                className="absolute inset-0 bg-[radial-gradient(120%_100%_at_50%_0%,rgba(106,156,255,0.5),transparent_55%)]"
            />
            <Gauge
                size={18}
                strokeWidth={1.6}
                aria-hidden="true"
                className="relative"
            />
        </span>
    );
}

export function AppHeader({
    title = "Lighthouse Audit Tool",
    eyebrow = "Performance instruments",
    description,
    actions,
}: {
    title?: string;
    eyebrow?: string;
    description: string;
    actions?: ReactNode;
}) {
    return (
        <header className="sticky top-0 z-30 border-b border-ink-200/60 bg-ink-50/80 backdrop-blur-xl supports-[backdrop-filter]:bg-ink-50/65">
            <div
                className={cn(
                    pageContainerClass,
                    "flex flex-col gap-4 py-4 lg:flex-row lg:items-center lg:justify-between",
                )}
            >
                <div className="flex min-w-0 items-center gap-3">
                    <BrandMark />
                    <div className="min-w-0">
                        <p className={cn(eyebrowClass, "text-ink-500")}>
                            {eyebrow}
                        </p>
                        <div className="flex items-baseline gap-2">
                            <h1 className="truncate text-[15px] font-semibold tracking-tight text-ink-950">
                                {title}
                            </h1>
                            <span className="hidden text-[11px] font-medium uppercase tracking-[0.16em] text-ink-400 sm:inline">
                                · {description}
                            </span>
                        </div>
                    </div>
                </div>
                {actions ? (
                    <div className="flex flex-wrap items-center gap-1.5">
                        {actions}
                    </div>
                ) : null}
            </div>
        </header>
    );
}

export function NavButton({
    icon,
    label,
    onClick,
    active,
}: {
    icon: ReactNode;
    label: string;
    onClick: () => void;
    active?: boolean;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                "inline-flex h-9 items-center gap-2 rounded-full px-3 text-[13px] font-medium tracking-tight transition duration-150 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ink-400/25",
                active
                    ? "bg-ink-950 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.15)]"
                    : "text-ink-700 hover:bg-ink-100/70 hover:text-ink-950",
            )}
            aria-pressed={active}
        >
            <span className="inline-flex size-4 items-center justify-center [&>svg]:size-4">
                {icon}
            </span>
            {label}
        </button>
    );
}

export function PageIntro({
    title,
    description,
    eyebrow = "Audit setup",
    children,
}: PropsWithChildren<{
    title: string;
    description: string;
    eyebrow?: string;
}>) {
    return (
        <section
            className={cn(
                "relative overflow-hidden rounded-[28px] border border-ink-200/70 bg-white",
                "shadow-[0_1px_0_rgba(15,23,42,0.03),0_22px_60px_-30px_rgba(30,41,59,0.28)]",
            )}
        >
            <div
                aria-hidden
                className="pointer-events-none absolute inset-0 bg-[radial-gradient(70%_60%_at_88%_0%,oklch(86%_0.09_252/0.45),transparent_60%),linear-gradient(135deg,#ffffff_0%,#fbfbfd_45%,oklch(96%_0.018_252/0.7)_100%)]"
            />
            <div
                aria-hidden
                className="pointer-events-none absolute -right-24 -top-24 size-[420px] rounded-full bg-[radial-gradient(circle,oklch(78%_0.11_252/0.18),transparent_60%)] blur-2xl"
            />
            <div className="relative grid gap-10 p-7 sm:p-9 lg:grid-cols-[minmax(0,1.4fr)_minmax(280px,1fr)] lg:items-end lg:p-12">
                <div>
                    <div className="mb-6 flex items-center gap-2">
                        <span className="inline-flex size-1.5 rounded-full bg-accent-500 pulse-soft" />
                        <p className={eyebrowClass}>{eyebrow}</p>
                    </div>
                    <h2
                        className="text-balance text-[34px] font-semibold leading-[1.04] tracking-[-0.03em] text-ink-950 sm:text-[44px] lg:text-[56px]"
                        style={{ textWrap: "balance" }}
                    >
                        {title}
                    </h2>
                    <p className="mt-5 max-w-2xl text-pretty text-[15px] leading-[1.65] text-ink-600 sm:text-base">
                        {description}
                    </p>
                </div>
                {children}
            </div>
        </section>
    );
}

export function MetricTile({
    label,
    value,
    description,
    accent,
}: {
    label: string;
    value: string | number;
    description?: string;
    accent?: boolean;
}) {
    return (
        <div
            className={cn(
                "rounded-2xl border bg-white/85 p-4 backdrop-blur",
                accent
                    ? "border-accent-300/50 shadow-[0_10px_30px_-18px_rgba(56,89,255,0.5)]"
                    : "border-ink-200/70 shadow-[0_1px_0_rgba(15,23,42,0.03)]",
            )}
        >
            <p className={cn(eyebrowClass, "text-ink-500")}>{label}</p>
            <p
                className={cn(
                    "mt-3 text-[26px] font-semibold tracking-[-0.02em] tabular",
                    accent ? "text-accent-700" : "text-ink-950",
                )}
            >
                {value}
            </p>
            {description ? (
                <p className="mt-1 text-[12.5px] leading-5 text-ink-500">
                    {description}
                </p>
            ) : null}
        </div>
    );
}

export function MetricRow({ children }: PropsWithChildren) {
    return (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-2">{children}</div>
    );
}

export function Panel({
    eyebrow,
    title,
    description,
    icon,
    actions,
    aside,
    children,
    as = "section",
    padded = true,
}: PropsWithChildren<{
    eyebrow?: string;
    title?: string;
    description?: string;
    icon?: ReactNode;
    actions?: ReactNode;
    aside?: ReactNode;
    as?: "section" | "div";
    padded?: boolean;
}>) {
    const Tag = as;
    return (
        <Tag className={cn(surfaceClass, padded ? "p-6 sm:p-7" : "")}>
            {(eyebrow || title || description || actions || aside) && (
                <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="flex items-start gap-3">
                        {icon ? (
                            <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-ink-950 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]">
                                <span className="[&>svg]:size-[18px]">
                                    {icon}
                                </span>
                            </div>
                        ) : null}
                        <div className="min-w-0">
                            {eyebrow ? (
                                <p className={cn(eyebrowClass, "mb-1")}>
                                    {eyebrow}
                                </p>
                            ) : null}
                            {title ? (
                                <h2 className="text-[17px] font-semibold tracking-tight text-ink-950">
                                    {title}
                                </h2>
                            ) : null}
                            {description ? (
                                <p className="mt-1 max-w-2xl text-[13.5px] leading-6 text-ink-500">
                                    {description}
                                </p>
                            ) : null}
                        </div>
                    </div>
                    {actions || aside ? (
                        <div className="flex flex-wrap items-center gap-2">
                            {actions}
                            {aside}
                        </div>
                    ) : null}
                </header>
            )}
            {children ? (
                <div
                    className={cn(
                        (eyebrow || title || description) && "mt-6",
                        "space-y-5",
                    )}
                >
                    {children}
                </div>
            ) : null}
        </Tag>
    );
}

export function Field({
    label,
    hint,
    children,
    htmlFor,
    inline,
}: PropsWithChildren<{
    label?: string;
    hint?: ReactNode;
    htmlFor?: string;
    inline?: boolean;
}>) {
    return (
        <label
            htmlFor={htmlFor}
            className={cn("block", inline && "inline-block")}
        >
            {label ? <span className={fieldLabelClass}>{label}</span> : null}
            {children}
            {hint ? <span className={fieldHintClass}>{hint}</span> : null}
        </label>
    );
}

export function Eyebrow({ children }: PropsWithChildren) {
    return <p className={eyebrowClass}>{children}</p>;
}

export function StatusPill({
    status,
    label,
    pulse,
}: {
    status: string;
    label?: string | undefined;
    pulse?: boolean | undefined;
}) {
    return (
        <span className={statusBadgeClass(status)}>
            <span
                className={cn(
                    "size-1.5 rounded-full bg-current",
                    pulse && "pulse-soft",
                )}
                aria-hidden
            />
            {label ?? status}
        </span>
    );
}

export function ProgressBar({
    percent,
    running,
}: {
    percent: number;
    running?: boolean;
}) {
    const clamped = Math.min(100, Math.max(0, percent));
    return (
        <div
            className="relative h-1.5 w-full overflow-hidden rounded-full bg-ink-200/70"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(clamped)}
        >
            <div
                className={cn(
                    "absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-out",
                    running ? "progress-shimmer" : "bg-accent-500",
                )}
                style={{ width: `${clamped}%` }}
            />
        </div>
    );
}

export function EmptyState({
    title,
    description,
    icon,
    action,
}: {
    title: string;
    description?: string;
    icon?: ReactNode;
    action?: ReactNode;
}) {
    return (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-ink-300/70 bg-white/40 px-6 py-10 text-center">
            {icon ? (
                <div className="mb-3 flex size-11 items-center justify-center rounded-2xl bg-ink-100 text-ink-500 [&>svg]:size-5">
                    {icon}
                </div>
            ) : null}
            <h3 className="text-[15px] font-semibold tracking-tight text-ink-900">
                {title}
            </h3>
            {description ? (
                <p className="mt-1.5 max-w-md text-[13.5px] leading-6 text-ink-500">
                    {description}
                </p>
            ) : null}
            {action ? <div className="mt-4">{action}</div> : null}
        </div>
    );
}

export function Notice({
    tone = "info",
    icon,
    children,
}: PropsWithChildren<{ tone?: NoticeTone; icon?: ReactNode }>) {
    const tones: Record<NoticeTone, string> = {
        info: "border-accent-200/80 bg-accent-50/70 text-accent-700",
        warning: "border-amber-200/80 bg-amber-50/70 text-amber-800",
        danger: "border-rose-200/80 bg-rose-50/70 text-rose-800",
        success: "border-emerald-200/80 bg-emerald-50/70 text-emerald-800",
    };

    return (
        <div
            className={cn(
                "flex items-start gap-3 rounded-2xl border px-4 py-3 text-[13.5px] leading-6",
                tones[tone],
            )}
            role={tone === "danger" ? "alert" : undefined}
        >
            {icon ? (
                <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center [&>svg]:size-4">
                    {icon}
                </span>
            ) : null}
            <span className="text-balance">{children}</span>
        </div>
    );
}

export function ErrorBanner({ children }: PropsWithChildren) {
    return (
        <div
            role="alert"
            className="flex items-start gap-3 rounded-2xl border border-rose-200/70 bg-rose-50/80 px-4 py-3 text-rose-800"
        >
            <span className="mt-1 inline-block size-2 shrink-0 rounded-full bg-rose-500" />
            <span className="font-mono text-[12.5px] leading-6">
                {children}
            </span>
        </div>
    );
}

export function MutedText({
    children,
    className,
}: PropsWithChildren<{ className?: string }>) {
    return (
        <p className={cn("text-[12.5px] leading-5 text-ink-500", className)}>
            {children}
        </p>
    );
}

export function Chip({
    active,
    onClick,
    disabled,
    children,
}: PropsWithChildren<{
    active?: boolean;
    onClick?: () => void;
    disabled?: boolean;
}>) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className={cn(
                "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-medium tracking-tight transition duration-150 focus-visible:outline-none focus-visible:ring-4 disabled:cursor-not-allowed disabled:opacity-50",
                active
                    ? "border-ink-950 bg-ink-950 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.15)] focus-visible:ring-ink-400/25"
                    : "border-ink-200 bg-white text-ink-700 hover:border-ink-300 hover:bg-ink-50 focus-visible:ring-ink-400/25",
            )}
            aria-pressed={active}
        >
            <span
                aria-hidden
                className={cn(
                    "inline-flex size-3.5 items-center justify-center rounded-full border transition",
                    active
                        ? "border-white bg-white/15"
                        : "border-ink-300 bg-white",
                )}
            >
                {active ? (
                    <svg
                        viewBox="0 0 12 12"
                        fill="none"
                        className="size-2.5"
                        aria-hidden
                    >
                        <path
                            d="M2.5 6.5l2.5 2.5L9.5 4"
                            stroke="currentColor"
                            strokeWidth={1.8}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        />
                    </svg>
                ) : null}
            </span>
            {children}
        </button>
    );
}

export function Kbd({ children }: PropsWithChildren) {
    return (
        <kbd className="inline-flex h-5 items-center rounded-md border border-ink-200 bg-ink-50 px-1.5 font-mono text-[10.5px] font-medium uppercase tracking-wide text-ink-600">
            {children}
        </kbd>
    );
}
