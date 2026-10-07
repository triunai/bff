// What picking a row in the sidebar's NEXT UP tab does (owner bug td-osi.1: it used to drag the canvas to Graph).
// PURE: no React, no DOM. A pick may change ONLY which item the inspector shows (`focus`); the canvas and the work view
// are passed through byte-for-byte. Only the Graph tab or the Graph nav item may open the Graph.
import type { SpineV2 } from "./projects.ts";
import type { NextUpItem } from "./sidebar-model.ts";
import type { ProjectSelection } from "./components/projects/board.tsx";

/** The item the inspector shows because of a Next up pick. `missing` = the spine no longer lists that work item. */
export type NextFocus =
  | { kind: "bead"; id: string }
  | { kind: "card"; selection: NonNullable<ProjectSelection> }
  | { kind: "missing"; project: string; workId: string }
  | null;

/** The slice of app state a pick may read. `canvas` and `workMode` are echoed back unchanged. */
export type NextUpView = { canvas: string; workMode: string; focus: NextFocus };

/** A decision pinned at the top of Next up (a bead): open its inspector, nothing else. */
export function pickNextUpBead(view: NextUpView, id: string): NextUpView {
  return { canvas: view.canvas, workMode: view.workMode, focus: { kind: "bead", id } };
}

/** A project work item from Next up: open its card detail from the loaded spines, nothing else. */
export function pickNextUpItem(view: NextUpView, item: Pick<NextUpItem, "projectId" | "workId">, spines: readonly SpineV2[] | null): NextUpView {
  const work = spines?.find(s => s.project.id === item.projectId)?.work.find(w => w.id === item.workId);
  const focus: NextFocus = work ? { kind: "card", selection: { kind: "card", project: item.projectId, work } } : { kind: "missing", project: item.projectId, workId: item.workId };
  return { canvas: view.canvas, workMode: view.workMode, focus };
}
