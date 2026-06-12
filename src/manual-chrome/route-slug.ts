/**
 * Slugify a URL pathname into a stable, filesystem- and sheet-name-safe segment.
 * Shared by manual single-tab routes and manual compare routes so both produce
 * identical labels for the same pathname.
 */
export function slugifyPathname(pathname: string): string {
  const slug = pathname
    .split("/")
    .filter(Boolean)
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "root";
}
