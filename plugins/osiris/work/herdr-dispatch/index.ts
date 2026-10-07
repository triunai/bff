// Dispatch to Herdr: one reusable primitive. Import from here, never from the parts.
export { dispatchToHerdr, dispatchTeamToHerdr, bindHerdrDispatch, herdrDispatchBinding } from "./client.ts";
export type { DispatchBinding, DispatchOutcome, TeamOutcome } from "./client.ts";
export { HerdrDispatchDialog, herdrDispatchStyles } from "./dialog.tsx";
export { TEAM_LABEL } from "../team-dispatch/plan.ts";
export { DISPATCH_LABEL, HERDR_CLIS, isHerdrCli } from "./plan.ts";
export type { HerdrCli, HerdrDispatchRequest, HerdrDispatchResult } from "./plan.ts";
