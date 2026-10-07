import type { ReactNode } from "react";
import { AgentAction } from "../agent-action.tsx";
import type { EfficiencyAsk } from "../../work/ask-agent/context.ts";
import { cleanText } from "../../work/sanitize.ts";
import { efficiencyTileText, kbText, ratioText, tokText } from "../../work/token-efficiency-text.ts";
import type { EffAgent, TokenEfficiency } from "../../work/token-efficiency-model.ts";

/** Calls ▸ Cost: the "Token efficiency" tile (header card) and its subsection (D-140). Sizes and counts only (D-135); every row says why it costs and offers Ask an agent. */
const W = 96, H = 22;
function Spark({ series, label }: { series: number[]; label: string }) {
  if (series.length < 2) return <span className="oi-note">—</span>;
  const max = Math.max(...series, 1), pts = series.map((v, i) => `${((i / (series.length - 1)) * W).toFixed(1)},${(H - (v / max) * (H - 2) - 1).toFixed(1)}`).join(" ");
  return <svg width={W} height={H} role="img" aria-label={label} focusable="false"><polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>;
}
const Ask = (item: EfficiencyAsk) => <AgentAction kind="efficiency" item={item} />;
const Section = ({ title, note, children }: { title: string; note?: string; children: ReactNode }) => <><h4 className="oi-cc-h">{title}{note ? <small> · {note}</small> : null}</h4>{children}</>;
const agentAsk = (a: EffAgent): EfficiencyAsk => ({ topic: `agent ${a.lane} context ${tokText(a.ctxNow)}`, why: a.why, facts: [`context now ${tokText(a.ctxNow)}, biggest ${tokText(a.ctxMax)}, first ${tokText(a.ctxFirst)}`, `${a.calls} calls, +${tokText(Math.max(0, a.growthPerCall))} per call`, `cache write ${tokText(a.writeTokens)}, read ${tokText(a.readTokens)}`, `model ${a.model ?? "unknown"}`] });

export function TokenEfficiencyTile({ eff }: { eff: TokenEfficiency | undefined }) {
  const t = efficiencyTileText(eff);
  return <div className="oi-ov-card" title={t.hint}><span className="oi-ov-title">Token efficiency</span><span className={`oi-ov-num${t.bad ? " oi-cc-bad" : ""}`}>{t.value}</span><span className="oi-ov-sub" title={t.sub}>{t.sub}</span></div>;
}

export function TokenEfficiencySection({ eff }: { eff: TokenEfficiency | undefined }) {
  if (!eff) return <p className="oi-note">This build of the server sends no token-efficiency numbers; restart Osiris to see them.</p>;
  if (!eff.coverage.calls) return <p className="oi-note">No calls in this range yet, so there is nothing to measure.</p>;
  const th = eff.thresholds;
  return <section className="oi-te" aria-label="Token efficiency">
    <h3 className="oi-cc-h">Token efficiency<small> · sizes and counts only; nothing from transcripts</small></h3>
    <Section title="Agents near a wrap" note={`${tokText(th.near)} near, ${tokText(th.wrap)} hand off`}>
      {eff.nearWrap.length ? <div className="oi-tools-table"><table className="oi-cc-table"><thead><tr><th>Agent</th><th className="oi-cc-n">Context</th><th className="oi-cc-n">Growth</th><th>Why it costs</th><th /></tr></thead><tbody>
        {eff.nearWrap.slice(0, 8).map((a, i) => <tr key={`${a.lane}-${i}`}><td>{cleanText(a.lane)}{a.live ? " (live)" : ""}</td><td className={`oi-cc-n${a.wrap === "over" ? " oi-cc-bad" : ""}`}>{tokText(a.ctxNow)}</td><td className="oi-cc-n">+{tokText(Math.max(0, a.growthPerCall))}/call</td><td>{a.why}</td><td>{Ask(agentAsk(a))}</td></tr>)}</tbody></table></div> : <p className="oi-note">No agent is above {tokText(th.near)} of context.</p>}
    </Section>
    <Section title="Context growth per agent" note="input tokens per call, oldest to newest">
      <div className="oi-tools-table"><table className="oi-cc-table"><thead><tr><th>Agent</th><th>Growth</th><th className="oi-cc-n">Now</th><th className="oi-cc-n">Calls</th><th className="oi-cc-n">Write / read</th><th>Why it costs</th><th /></tr></thead><tbody>
        {eff.agents.map((a, i) => <tr key={`${a.lane}-${i}`}><td title={cleanText(a.model ?? "")}>{cleanText(a.lane)}</td><td><Spark series={a.series} label={`Context for ${cleanText(a.lane)}: ${tokText(a.ctxFirst)} to ${tokText(a.ctxNow)}`} /></td><td className="oi-cc-n">{tokText(a.ctxNow)}</td><td className="oi-cc-n">{a.calls}</td><td className="oi-cc-n">{ratioText(a.writeToRead)}</td><td>{a.why}</td><td>{Ask(agentAsk(a))}</td></tr>)}</tbody></table></div>
    </Section>
    <Section title="Cache writes vs reads, by model" note="writes cost at least 12 times a read">
      <div className="oi-tools-table"><table className="oi-cc-table"><thead><tr><th>Model</th><th className="oi-cc-n">Written</th><th className="oi-cc-n">Read</th><th className="oi-cc-n">Write / read</th><th>Why it costs</th><th /></tr></thead><tbody>
        {eff.modelCache.map(m => <tr key={m.model}><td>{cleanText(m.model)}</td><td className="oi-cc-n">{tokText(m.writeTokens)}</td><td className="oi-cc-n">{tokText(m.readTokens)}</td><td className="oi-cc-n">{ratioText(m.writeToRead)}</td><td>{m.why}</td><td>{Ask({ topic: `cache churn on ${m.model}`, why: m.why, facts: [`written ${tokText(m.writeTokens)}, read ${tokText(m.readTokens)}`, `write/read ${ratioText(m.writeToRead)}`] })}</td></tr>)}</tbody></table></div>
    </Section>
    <Section title="Opus, Sonnet and Haiku share">
      <div className="oi-tools-table"><table className="oi-cc-table"><thead><tr><th>Family</th><th className="oi-cc-n">Calls</th><th className="oi-cc-n">Spend share</th><th>Why it costs</th><th /></tr></thead><tbody>
        {eff.families.map(f => <tr key={f.family}><td>{f.family}</td><td className="oi-cc-n">{f.calls}{f.callShare !== null ? ` (${Math.round(f.callShare * 100)}%)` : ""}</td><td className="oi-cc-n">{f.costShare === null ? "—" : `${Math.round(f.costShare * 100)}%`}</td><td>{f.why}</td><td>{Ask({ topic: `${f.family} share of spend`, why: f.why, facts: [`${f.calls} calls`, `spend share ${f.costShare === null ? "unknown" : `${Math.round(f.costShare * 100)}%`}`] })}</td></tr>)}</tbody></table></div>
    </Section>
    <Section title="Largest tool outputs fed back into context" note={eff.coverage.toolResults ? `${eff.coverage.toolResults} tool results seen` : undefined}>
      {eff.bigOutputs.length ? <div className="oi-tools-table"><table className="oi-cc-table"><thead><tr><th>Tool</th><th>Agent</th><th className="oi-cc-n">Size</th><th className="oi-cc-n">Re-read cost</th><th>Why it costs</th><th /></tr></thead><tbody>
        {eff.bigOutputs.map((o, i) => <tr key={i}><td>{cleanText(o.tool)}</td><td>{cleanText(o.lane)}</td><td className="oi-cc-n">{kbText(o.bytes)}</td><td className="oi-cc-n">{o.carryUsd === null ? "—" : `$${o.carryUsd.toFixed(2)}`}</td><td>{o.why}</td><td>{Ask({ topic: `${o.tool} output of ${kbText(o.bytes)}`, why: o.why, facts: [`tool ${o.tool}`, `size ${kbText(o.bytes)} (about ${tokText(o.tokens)} tokens)`, `${o.laterCalls} later calls re-read it`, `agent ${o.lane}`] })}</td></tr>)}</tbody></table></div> : <p className="oi-note">No tool results read yet.</p>}
    </Section>
    <Section title="Repeated reads of the same file" note="file name only">
      {eff.repeatedReads.length ? <div className="oi-tools-table"><table className="oi-cc-table"><thead><tr><th>File</th><th>Agent</th><th className="oi-cc-n">Reads</th><th className="oi-cc-n">Total</th><th>Why it costs</th><th /></tr></thead><tbody>
        {eff.repeatedReads.map((r, i) => <tr key={i}><td>{cleanText(r.file)}</td><td>{cleanText(r.lane)}</td><td className="oi-cc-n">{r.reads}</td><td className="oi-cc-n">{kbText(r.totalBytes)}</td><td>{r.why}</td><td>{Ask({ topic: `${r.file} read ${r.reads} times`, why: r.why, facts: [`file ${r.file}`, `${r.reads} reads, ${kbText(r.totalBytes)} in total`, `agent ${r.lane}`] })}</td></tr>)}</tbody></table></div> : <p className="oi-note">No file was read twice by the same agent.</p>}
    </Section>
  </section>;
}
