import { Gauge } from "lucide-react";
import { toggle } from "./form-controls.js";
import type { Category, ThrottlingPreset } from "./job-detail.js";
import {
    Chip,
    Field,
    Panel,
    cn,
    eyebrowClass,
    inputBaseClass,
    inputClass,
} from "./ui.js";

interface LighthouseSettingsProps {
    disabled: boolean;
    categories: Category[];
    setCategories: (next: Category[]) => void;
    throttlingPreset: ThrottlingPreset;
    setThrottlingPreset: (preset: ThrottlingPreset) => void;
    customRtt: number;
    setCustomRtt: (value: number) => void;
    customThroughput: number;
    setCustomThroughput: (value: number) => void;
    customCpu: number;
    setCustomCpu: (value: number) => void;
}

const CATEGORIES: { id: Category; label: string; hint: string }[] = [
    { id: "performance", label: "Performance", hint: "Core Web Vitals" },
    { id: "accessibility", label: "Accessibility", hint: "WCAG audits" },
    { id: "best-practices", label: "Best Practices", hint: "HTTPS, errors" },
    { id: "seo", label: "SEO", hint: "Indexability" },
    { id: "pwa", label: "PWA", hint: "Deprecated in LH 12" },
];

const PRESETS: { id: ThrottlingPreset; label: string; tag: string }[] = [
    { id: "slow-4g", label: "Slow 4G", tag: "Mobile default" },
    { id: "fast-3g", label: "Fast 3G", tag: "Heavier" },
    { id: "slow-3g", label: "Slow 3G", tag: "Worst case" },
    { id: "custom", label: "Custom", tag: "Manual" },
];

export function LighthouseSettings({
    disabled,
    categories,
    setCategories,
    throttlingPreset,
    setThrottlingPreset,
    customRtt,
    setCustomRtt,
    customThroughput,
    setCustomThroughput,
    customCpu,
    setCustomCpu,
}: LighthouseSettingsProps) {
    return (
        <Panel
            eyebrow="02 · Measurement"
            title="Lighthouse settings"
            description="Pick the categories to score and the throttling profile each run inherits."
            icon={<Gauge />}
        >
            <div>
                <p className={cn(eyebrowClass, "mb-3")}>Categories</p>
                <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
                    {CATEGORIES.map((category) => (
                        <Chip
                            key={category.id}
                            active={categories.includes(category.id)}
                            disabled={disabled}
                            onClick={() =>
                                toggle(category.id, categories, setCategories)
                            }
                        >
                            <span className="flex items-baseline gap-1.5">
                                {category.label}
                                <span
                                    className={cn(
                                        "text-[10.5px] font-medium tracking-wide",
                                        categories.includes(category.id)
                                            ? "text-white/60"
                                            : "text-ink-400",
                                    )}
                                >
                                    {category.hint}
                                </span>
                            </span>
                        </Chip>
                    ))}
                </div>
            </div>

            <div>
                <p className={cn(eyebrowClass, "mb-3")}>Mobile throttling</p>
                <div
                    role="radiogroup"
                    aria-label="Mobile throttling preset"
                    className="grid grid-cols-2 gap-1.5 sm:grid-cols-4"
                >
                    {PRESETS.map((preset) => {
                        const active = throttlingPreset === preset.id;
                        return (
                            <button
                                key={preset.id}
                                type="button"
                                role="radio"
                                aria-checked={active}
                                disabled={disabled}
                                onClick={() => setThrottlingPreset(preset.id)}
                                className={cn(
                                    "group flex flex-col items-start gap-1 rounded-xl border px-3 py-2.5 text-left transition duration-150 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-accent-500/25 disabled:cursor-not-allowed disabled:opacity-60",
                                    active
                                        ? "border-ink-950 bg-ink-950 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.15),0_10px_30px_-18px_rgba(15,23,42,0.55)]"
                                        : "border-ink-200 bg-white text-ink-800 hover:border-ink-300 hover:bg-ink-50",
                                )}
                            >
                                <span className="text-[13.5px] font-semibold tracking-tight">
                                    {preset.label}
                                </span>
                                <span
                                    className={cn(
                                        "text-[10.5px] font-medium uppercase tracking-[0.14em]",
                                        active
                                            ? "text-white/55"
                                            : "text-ink-400",
                                    )}
                                >
                                    {preset.tag}
                                </span>
                            </button>
                        );
                    })}
                </div>
            </div>

            {throttlingPreset === "custom" ? (
                <div className="grid gap-3 rounded-2xl border border-ink-200/70 bg-ink-50/60 p-4 sm:grid-cols-3">
                    <Field label="RTT (ms)" hint="Round-trip latency">
                        <input
                            type="number"
                            min={0}
                            value={customRtt}
                            disabled={disabled}
                            onChange={(event) =>
                                setCustomRtt(Number(event.target.value))
                            }
                            className={cn(inputClass, "font-mono tabular")}
                        />
                    </Field>
                    <Field label="Throughput (Kbps)" hint="Per-connection cap">
                        <input
                            type="number"
                            min={0}
                            value={customThroughput}
                            disabled={disabled}
                            onChange={(event) =>
                                setCustomThroughput(Number(event.target.value))
                            }
                            className={cn(inputClass, "font-mono tabular")}
                        />
                    </Field>
                    <Field
                        label="CPU slowdown"
                        hint="1× = unthrottled, 4× = mobile"
                    >
                        <input
                            type="number"
                            min={1}
                            max={20}
                            value={customCpu}
                            disabled={disabled}
                            onChange={(event) =>
                                setCustomCpu(Number(event.target.value))
                            }
                            className={cn(inputClass, "font-mono tabular")}
                        />
                    </Field>
                </div>
            ) : null}
        </Panel>
    );
}

// Re-export so consumers don't need to know which file holds the raw input class
export { inputBaseClass };
