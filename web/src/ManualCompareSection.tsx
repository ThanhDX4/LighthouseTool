import { Layers } from "lucide-react";
import { PlainCheckbox } from "./form-controls.js";
import {
    isManualCompareValid,
    previewCompareMatch,
    type ManualCompareAnchorInput,
    type ManualCompareInput,
    type ManualScanTab,
} from "./manual-chrome.js";
import { Field, Notice, cn, inputBaseClass } from "./ui.js";

interface ManualCompareSectionProps {
    tabs: ManualScanTab[];
    selectedIds: string[];
    compare: ManualCompareInput;
    disabled?: boolean;
    onChange: (next: ManualCompareInput) => void;
}

const warningLabels: Record<string, string> = {
    UNMATCHED_HOST: "doesn't match either environment and will be skipped",
    UNBALANCED_ROUTE: "exists in only one environment (the other shows N/A)",
    DUPLICATE_PATHNAME: "duplicates a path already mapped (only the first is kept)",
};

export function ManualCompareSection({
    tabs,
    selectedIds,
    compare,
    disabled,
    onChange,
}: ManualCompareSectionProps) {
    const selectedTabs = tabs.filter((tab) => selectedIds.includes(tab.id));
    const valid = isManualCompareValid(tabs, compare);
    const preview =
        compare.enabled && valid
            ? previewCompareMatch(tabs, selectedIds, compare.environments)
            : null;

    function setEnvironment(index: 0 | 1, patch: Partial<ManualCompareAnchorInput>): void {
        const environments = compare.environments.map((environment, current) =>
            current === index ? { ...environment, ...patch } : environment,
        ) as [ManualCompareAnchorInput, ManualCompareAnchorInput];
        onChange({ ...compare, environments });
    }

    return (
        <section
            aria-labelledby="compare-heading"
            className="rounded-2xl border border-ink-200/70 bg-gradient-to-br from-white to-ink-50/50 p-4"
        >
            <PlainCheckbox
                label="Compare 2 environments"
                description="Audit the same routes across two subdomains and add a Compare sheet to the report."
                checked={compare.enabled}
                disabled={disabled ?? false}
                onChange={() => onChange({ ...compare, enabled: !compare.enabled })}
            />

            {compare.enabled ? (
                <div className="mt-4 space-y-4">
                    <div className="grid gap-3 sm:grid-cols-2">
                        {([0, 1] as const).map((index) => {
                            const environment = compare.environments[index];
                            return (
                                <div
                                    key={index}
                                    className="rounded-xl border border-ink-200/80 bg-white p-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.6)]"
                                >
                                    <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-accent-700">
                                        <Layers size={12} strokeWidth={2} aria-hidden />
                                        Environment {index + 1}
                                    </div>
                                    <div className="mt-2.5 space-y-2.5">
                                        <Field label="Name">
                                            <input
                                                className={cn("mt-1.5 block", inputBaseClass)}
                                                placeholder={index === 0 ? "e.g. Dev 1" : "e.g. Dev 3"}
                                                value={environment.name}
                                                disabled={disabled}
                                                onChange={(event) =>
                                                    setEnvironment(index, { name: event.target.value })
                                                }
                                            />
                                        </Field>
                                        <Field
                                            label="Anchor tab"
                                            hint="Its subdomain defines this environment."
                                        >
                                            <select
                                                className={cn("mt-1.5 block", inputBaseClass)}
                                                value={environment.anchorTargetId}
                                                disabled={disabled}
                                                onChange={(event) =>
                                                    setEnvironment(index, {
                                                        anchorTargetId: event.target.value,
                                                    })
                                                }
                                            >
                                                <option value="">Select a tab…</option>
                                                {selectedTabs.map((tab) => (
                                                    <option key={tab.id} value={tab.id}>
                                                        {tab.displayUrl}
                                                    </option>
                                                ))}
                                            </select>
                                        </Field>
                                    </div>
                                </div>
                            );
                        })}
                    </div>

                    {!valid ? (
                        <Notice tone="warning">
                            Choose a name and an anchor tab for each environment, on two different
                            subdomains, to enable the comparison.
                        </Notice>
                    ) : null}

                    {preview ? (
                        <div className="space-y-3">
                            <div className="grid gap-3 sm:grid-cols-2">
                                {preview.environments.map((environment) => (
                                    <div
                                        key={environment.name}
                                        className="rounded-xl border border-ink-200/70 bg-white/80 p-3"
                                    >
                                        <p className="text-[13px] font-semibold text-ink-950">
                                            {environment.name}
                                        </p>
                                        <p className="truncate font-mono text-[11px] text-ink-500">
                                            {environment.host}
                                        </p>
                                        <ul className="mt-2 space-y-1">
                                            {environment.routes.map((route) => (
                                                <li
                                                    key={route}
                                                    className="truncate font-mono text-[11.5px] text-ink-600"
                                                >
                                                    {route}
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                ))}
                            </div>

                            {preview.warnings.length > 0 ? (
                                <Notice tone="warning">
                                    <ul className="space-y-1">
                                        {preview.warnings.map((warning, position) => (
                                            <li key={`${warning.reason}-${position}`}>
                                                <span className="font-mono">
                                                    {warning.detail ?? warning.displayUrl}
                                                </span>{" "}
                                                {warningLabels[warning.reason]}.
                                            </li>
                                        ))}
                                    </ul>
                                </Notice>
                            ) : null}
                        </div>
                    ) : null}
                </div>
            ) : null}
        </section>
    );
}
