import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join, normalize, sep } from "node:path";
import { LEDGER_MAX_BYTES, LEDGER_PATH, parseLedger, type LedgerRead } from "./work/fleet-ledger.ts";

/** Read ONLY `<repo>/docs/ai/state/fleet-incidents.json`, bounded and parse-safe. Read-only: nothing is ever written to the ledger or the tracker. */
export async function readFleetIncidents(repo: string): Promise<LedgerRead> {
  if (!isAbsolute(repo) || repo.includes("\0")) return { state: "invalid", reason: "Repo must be an absolute path without NUL bytes." };
  const root = normalize(repo), path = normalize(join(root, LEDGER_PATH));
  if (!path.startsWith(root.endsWith(sep) ? root : root + sep)) return { state: "invalid", reason: "Resolved path escapes the repo." };
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile()) return { state: "invalid", reason: "The run ledger is not a regular file (symlinks are refused)." };
    if (stat.size > LEDGER_MAX_BYTES) return { state: "invalid", reason: "The run ledger is larger than 512 KiB." };
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let text: string;
    try {
      const buffer = Buffer.alloc(LEDGER_MAX_BYTES + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > LEDGER_MAX_BYTES) return { state: "invalid", reason: "The run ledger is larger than 512 KiB." };
      text = buffer.subarray(0, bytesRead).toString("utf8");
    } finally { await file.close(); }
    try { return parseLedger(JSON.parse(text)); } catch { return { state: "invalid", reason: "The run ledger is not valid JSON." }; }
  } catch (e) {
    const code = e !== null && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "";
    if (code === "ENOENT" || code === "ENOTDIR") return { state: "missing" };
    return { state: "invalid", reason: `Could not read the run ledger (${code || "error"}).` };
  }
}
