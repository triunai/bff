import { useState } from "react";
import { HerdrDispatchDialog, herdrDispatchStyles } from "../herdr-dispatch/index.ts";
import type { AskContext } from "./context.ts";
import type { DispatchGuard } from "../dispatch-guard.ts";

export const ASK_LABEL = "Ask an agent";

/** The one shared "Ask an agent" button. Opens the existing HerdrDispatchDialog pre-filled with the built context; nothing runs until the person confirms there.
 *  `ask` is built lazily so a closed inspector pays nothing; null (item gone) renders no button. */
export function AskAgentButton(p: { ask: () => AskContext | null; /** Evaluated on click: a locked / owner-gated / blocked / critical item opens the dialog with its warning. */ guard?: () => DispatchGuard | null; className?: string; label?: string }) {
  const [ctx, setCtx] = useState<AskContext | null>(null), [guard, setGuard] = useState<DispatchGuard | null>(null);
  return <>
    <button type="button" className={`oi-ask${p.className ? ` ${p.className}` : ""}`} title="Send this item and its neighbours to an agent to summarise (read-only)" onClick={() => { setGuard(p.guard?.() ?? null); setCtx(p.ask()); }}>{p.label ?? ASK_LABEL}</button>
    {ctx && <HerdrDispatchDialog title={ctx.title} prompt={ctx.prompt} guard={guard} onClose={() => setCtx(null)} />}
  </>;
}

export const askAgentStyles = `${herdrDispatchStyles}
.oi-ask{flex:none;padding:1px 8px;font:inherit;font-size:11px;color:var(--oi-tone-info);background:transparent;border:1px solid var(--oi-border);border-radius:4px;cursor:pointer}
.oi-ask:hover{background:var(--oi-hover)}.oi-ask:focus-visible{outline:1px solid var(--oi-tone-info);outline-offset:-1px}
`;
