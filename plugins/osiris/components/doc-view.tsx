import type { ReactNode } from "react";
import type { DocView as SpineDocView } from "./spine-view.tsx";
import { shortSha } from "../git-ui.ts";
import { parseDoc, type Block, type DocMeta, type Inline, type RefKind } from "../lib/doc-reader.ts";

// Readable spine docs (decisions, journal entries, threads) and commit bodies. ONE renderer for all of them (W11 reuses DocBody).
// The source is parsed by lib/doc-reader.ts into a node tree and rendered as React elements: markup in the source is only ever text.
// Design: docs/design/ui-v2.md R10 (70ch measure, paragraphs, visible structure, metadata never inline in prose).

export type OnRef = (kind: RefKind, id: string) => void;

const REF_TITLE: Record<RefKind, string> = { decision: "Decision", thread: "Workstream thread", bead: "Bead", sha: "Commit" };

/** Inline run → elements. Ids are chips (buttons when `onRef` is given); links are http(s) only (the parser guarantees it). */
export function Inlines({ xs, onRef }: { xs: readonly Inline[]; onRef?: OnRef }): ReactNode {
  return xs.map((x, i) => {
    switch (x.t) {
      case "text": return x.v;
      case "strong": return <strong key={i}><Inlines xs={x.c} onRef={onRef} /></strong>;
      case "code": return <code key={i} className="oi-doc-code">{x.v}</code>;
      case "link": return <a key={i} className="oi-doc-link" href={x.href} target="_blank" rel="noopener noreferrer"><Inlines xs={x.c} onRef={onRef} /></a>;
      case "ref": {
        const cls = `oi-doc-ref oi-doc-ref-${x.kind}`, label = x.kind === "sha" ? x.id.slice(0, 7) : x.id;
        return onRef
          ? <button key={i} type="button" className={cls} title={`${REF_TITLE[x.kind]} ${x.id}`} onClick={() => onRef(x.kind, x.id)}>{label}</button>
          : <span key={i} className={cls} title={`${REF_TITLE[x.kind]} ${x.id}`}>{label}</span>;
      }
    }
  });
}

function BlockView({ b, onRef }: { b: Block; onRef?: OnRef }): ReactNode {
  switch (b.t) {
    case "heading": return <h4 className="oi-doc-h"><Inlines xs={b.c} onRef={onRef} /></h4>;
    case "para": return <p className="oi-doc-p"><Inlines xs={b.c} onRef={onRef} /></p>;
    case "quote": return <blockquote className="oi-doc-q"><Inlines xs={b.c} onRef={onRef} /></blockquote>;
    case "rule": return <hr className="oi-doc-rule" />;
    case "code": return <pre className="oi-doc-pre" tabIndex={0} aria-label={b.lang ? `${b.lang} code` : "code"}><code>{b.v}</code></pre>;
    case "list": {
      const items = b.items.map((it, i) => <li key={i}><Inlines xs={it} onRef={onRef} /></li>);
      return b.ordered ? <ol className="oi-doc-list">{items}</ol> : <ul className="oi-doc-list">{items}</ul>;
    }
    case "clauses": return <>
      {b.lead.length > 0 && <p className="oi-doc-p"><Inlines xs={b.lead} onRef={onRef} /></p>}
      <ol className="oi-doc-clauses">{b.items.map(c => <li key={c.n} value={c.n}><span className="oi-doc-n" aria-hidden="true">({c.n})</span><span><Inlines xs={c.c} onRef={onRef} /></span></li>)}</ol>
    </>;
    case "chips": return <ul className="oi-doc-chips">{b.items.map((it, i) => <li key={i} className="oi-doc-chip"><Inlines xs={it} onRef={onRef} /></li>)}</ul>;
    case "section": return <section className="oi-doc-sec" aria-label={b.label}>
      <h3 className="oi-doc-label">{b.label}</h3>
      {b.blocks.map((x, i) => <BlockView key={i} b={x} onRef={onRef} />)}
    </section>;
  }
}

/** The blocks only: what the commit inspector (W11) and thread/log views reuse. */
export function DocBody({ blocks, onRef }: { blocks: readonly Block[]; onRef?: OnRef }) {
  return <div className="oi-doc-body">{blocks.map((b, i) => <BlockView key={i} b={b} onRef={onRef} />)}</div>;
}

const statusTone = (s: string) => (/^ACTIVE|^ACCEPTED/.test(s) ? "success" : /^SUPERSEDED|^DEPRECATED|^WITHDRAWN|^REJECTED/.test(s) ? "muted" : "attention");

/** Metadata header: id chip, title, date, status badge (ACTIVE green tint; SUPERSEDED neutral; anything else attention). */
export function DocHeader({ meta, fallbackTitle, path, line }: { meta: DocMeta | null; fallbackTitle?: string; path?: string; line?: number }) {
  return <header className="oi-doc-head">
    <div className="oi-doc-meta">
      {meta?.id && <span className="oi-doc-id">{meta.id}</span>}
      {meta?.date && <span className="oi-doc-date">{meta.date}</span>}
      {meta?.status && <span className={`oi-doc-status oi-doc-st-${statusTone(meta.status)}`}>{meta.status}</span>}
    </div>
    <h2 className="oi-doc-title">{meta?.title || fallbackTitle || "Untitled"}</h2>
    {path && <p className="oi-doc-path" title={path}>{path}{line ? `:${line}` : ""}</p>}
  </header>;
}

/** A whole spine section: header + body. `heading` is DocSection.heading when the caller has it separately. */
export function DocView({ source, heading, path, line, onRef }: { source: string; heading?: string; path?: string; line?: number; onRef?: OnRef }) {
  const doc = parseDoc(source, heading);
  return <article className="oi-doc">
    <DocHeader meta={doc.meta} fallbackTitle={heading} path={path} line={line} />
    <DocBody blocks={doc.blocks} onRef={onRef} />
  </article>;
}

// Tokens only (ui-tokens.test.ts bans raw colours in .tsx). Chips follow R9: tint + ink, no outline, gap between chips.
/** The inspector body for a spine doc opened from a Calendar day (W11): the reflowed, structured reader instead of the old raw <pre>. The
 * ids inside the text are chips; the commits the section names stay a button list so each one still opens its commit. */
export function DocInspector({ doc, onBack, onOpenCommit }: { doc: SpineDocView; onBack?: () => void; onOpenCommit?: (sha: string) => void }) {
  const s = doc.section;
  return <div className="oi-sp-insp">
    <button type="button" className="oi-sp-crumb" onClick={onBack} disabled={!onBack}>← Back to {doc.event.date}</button>
    {doc.state === "loading" ? <p className="oi-sp-note">Loading…</p>
      : doc.state === "error" || !s ? <p className="oi-sp-note oi-sp-err" role="alert">{doc.error || "Could not read this section."}</p>
      : <>
        <DocView source={s.text} heading={s.heading || doc.event.title} path={s.path} line={s.line} />
        {s.truncated && <p className="oi-sp-note">Truncated: the section continues in the file.</p>}
        {s.shas.length > 0 && <section><h3 className="oi-sp-h">Commits named here<i>{s.shas.length}</i></h3>
          {s.shas.map(sha => <button key={sha} type="button" className="oi-sp-row oi-sp-mention" disabled={!onOpenCommit} onClick={() => onOpenCommit?.(sha)} title={sha}><small className="mono">{shortSha(sha)}</small></button>)}</section>}
      </>}
  </div>;
}

export const docViewStyles = `
.oi-doc{max-width:70ch;color:var(--oi-text);font:12.5px/1.55 var(--oi-font-ui,system-ui,sans-serif)}
.oi-doc-head{padding-bottom:10px;margin-bottom:10px;border-bottom:1px solid var(--oi-border-strong,var(--oi-border))}
.oi-doc-meta{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;font-size:11px;color:var(--oi-text-2,var(--oi-muted))}
.oi-doc-id{font:600 11px var(--oi-font-mono,ui-monospace,monospace);color:var(--oi-accent)}
.oi-doc-status{padding:0 7px;border-radius:9px;font:600 9px/17px var(--oi-font-ui,system-ui,sans-serif);letter-spacing:.06em;text-transform:uppercase}
.oi-doc-st-success{color:var(--oi-tone-success);background:color-mix(in srgb,var(--oi-tone-success) var(--oi-tint,16%),transparent)}
.oi-doc-st-attention{color:var(--oi-tone-attention);background:color-mix(in srgb,var(--oi-tone-attention) var(--oi-tint,16%),transparent)}
.oi-doc-st-muted{color:var(--oi-text-2,var(--oi-muted));background:color-mix(in srgb,var(--oi-tone-muted) var(--oi-tint,16%),transparent)}
.oi-doc-title{margin:4px 0 0;font:600 14px/1.35 var(--oi-font-ui,system-ui,sans-serif);overflow-wrap:anywhere}
.oi-doc-path{margin:3px 0 0;font:10.5px var(--oi-font-mono,ui-monospace,monospace);color:var(--oi-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.oi-doc-body>:first-child{margin-top:0}
.oi-doc-p{margin:0 0 .6em}
.oi-doc-sec{margin:0 0 14px}
.oi-doc-label{margin:0 0 4px;font:600 10px var(--oi-font-head,system-ui,sans-serif);letter-spacing:.08em;text-transform:uppercase;color:var(--oi-muted)}
.oi-doc-clauses{list-style:none;margin:0 0 .6em;padding:0}
.oi-doc-clauses li{display:grid;grid-template-columns:2.4em minmax(0,1fr);margin:0 0 .45em}
.oi-doc-n{color:var(--oi-accent);font-weight:600;font-variant-numeric:tabular-nums}
.oi-doc-list{margin:0 0 .6em;padding-left:1.4em}
.oi-doc-list li{margin:0 0 .25em}
.oi-doc-chips{display:flex;flex-wrap:wrap;gap:4px;list-style:none;margin:0;padding:0}
.oi-doc-chip{max-width:100%;padding:1px 7px;border-radius:9px;background:color-mix(in srgb,var(--oi-tone-muted) var(--oi-tint,16%),transparent);color:var(--oi-text-2,var(--oi-text));overflow-wrap:anywhere}
.oi-doc-chip .oi-doc-code{background:transparent;padding:0}
.oi-doc-code{font:11.5px var(--oi-font-mono,ui-monospace,monospace);padding:0 4px;border-radius:3px;background:var(--oi-input,var(--oi-hover))}
.oi-doc-pre{margin:0 0 .8em;padding:8px 10px;border-radius:4px;background:var(--oi-input,var(--oi-hover));overflow-x:auto;font:11.5px/1.5 var(--oi-font-mono,ui-monospace,monospace)}
.oi-doc-q{margin:0 0 .6em;padding-left:10px;box-shadow:inset 2px 0 0 var(--oi-border-strong,var(--oi-border));color:var(--oi-text-2,var(--oi-text))}
.oi-doc-h{margin:12px 0 4px;font-size:13px;font-weight:600}
.oi-doc-rule{border:0;border-top:1px solid var(--oi-border);margin:12px 0}
.oi-doc-link{color:var(--oi-accent);text-underline-offset:2px}
.oi-doc-ref{display:inline-block;margin:0 1px;padding:0 6px;border:0;border-radius:9px;font:11px/16px var(--oi-font-mono,ui-monospace,monospace);background:color-mix(in srgb,var(--oi-tone-info) var(--oi-tint,16%),transparent);color:var(--oi-tone-info)}
.oi-doc-ref-decision{background:color-mix(in srgb,var(--oi-accent) var(--oi-tint,16%),transparent);color:var(--oi-accent)}
.oi-doc-ref-sha{background:color-mix(in srgb,var(--oi-tone-muted) var(--oi-tint,16%),transparent);color:var(--oi-text-2,var(--oi-text))}
button.oi-doc-ref{cursor:pointer}button.oi-doc-ref:hover{text-decoration:underline}
button.oi-doc-ref:focus-visible{outline:2px solid var(--oi-focus,var(--oi-accent));outline-offset:1px}
`;
