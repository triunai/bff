// Runtime SEAM GUARDS (td-osi.12, owner 2026-10-07): every critical seam verifies its invariant at runtime and FAILS LOUDLY when it breaks.
// This file is the ONE definition of the guard contract. A parallel lane (fin/lane-hs) exports a `herdrSessionGuard` of exactly this shape.
// Guards report and offer a fix; they NEVER act, and they only read through the readers on GuardCtx. No node: imports, so the client can use it.

import type { HerdrGuardCtx } from "./herdr-session.ts";

export type GuardResult = { ok: true } | { ok: false; severity: "crit" | "warn"; what: string; why: string; fix: string };
export type SeamGuard = { id: string; seam: string; run: (ctx: GuardCtx) => Promise<GuardResult> };

/** One transcript root as read from disk. `required`: Osiris cannot show agent activity without it. */
export type TranscriptRootFact = { path: string; required: boolean; exists: boolean; readable: boolean; newestMtime: number | null };
export type KeepAwakeFact = { supported: boolean; enabled: boolean; active: boolean; live: number };
export type BuildFact = { dir: string; version: string };

/** What the owner is looking at (client facts, sent with each request). null = nothing selected / not known to the client. */
export type ViewFacts = {
  /** The Work board's selected tracker repo. */
  trackerRepo: string | null;
  /** The repo the bd snapshot on screen says it was read from (WorkSurfaceSnapshot.repo). */
  snapshotRepo: string | null;
  /** The repo the Commits / History views read. */
  gitRepo: string | null;
  /** The Herdr session the Terminal tab shows; null or "" = the user's default session. */
  terminalSession: string | null;
  /** The BB terminal id the Terminal tab is attached to (its launch stamp says which Herdr session it was started on). */
  terminalId?: string | null;
};

/** Only READ-ONLY readers the app already has. A reader that cannot answer throws (the registry turns a throw into a crit). */
export interface GuardCtx {
  now(): number;
  platform: string;
  view: ViewFacts;
  /** Is this repo on the allowlist (assertAllowedRepo)? */
  isRepoAllowed(path: string): Promise<boolean>;
  /** The plugin build that is running. null = cannot be identified. */
  runningBuild(): Promise<BuildFact | null>;
  /** The install dir BB reports for this plugin. Absent when no reader can ask BB (the server); then the build guard has nothing to compare. */
  installedBuild?(): Promise<BuildFact | null>;
  transcriptRoots(): Promise<TranscriptRootFact[]>;
  keepAwake(): Promise<KeepAwakeFact>;
  /** The Herdr runner + the picked and launched session of the attached terminal. Absent when no terminal reader exists (CLI): the herdr-session guard then has nothing to compare. */
  herdrSession?(): Promise<HerdrGuardCtx>;
  /** The Herdr session a dispatch opens its tab in ("default" = the user's own session). */
  dispatchSession(): Promise<string>;
  /** A sample outgoing payload run through the real sealing path: the raw ids it was built from, and its sealed JSON. */
  sealedSample(): Promise<{ raw: string[]; sealed: string }>;
}

/** The registry's answer: one entry per guard, in registry order. */
export type GuardEntry = { id: string; seam: string; result: GuardResult };
export type SeamReport = { at: number; entries: GuardEntry[] };
