import { cn } from "./ui.js";

export function Toggle({
    label,
    description,
    checked,
    disabled,
    onChange,
}: {
    label: string;
    description?: string;
    checked: boolean;
    disabled?: boolean;
    onChange: () => void;
}) {
    return (
        <label
            className={cn(
                "group/toggle flex w-full items-start gap-3 rounded-xl border border-transparent px-2 py-1.5 transition duration-150",
                disabled
                    ? "cursor-not-allowed opacity-60"
                    : "cursor-pointer hover:border-ink-200 hover:bg-white",
            )}
        >
            <span className="relative mt-0.5 inline-flex size-[18px] shrink-0 items-center justify-center">
                <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled}
                    onChange={onChange}
                    className="peer absolute inset-0 size-full cursor-pointer appearance-none rounded-md border border-ink-300 bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.6)] outline-none transition duration-150 checked:border-accent-600 checked:bg-accent-600 focus-visible:ring-4 focus-visible:ring-accent-500/25 disabled:cursor-not-allowed"
                />
                <svg
                    aria-hidden
                    viewBox="0 0 14 14"
                    className="pointer-events-none relative size-[10px] scale-0 text-white transition duration-150 peer-checked:scale-100"
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
            <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] font-medium leading-5 tracking-tight text-ink-800 group-hover/toggle:text-ink-950">
                    {label}
                </span>
                {description ? (
                    <span className="mt-0.5 block text-[12px] leading-5 text-ink-500">
                        {description}
                    </span>
                ) : null}
            </span>
        </label>
    );
}

export function RadioRow({
    name,
    label,
    description,
    checked,
    disabled,
    onChange,
}: {
    name: string;
    label: string;
    description?: string;
    checked: boolean;
    disabled?: boolean;
    onChange: () => void;
}) {
    return (
        <label
            className={cn(
                "flex w-full items-start gap-3 rounded-xl border px-3 py-2.5 transition duration-150",
                disabled
                    ? "cursor-not-allowed border-ink-200 opacity-60"
                    : "cursor-pointer",
                checked
                    ? "border-accent-300/80 bg-accent-50/60 ring-1 ring-accent-300/50"
                    : "border-ink-200 bg-white hover:border-ink-300 hover:bg-ink-50",
            )}
        >
            <span className="relative mt-0.5 inline-flex size-[18px] shrink-0 items-center justify-center">
                <input
                    type="radio"
                    name={name}
                    checked={checked}
                    disabled={disabled}
                    onChange={onChange}
                    className="peer absolute inset-0 size-full cursor-pointer appearance-none rounded-full border border-ink-300 bg-white outline-none transition duration-150 checked:border-accent-600 focus-visible:ring-4 focus-visible:ring-accent-500/25 disabled:cursor-not-allowed"
                />
                <span className="pointer-events-none relative size-2 scale-0 rounded-full bg-accent-600 transition duration-150 peer-checked:scale-100" />
            </span>
            <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] font-medium leading-5 tracking-tight text-ink-800">
                    {label}
                </span>
                {description ? (
                    <span className="mt-0.5 block text-[12px] leading-5 text-ink-500">
                        {description}
                    </span>
                ) : null}
            </span>
        </label>
    );
}

export function PlainCheckbox({
    label,
    description,
    checked,
    disabled,
    onChange,
}: {
    label: string;
    description?: string;
    checked: boolean;
    disabled?: boolean;
    onChange: () => void;
}) {
    return (
        <label
            className={cn(
                "flex w-full items-start gap-3 rounded-xl border px-3 py-2.5 transition duration-150",
                disabled
                    ? "cursor-not-allowed border-ink-200 opacity-60"
                    : "cursor-pointer",
                checked
                    ? "border-ink-300 bg-ink-100/60"
                    : "border-ink-200 bg-white hover:border-ink-300 hover:bg-ink-50",
            )}
        >
            <span className="relative mt-0.5 inline-flex size-[18px] shrink-0 items-center justify-center">
                <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled}
                    onChange={onChange}
                    className="peer absolute inset-0 size-full cursor-pointer appearance-none rounded-md border border-ink-300 bg-white outline-none transition duration-150 checked:border-accent-600 checked:bg-accent-600 focus-visible:ring-4 focus-visible:ring-accent-500/25 disabled:cursor-not-allowed"
                />
                <svg
                    aria-hidden
                    viewBox="0 0 14 14"
                    className="pointer-events-none relative size-[10px] scale-0 text-white transition duration-150 peer-checked:scale-100"
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
            <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] font-medium leading-5 tracking-tight text-ink-800">
                    {label}
                </span>
                {description ? (
                    <span className="mt-0.5 block text-[12px] leading-5 text-ink-500">
                        {description}
                    </span>
                ) : null}
            </span>
        </label>
    );
}

export function toggle<T extends string>(
    item: T,
    values: T[],
    setValues: (next: T[]) => void,
) {
    setValues(
        values.includes(item)
            ? values.filter((value) => value !== item)
            : [...values, item],
    );
}
