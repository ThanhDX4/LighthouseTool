/**
 * Slugify a URL pathname into a stable, filesystem- and sheet-name-safe segment.
 * Shared by manual single-tab routes and manual compare routes so both produce
 * identical labels for the same pathname.
 */
export function slugifyPathname(pathname: string): string {
  const slug = String(pathname || "");
  // Remove any leading slash so callers can compose prefixes cleanly.
  // Trim leading and trailing slashes so '/a', '/a/' and 'a/' normalize the same.
  const cleaned = slug.replace(/^\/+|\/+$/g, "");
  return cleaned || "root";
}
