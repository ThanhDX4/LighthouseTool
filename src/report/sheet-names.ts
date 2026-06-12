const invalidSheetNameChars = /[\\/?*[\]:]/g;

export function sanitizeSheetName(input: string): string {
  const stripped = input.replace(invalidSheetNameChars, "").replace(/^'+|'+$/g, "").trim();
  const fallback = stripped || "root";
  return fallback.slice(0, 31);
}

export function makeUniqueSheetName(input: string, used: Set<string>): string {
  const base = sanitizeSheetName(input);
  if (!used.has(base)) {
    used.add(base);
    return base;
  }

  for (let index = 2; index < 10_000; index += 1) {
    const suffix = `-${index}`;
    const candidate = `${base.slice(0, 31 - suffix.length)}${suffix}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }

  throw new Error(`Could not create unique sheet name for ${input}`);
}
