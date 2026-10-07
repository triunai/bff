// Dispatch to Herdr: the server-side runner. ONE spawn site, trustedRun (argv array, no shell, the trusted-bin primitive), through the SAME trusted launch prefix as
// herdr-feed.ts herdrLaunchPlan (/usr/bin/env -u HERDR_* + the pinned herdr binary). It opens a NEW tab (one new pane) in the user's default session.
import { chmod, lstat, mkdir, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { ENV_BIN, herdrLaunchPlan } from "../../herdr-feed.ts";
import { HERDR_CHILD } from "../herdr-spawn.ts";
import { detectLaunchPath } from "../providers/detect.ts";
import { trustedRun } from "../trusted-bin.ts";
import { buildTeamPlan, type TeamCard, type TeamMember } from "../team-dispatch/plan.ts";
import { teamPrompts } from "../team-dispatch/prompts.ts";
import type { RunResult } from "../beads-adapter.ts";
import { cleanPrompt, cleanTitle, isHerdrCli, HERDR_CLIS, paneCommand, paneRunArgv, paneSplitArgv, rootPaneOf, safeAbsPath, splitPaneOf, tabCreateArgv, type HerdrCli, type HerdrDispatchRequest, type HerdrDispatchResult } from "./plan.ts";

export type SpawnArgv = (argv: string[], o: { cwd: string; timeoutMs: number }) => Promise<RunResult>;
export interface HerdrDispatchDeps {
  resolveCli(cli: HerdrCli): string | null;
  herdrBin(): string | null;
  envBin(): string | null;
  /** write the prompt to a private file; returns its absolute path */
  writePrompt(text: string): Promise<string>;
  removePrompt(path: string): Promise<void>;
  spawn: SpawnArgv;
  home: string;
}
const fail = (reason: string, fallback: boolean): HerdrDispatchResult => ({ ok: false, reason, fallback });

export async function runHerdrDispatch(req: Partial<HerdrDispatchRequest> & { repo?: string }, d: HerdrDispatchDeps): Promise<HerdrDispatchResult> {
  if (!isHerdrCli(req.cli)) return fail("that agent is not one Osiris can start (claude, codex or gemini)", false);
  const prompt = cleanPrompt(req.prompt); if (!prompt) return fail("there is no text to send", false);
  const title = cleanTitle(req.title);
  const bin = d.resolveCli(req.cli); if (!bin) return fail(`${req.cli} was not found as a trusted program on this machine`, true);
  const cwd = typeof req.repo === "string" && req.repo.startsWith("/") && !/[\0-\x1f]/.test(req.repo) ? req.repo : d.home;
  const plan = herdrLaunchPlan(d.herdrBin(), [cwd], d.home, null, d.envBin());
  if (!plan.ok) return fail(plan.reason, true);
  let file: string | null = null;
  try {
    file = await d.writePrompt(prompt);
    const cmd = paneCommand(req.cli, bin, file); if (!cmd) { await d.removePrompt(file); return fail("a program or file path had characters Osiris will not put in a command", true); }
    const tab = await d.spawn(tabCreateArgv(plan.argv, plan.cwd, title), { cwd: plan.cwd, timeoutMs: 15_000 });
    const pane = tab.code === 0 ? rootPaneOf(tab.stdout) : null;
    if (!pane) { await d.removePrompt(file); return fail(tab.code === 0 ? "herdr answered in a format Osiris does not understand" : `herdr could not open a pane: ${tab.stderr.trim().slice(0, 160) || `exit ${tab.code}`}`, true); }
    const run = await d.spawn(paneRunArgv(plan.argv, pane, cmd), { cwd: plan.cwd, timeoutMs: 15_000 });
    if (run.code !== 0) { await d.removePrompt(file); return fail(`the pane opened (${pane}) but the agent did not start: ${run.stderr.trim().slice(0, 160) || `exit ${run.code}`}`, true); }
    return { ok: true, paneId: pane };
  } catch (e) { if (file) await d.removePrompt(file).catch(() => undefined); return fail(`herdr could not be started: ${String((e as Error)?.message ?? e).slice(0, 120)}`, true); }
}

/** Team dispatch: a NEW tab in the default session, the lead in its root pane, each worker in a split. Same deps, same spawn, same file-based prompt.
 *  The request is STRUCTURE ONLY (cards, cli/model, count): the prompts are built and sealed HERE (team-dispatch/prompts.ts), never accepted from a caller. */
export type HerdrTeamRequest = { repo?: string; epic?: string | null; lead: TeamMember; worker: TeamMember; cards: Pick<TeamCard, "id" | "title">[]; workers?: number };
export type HerdrTeamResult = { ok: true; tab: string; panes: string[] } | { ok: false; reason: string; started: number; fallback: boolean };
export async function runHerdrTeam(req: Partial<HerdrTeamRequest>, d: HerdrDispatchDeps): Promise<HerdrTeamResult> {
  const bad = (reason: string, started = 0, fallback = false): HerdrTeamResult => ({ ok: false, reason, started, fallback });
  const built = buildTeamPlan({ cards: Array.isArray(req.cards) ? req.cards.map(c => ({ id: c?.id, title: typeof c?.title === "string" ? c.title : "" })) : [], lead: req.lead, worker: req.worker, workers: req.workers, epic: req.epic });
  if (!built.ok) return bad(built.reason);
  const texts = teamPrompts(built.plan);
  const panes: { cli: HerdrCli; model: string | null; prompt: string; bin: string }[] = [];
  for (const [i, p] of [built.plan.lead, ...built.plan.workers].entries()) {
    const prompt = cleanPrompt(texts[i]); if (!prompt) return bad("there is no text to send");
    const bin = d.resolveCli(p.cli); if (!bin) return bad(`${p.cli} was not found as a trusted program on this machine`, 0, true);
    panes.push({ cli: p.cli, model: p.model, prompt, bin });
  }
  const title = cleanTitle(built.plan.tab);
  const cwd = typeof req.repo === "string" && req.repo.startsWith("/") && !/[\0-\x1f]/.test(req.repo) ? req.repo : d.home;
  const plan = herdrLaunchPlan(d.herdrBin(), [cwd], d.home, null, d.envBin());
  if (!plan.ok) return bad(plan.reason, 0, true);
  const files: string[] = [], ids: string[] = [];
  const clean = async () => { for (const f of files) await d.removePrompt(f).catch(() => undefined); };
  try {
    const tab = await d.spawn(tabCreateArgv(plan.argv, plan.cwd, title), { cwd: plan.cwd, timeoutMs: 15_000 });
    const root = tab.code === 0 ? rootPaneOf(tab.stdout) : null;
    if (!root) return bad(tab.code === 0 ? "herdr answered in a format Osiris does not understand" : `herdr could not open a tab: ${tab.stderr.trim().slice(0, 160) || `exit ${tab.code}`}`, 0, true);
    for (let i = 0; i < panes.length; i++) {
      let pane = root;
      if (i > 0) { // worker 1 splits right of the lead; each later worker splits down from the previous worker
        const argv = paneSplitArgv(plan.argv, i === 1 ? root : ids[i - 1], i === 1 ? "right" : "down", plan.cwd);
        const s = argv ? await d.spawn(argv, { cwd: plan.cwd, timeoutMs: 15_000 }) : null;
        const next = s && s.code === 0 ? splitPaneOf(s.stdout) : null;
        if (!next) { await clean(); return bad(`pane ${i + 1} of ${panes.length} could not be opened${s && s.stderr.trim() ? `: ${s.stderr.trim().slice(0, 120)}` : ""}`, i, true); }
        pane = next;
      }
      ids.push(pane);
      const f = await d.writePrompt(panes[i].prompt); files.push(f);
      const cmd = paneCommand(panes[i].cli, panes[i].bin, f, panes[i].model);
      if (!cmd) { await clean(); return bad("a program or file path had characters Osiris will not put in a command", i, true); }
      const run = await d.spawn(paneRunArgv(plan.argv, pane, cmd), { cwd: plan.cwd, timeoutMs: 15_000 });
      if (run.code !== 0) { await clean(); return bad(`pane ${i + 1} opened but its agent did not start: ${run.stderr.trim().slice(0, 120) || `exit ${run.code}`}`, i, true); }
      files.pop(); // the pane's own command removes the file after reading it
    }
    return { ok: true, tab: title, panes: ids };
  } catch (e) { await clean(); return bad(`herdr could not be started: ${String((e as Error)?.message ?? e).slice(0, 120)}`, ids.length, true); }
}

// ---- real dependencies ----
/** An agent CLI as an absolute path from the fixed trusted directories (providers/detect.ts: the same primitive as herdr and caffeinate). `path` is gone: PATH is never consulted. */
export function trustedCli(cli: HerdrCli, home = homedir()): string | null {
  const p = detectLaunchPath(cli, home);
  return p && safeAbsPath(p) ? p : null;
}
export const availableClis = (home = homedir()): HerdrCli[] => HERDR_CLIS.filter(c => trustedCli(c, home) !== null);
/** Create the private prompt directory, or verify/repair a pre-existing one: it must be a real directory (not a symlink) owned by us, and is forced to 0700. Anything else is refused. */
export async function ensurePrivateDir(dir: string, uid: number | undefined = process.getuid?.()): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const st = await lstat(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("the Osiris dispatch folder is not a plain directory");
  if (uid !== undefined && st.uid !== uid) throw new Error("the Osiris dispatch folder belongs to another user");
  if ((st.mode & 0o777) !== 0o700) await chmod(dir, 0o700);
}
export function defaultHerdrDispatchDeps(o: { herdrBin: () => string | null; envBin: () => string | null }): HerdrDispatchDeps {
  const dir = join(tmpdir(), `osiris-dispatch-${process.getuid?.() ?? 0}`);
  return {
    resolveCli: c => trustedCli(c), herdrBin: o.herdrBin, envBin: o.envBin, home: homedir(),
    writePrompt: async text => { await ensurePrivateDir(dir); const f = join(dir, `${randomBytes(12).toString("hex")}.md`); await writeFile(f, text, { mode: 0o600, flag: "wx" }); return f; },
    removePrompt: async f => { try { await unlink(f); } catch { /* already gone */ } },
    // argv[0] is the trusted /usr/bin/env (root-owned, vetted again here by the primitive); the rest is the launch prefix herdrLaunchPlan built from the validated herdr path.
    spawn: (argv, o) => trustedRun(argv[0], argv.slice(1), { ...HERDR_CHILD, cwd: o.cwd, timeoutMs: o.timeoutMs, maxBuffer: 1024 * 1024, trust: { dirs: [dirname(ENV_BIN)], rootOnly: true }, label: "herdr" }),
  };
}
