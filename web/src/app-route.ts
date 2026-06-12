export type AppRoute =
    | { view: "audit" }
    | { view: "manual" }
    | { view: "history" }
    | { view: "detail"; jobId: string };

export function readAppRoute(pathname: string): AppRoute {
    if (pathname === "/manual") return { view: "manual" };
    if (pathname === "/jobs") return { view: "history" };
    const match = pathname.match(/^\/jobs\/([^/]+)\/?$/);
    if (match?.[1]) {
        try {
            const jobId = decodeURIComponent(match[1]);
            if (/^[a-zA-Z0-9._-]+$/.test(jobId)) {
                return { view: "detail", jobId };
            }
        } catch {
            return { view: "audit" };
        }
    }
    return { view: "audit" };
}
