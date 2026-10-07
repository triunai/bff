// What a tool call fed back into an agent's context, as SIZES only (D-135/D-140): tool name, result byte count, time, and for a file
// read the BASENAME of the file. Never the result text, the command, the arguments or any path above the basename.
// Verified record shapes (same as transcript-feed turnFacts): an assistant record holds `tool_use` blocks { id, name, input };
// a user record closes them with `tool_result` blocks { tool_use_id, content: string | [{ type: "text", text }] }.
export interface ToolOutputEvent { tool: string; bytes: number; at: number | null; /** Basename of the file a Read opened, else null. */ file: string | null }
export interface PendingTool { tool: string; file: string | null }
export const MAX_TOOL_EVENTS = 400, MAX_PENDING = 200;
const TOOL_NAME = /^[A-Za-z0-9._:-]{1,64}$/;
const READ_TOOLS = new Set(["Read", "NotebookRead"]);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? v as Record<string, unknown> : {});

/** Basename only, capped. A path-looking value with no usable last segment gives null. */
export function baseName(p: unknown): string | null {
  if (typeof p !== "string") return null;
  const last = p.slice(0, 4096).split(/[\\/]/).filter(Boolean).pop() ?? "";
  return last ? last.slice(0, 64) : null;
}

function resultBytes(content: unknown): number {
  if (typeof content === "string") return Buffer.byteLength(content);
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const b of content) { const x = obj(b); if (typeof x.text === "string") n += Buffer.byteLength(x.text); }
  return n;
}

/** Lines -> new tool-output events. `pending` (tool_use id -> name/file) is copied, never mutated, so the poll stays pure. */
export function toolOutputFacts(pending: ReadonlyMap<string, PendingTool>, lines: readonly string[]): { events: ToolOutputEvent[]; pending: Map<string, PendingTool> } {
  const open = new Map(pending), events: ToolOutputEvent[] = [];
  for (const l of lines) {
    const use = l.includes('"tool_use"'), res = l.includes('"tool_result"');
    if (!use && !res) continue;
    let o: unknown;
    try { o = JSON.parse(l); } catch { continue; }
    const r = obj(o), msg = obj(r.message), blocks = Array.isArray(msg.content) ? msg.content as unknown[] : [];
    const at = typeof r.timestamp === "string" && Number.isFinite(Date.parse(r.timestamp)) ? Date.parse(r.timestamp) : null;
    for (const b of blocks) {
      const x = obj(b);
      if (r.type === "assistant" && x.type === "tool_use" && typeof x.id === "string") {
        const tool = typeof x.name === "string" && TOOL_NAME.test(x.name) ? x.name : "?";
        open.set(x.id, { tool, file: READ_TOOLS.has(tool) ? baseName(obj(x.input).file_path ?? obj(x.input).notebook_path) : null });
      } else if (r.type === "user" && x.type === "tool_result" && typeof x.tool_use_id === "string") {
        const p = open.get(x.tool_use_id);
        if (!p) continue;
        open.delete(x.tool_use_id);
        events.push({ tool: p.tool, bytes: resultBytes(x.content), at, file: p.file });
      }
    }
  }
  while (open.size > MAX_PENDING) open.delete(open.keys().next().value!);
  return { events, pending: open };
}
