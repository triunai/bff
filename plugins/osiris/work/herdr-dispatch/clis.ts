import { z } from "zod";
import { HERDR_CLIS, type HerdrCli } from "./plan.ts";
import { availableClis, trustedCli } from "./run.ts";

// The RPC's declared OUTPUT. `paths` MUST be a partial record: zod 4's z.record(z.enum(...)) is EXHAUSTIVE (every enum key required), so with the
// registry's three providers a machine with only claude+codex failed output validation, and BB reported "rpc output validation failed".
export const herdrClisOutput = z.object({ clis: z.array(z.enum(HERDR_CLIS)), paths: z.partialRecord(z.enum(HERDR_CLIS), z.string()).optional() });

export const buildHerdrClis = (isPlugin: boolean, home?: string): z.infer<typeof herdrClisOutput> => {
  if (isPlugin) return { clis: [] };
  const clis = availableClis(home);
  return { clis, paths: Object.fromEntries(clis.map((k): [HerdrCli, string | null] => [k, trustedCli(k, home)]).filter((e): e is [HerdrCli, string] => !!e[1])) };
};
