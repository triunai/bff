// What a view shows when it crashes (pure). One view failing must never take the others away: each centre view sits under its own boundary
// (components/shell/view-error-boundary.tsx) and this is the calm text it renders. Home-redacted and capped, never a stack.
export interface ViewErrorCard { what: string; why: string; fix: string }
export function viewErrorCard(title: string, error: unknown): ViewErrorCard {
  const why = String((error as Error)?.message ?? error ?? "unknown error").replace(/\/Users\/[^/\s]+/g, "~").replace(/\s+/g, " ").trim().slice(0, 160) || "unknown error";
  return { what: `${title} hit a problem`, why, fix: "Press Retry. Your other views are not affected. If it keeps happening, copy these details into a bug report." };
}
