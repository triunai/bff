// Structural read-only guarantee for bd/bdi: a curated PATH whose `bd` is a POSIX sh shim that execs the REAL bd (absolute path)
// only for read subcommands, always with --readonly injected. `gh` is unreachable (PATH = shim dir + /usr/bin + /bin), so bdi's
// only other write path (gh:pr gate settling, which reads GitHub first) cannot start. Server-only.
import { chmod, mkdir, readFile, realpath, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveHerdrBin } from "../herdr-feed.ts";
import { CELLAR_BD, childEnv, resolveTrustedPath, type ChildEnvOpts, type TrustPolicy } from "./trusted-bin.ts";

// bd --readonly does NOT veto `sql` (a general executor; beady-eye src/collect/bd.rs says so), so `sql` is allowed ONLY for the one
// constant query bdi sends (beady-eye TABLE_HASHES), compared whole.
export const TABLE_HASHES = "SELECT table_name AS name, dolt_hashof_table(table_name) AS h FROM information_schema.tables WHERE table_schema = database() AND table_type = 'BASE TABLE' AND table_name <> 'leases' ORDER BY table_name";
/** `env` is the resulting child environment (for inspection); `opts` is what a spawn is given (the primitive builds the env itself). */
export type RoEnv = { binDir: string; env: NodeJS.ProcessEnv; opts: ChildEnvOpts };
export const READ_BD: readonly string[] = Object.freeze(["list", "show", "query", "blocked", "ready", "where", "whoami", "version", "--version", "sql (bdi table-hash query only)", "comments", "gate list", "events tail"]);

const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** The shim source. Globals (-C x, --actor x, --db x, --json, --readonly) are re-emitted, then --readonly, then the rest. */
export const shimSource = (realBd: string): string => `#!/bin/sh
# osiris read-only bd shim: refuses everything but read subcommands, never execs the real bd for a refused one.
REAL=${q(realBd)}
TABLE_HASHES=${q(TABLE_HASHES)}
refuse() { echo "osiris: refused bd write subcommand '$1'" >&2; exit 64; }
k=0; rem=$#
while [ "$rem" -gt 0 ]; do
  case "$1" in
    -C|--actor|--db) [ "$rem" -ge 2 ] || refuse "$1"; set -- "$@" "$1" "$2"; shift 2; k=$((k+2)); rem=$((rem-2)) ;;
    --json|--readonly) set -- "$@" "$1"; shift; k=$((k+1)); rem=$((rem-1)) ;;
    *) break ;;
  esac
done
# now: <rest...> <globals...> (globals are the LAST $k args); rest is $rem long
r=$rem
[ "$r" -ge 1 ] || refuse ""
sub=$1; sub2=""; [ "$r" -ge 2 ] && sub2=$2
i0=0
case "$sub" in
  list|show|query|blocked|ready|where|whoami|version|--version) ;;
  comments) for a in "$@"; do [ "$i0" -lt "$r" ] || break; [ "$a" = add ] && refuse "comments add"; i0=$((i0+1)); done ;;
  sql) case "$r" in
         2) q=$2 ;;
         3) if [ "$2" = --json ]; then q=$3; elif [ "$3" = --json ]; then q=$2; else refuse "sql (more than one argument)"; fi ;;
         *) refuse "sql (more than one argument)" ;;
       esac
       [ "$q" = "$TABLE_HASHES" ] || refuse "sql (only bdi's table-hash query is allowed)" ;;
  gate) [ "$sub2" = list ] || refuse "gate $sub2" ;;
  events) [ "$sub2" = tail ] || refuse "events $sub2" ;;
  *) refuse "$sub" ;;
esac
# <rest> <globals> -> append --readonly, then rotate the r rest args to the end: <globals> --readonly <rest>
set -- "$@" --readonly
i=0
while [ "$i" -lt "$r" ]; do set -- "$@" "$1"; shift; i=$((i+1)); done
exec "$REAL" "$@"
`;

async function link(target: string | null, at: string): Promise<void> {
  if (!target) return;
  try { await unlink(at); } catch { /* absent */ }
  await symlink(target, at);
}

/** What every bd/bdi child may see (ADR D-139): the minimal explicit base (PATH of fixed dirs, HOME, LANG) plus USER/LOGNAME/TMPDIR. No inherited GIT_*, BEADS_*, BD_*
 * (BEADS_DIR, BEADS_DB, BEADS_DOLT_*, BD_SOCKET, BD_OTEL_*, ... can redirect which tracker bd reads or where it reports), no GH_*, no loader variables, nothing else.
 * BD_DISABLE_METRICS=1 is forced (the owner's global bd config sends usage metrics out). */
export const BD_CHILD: ChildEnvOpts = Object.freeze({ inherit: ["USER", "LOGNAME", "TMPDIR"], env: Object.freeze({ BD_DISABLE_METRICS: "1" }) });
export const bdChildEnv = (from: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => childEnv({ ...BD_CHILD, from });
/** The programs the read-only env links (bd, git, herdr) and the bdi feed runs, each through the ONE resolver. A PATH-planted look-alike can never win (td-osi.36). */
/** bd may only be an alias into the beads Homebrew formula (CELLAR_BD) or a plain file in the fixed dirs. Every bd spawn passes this policy so the re-vet at spawn time agrees with the resolver. */
export const BD_TRUST: TrustPolicy = Object.freeze({ aliasTargets: CELLAR_BD });
export const resolveBd = (): string | null => resolveTrustedPath("bd", BD_TRUST);
export const resolveGit = (): string | null => resolveTrustedPath("git");
export const resolveBdi = (): string | null => resolveTrustedPath("bdi");

export async function ensureReadonlyEnv(opts: { dir?: string; realBd?: string; realGit?: string; realHerdr?: string } = {}): Promise<RoEnv> {
  const wanted = opts.dir ?? join(tmpdir(), `osiris-ro-${process.getuid?.() ?? 0}`);
  await mkdir(wanted, { recursive: true, mode: 0o700 });
  const root = await realpath(wanted), binDir = join(root, "bin"); // REAL path: the primitive refuses a program reached through a symlinked directory (macOS tmpdir() sits under /var -> /private/var)
  const realBd = opts.realBd ?? resolveBd();
  if (!realBd) throw new Error("bd is not installed");
  await mkdir(binDir, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700); await chmod(binDir, 0o700);
  const shim = join(binDir, "bd"), src = shimSource(realBd);
  let cur = ""; try { cur = await readFile(shim, "utf8"); } catch { /* new */ }
  if (cur !== src) { const tmp = `${shim}.${process.pid}.tmp`; await writeFile(tmp, src, { mode: 0o700 }); await chmod(tmp, 0o700); await rename(tmp, shim); }
  await link(opts.realGit ?? resolveGit(), join(binDir, "git"));
  await link(opts.realHerdr ?? resolveHerdrBin(), join(binDir, "herdr"));
  const childOpts: ChildEnvOpts = { ...BD_CHILD, env: { ...BD_CHILD.env, PATH: `${binDir}:/usr/bin:/bin` } };
  return { binDir, env: childEnv(childOpts), opts: childOpts };
}
