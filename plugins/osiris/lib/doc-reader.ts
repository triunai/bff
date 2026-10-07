// PURE reader for spine markdown (decisions, journal entries, threads) and commit bodies. No DOM, no IO, no HTML: it returns a
// node tree that components/doc-view.tsx renders as React elements, so markup in the source can only ever appear as text.
//
// Why: the sources are HARD-WRAPPED at ~120 columns, so printing them raw breaks lines mid-sentence, shows `**Decision.**` with
// literal asterisks and runs "(1) … (2) …" clauses together. This reflows paragraphs and parses a small, safe subset:
// headings, **bold**, `code`, lists, "(n)" clauses, labelled sections ("**Why.**"), ids as chips, https links, code fences.
// Anything else (raw HTML, images, tables, italics) stays literal text.

/** Ids that become chips: decisions D-NNN, threads W-NNN, beads td-xxx(.n), and commit shas (only inside `code`). */
export type RefKind = "decision" | "thread" | "bead" | "sha";
export type Inline =
  | { t: "text"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "code"; v: string }
  | { t: "ref"; kind: RefKind; id: string }
  | { t: "link"; href: string; c: Inline[] };
export type Clause = { n: number; c: Inline[] };
export type Block =
  | { t: "heading"; level: number; c: Inline[] }
  | { t: "para"; c: Inline[] }
  | { t: "clauses"; lead: Inline[]; items: Clause[] }
  | { t: "list"; ordered: boolean; items: Inline[][] }
  | { t: "chips"; items: Inline[][] }
  | { t: "code"; lang: string; v: string }
  | { t: "quote"; c: Inline[] }
  | { t: "rule" }
  | { t: "section"; label: string; blocks: Block[] };
export type DocMeta = { id: string | null; title: string; date: string | null; status: string | null };
export type ParsedDoc = { meta: DocMeta | null; blocks: Block[] };
export type Trailer = { key: string; value: string };

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;

/** Raw source → logical blocks of text, with hard-wrapped lines joined. Headings, fences, list items, quotes and rules keep
 *  their own lines; a blank line ends a paragraph. A list item's wrapped continuation lines join that item. */
export type RawBlock = { kind: "para" | "heading" | "item" | "code" | "quote" | "rule"; text: string; level?: number; ordered?: boolean; lang?: string };
export function reflow(src: string): RawBlock[] {
  const out: RawBlock[] = [];
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  let para: string[] | null = null, item: RawBlock | null = null;
  const flush = () => {
    if (para) out.push({ kind: "para", text: para.join(" ") });
    if (item) out.push(item);
    para = null; item = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], trimmed = line.trim();
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && !new RegExp(`^\\s*${fence[1]}\\s*$`).test(lines[i]); i++) body.push(lines[i]);
      out.push({ kind: "code", text: body.join("\n"), lang: fence[2] });
      continue;
    }
    if (trimmed === "") { flush(); continue; }
    const h = HEADING.exec(line);
    if (h) { flush(); out.push({ kind: "heading", text: h[2], level: h[1].length }); continue; }
    if (RULE.test(line)) { flush(); out.push({ kind: "rule", text: "" }); continue; }
    if (/^\s*>/.test(line)) {
      const text = trimmed.replace(/^>\s?/, "");
      const prev = out[out.length - 1];
      if (!para && !item && prev?.kind === "quote") prev.text += ` ${text}`; else { flush(); out.push({ kind: "quote", text }); }
      continue;
    }
    const li = LIST_ITEM.exec(line);
    if (li) { flush(); item = { kind: "item", text: li[3].trim(), ordered: /\d/.test(li[2]) }; continue; }
    if (item) { item.text += ` ${trimmed}`; continue; } // a wrapped list item continues until a blank line or the next marker
    (para ??= []).push(trimmed);
  }
  flush();
  return out;
}

const ID_RE = /\b(D-\d+|W-\d+|td-[a-z0-9]+(?:\.\d+)*)\b/g;
const refKind = (id: string): RefKind => (id.startsWith("D-") ? "decision" : id.startsWith("W-") ? "thread" : "bead");
const SAFE_HREF = /^https?:\/\/[^\s<>"']+$/i;

/** Plain text → text and id chips. */
function textWithRefs(s: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of s.matchAll(ID_RE)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ t: "text", v: s.slice(last, at) });
    out.push({ t: "ref", kind: refKind(m[1]), id: m[1] });
    last = at + m[0].length;
  }
  if (last < s.length) out.push({ t: "text", v: s.slice(last) });
  return out;
}

/** "[label](target)" at `i`, with the target's parentheses balanced (so "javascript:alert(1)" is ONE target, not a cut). */
function linkAt(s: string, i: number): { label: string; href: string; end: number } | null {
  const m = /^\[([^\]]+)\]\(/.exec(s.slice(i));
  if (!m) return null;
  let depth = 1, j = i + m[0].length;
  for (; j < s.length && depth > 0; j++) { if (s[j] === "(") depth++; else if (s[j] === ")") depth--; else if (/\s/.test(s[j])) return null; }
  return depth === 0 ? { label: m[1], href: s.slice(i + m[0].length, j - 1), end: j } : null;
}

/** Inline markdown subset: `code` (an id or a 7-40 hex sha inside it becomes a chip), **strong**, [label](https://…) links.
 *  Unclosed markers stay literal. A link whose target is not http(s) renders as its label text, never as a link. */
export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  const push = (xs: Inline[]) => { if (buf) { out.push(...textWithRefs(buf)); buf = ""; } out.push(...xs); };
  for (let i = 0; i < s.length;) {
    if (s[i] === "`") {
      const end = s.indexOf("`", i + 1);
      if (end > i) {
        const v = s.slice(i + 1, end);
        push([/^[0-9a-f]{7,40}$/.test(v) ? { t: "ref", kind: "sha", id: v } : new RegExp(`^${ID_RE.source}$`).test(v) ? { t: "ref", kind: refKind(v), id: v } : { t: "code", v }]);
        i = end + 1; continue;
      }
    }
    if (s.startsWith("**", i)) {
      const end = s.indexOf("**", i + 2);
      if (end > i + 2) { push([{ t: "strong", c: parseInline(s.slice(i + 2, end)) }]); i = end + 2; continue; }
    }
    if (s[i] === "[") {
      const link = linkAt(s, i);
      if (link) { push(SAFE_HREF.test(link.href) ? [{ t: "link", href: link.href, c: parseInline(link.label) }] : parseInline(link.label)); i = link.end; continue; }
    }
    buf += s[i++];
  }
  if (buf) out.push(...textWithRefs(buf));
  return out;
}

/** Split "(1) … (2) … (3) …" clauses. Only a run that starts at (1) and counts up in order is a clause list; markers inside
 *  `code` are ignored; a lone "(2)" in prose is left alone. */
export function splitClauses(s: string): { lead: string; items: { n: number; text: string }[] } | null {
  const marks: { n: number; at: number; len: number }[] = [];
  let inCode = false, want = 1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "`") { inCode = !inCode; continue; }
    if (inCode || s[i] !== "(") continue;
    const m = /^\((\d{1,2})\)\s/.exec(s.slice(i));
    if (m && Number(m[1]) === want && (i === 0 || /[\s.;:,]/.test(s[i - 1]))) { marks.push({ n: want, at: i, len: m[0].length }); want++; }
  }
  if (marks.length < 2) return null;
  const items = marks.map((m, k) => ({ n: m.n, text: s.slice(m.at + m.len, k + 1 < marks.length ? marks[k + 1].at : s.length).trim() }));
  return { lead: s.slice(0, marks[0].at).trim(), items };
}

/** "**Decision.** text" → { label: "Decision", rest: "text" }. Labels are short and capitalised; ending "." or ":" inside the bold. */
export function labelOf(s: string): { label: string; rest: string } | null {
  const m = /^\*\*([A-Z][\w /&'-]{0,28}?)[.:]\*\*:?\s*(.*)$/.exec(s);
  return m ? { label: m[1], rest: m[2] } : null;
}

/** Heading of a spine entry → metadata. Handles "D-127 · title · 2026-10-07 · ACTIVE", "D-001 — title", "2026-10-05#9 — title". */
export function parseMeta(heading: string): DocMeta {
  const parts = heading.split(/\s+[·—]\s+|\s+-\s+/).map(p => p.trim()).filter(Boolean);
  let id: string | null = null, date: string | null = null, status: string | null = null;
  const rest: string[] = [];
  for (const p of parts) {
    const d = /^(\d{4}-\d{2}-\d{2})(#\d+)?$/.exec(p);
    if (!id && /^[A-Z]{1,4}-\d+$/.test(p)) id = p;
    else if (!date && d) { date = d[1]; if (d[2] && !id) id = p; }
    else if (!status && /^(ACTIVE|SUPERSEDED|PROPOSED|ACCEPTED|DEPRECATED|REJECTED|WITHDRAWN)\b/.test(p)) status = p;
    else rest.push(p);
  }
  return { id, title: rest.join(" · "), date, status };
}

/** One labelled section body. "Refs" becomes a chip list (items split on " · " or ";"); clause runs become numbered clauses. */
function sectionBody(label: string, text: string): Block[] {
  if (/^refs?$/i.test(label)) return [{ t: "chips", items: text.split(/\s+·\s+|;\s+/).map(x => x.trim()).filter(Boolean).map(parseInline) }];
  return [paraBlock(text)];
}
function paraBlock(text: string): Block {
  const cl = splitClauses(text);
  return cl ? { t: "clauses", lead: parseInline(cl.lead), items: cl.items.map(x => ({ n: x.n, c: parseInline(x.text) })) } : { t: "para", c: parseInline(text) };
}

/** Source (optionally with its heading passed separately) → metadata + block tree. The first heading, if it parses to an id or
 *  date, becomes the metadata header instead of a heading block. */
export function parseDoc(src: string, heading?: string): ParsedDoc {
  const raw = reflow(src);
  let meta: DocMeta | null = heading ? parseMeta(heading) : null;
  if (!meta && raw[0]?.kind === "heading") {
    const m = parseMeta(raw[0].text);
    if (m.id || m.date) { meta = m; raw.shift(); }
  } else if (meta && raw[0]?.kind === "heading" && raw[0].text.trim() === heading?.replace(/^#+\s*/, "").trim()) raw.shift();
  const blocks: Block[] = [];
  let section: Extract<Block, { t: "section" }> | null = null;
  const add = (b: Block) => (section ? section.blocks : blocks).push(b);
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    if (r.kind === "heading") { section = null; blocks.push({ t: "heading", level: r.level ?? 2, c: parseInline(r.text) }); continue; }
    if (r.kind === "rule") { section = null; blocks.push({ t: "rule" }); continue; }
    if (r.kind === "code") { add({ t: "code", lang: r.lang ?? "", v: r.text }); continue; }
    if (r.kind === "quote") { add({ t: "quote", c: parseInline(r.text) }); continue; }
    if (r.kind === "item") {
      const items: Inline[][] = [];
      const ordered = !!r.ordered;
      for (; i < raw.length && raw[i].kind === "item" && !!raw[i].ordered === ordered; i++) items.push(parseInline(raw[i].text));
      i--;
      add({ t: "list", ordered, items });
      continue;
    }
    const lab = labelOf(r.text);
    if (lab) { section = { t: "section", label: lab.label, blocks: lab.rest ? sectionBody(lab.label, lab.rest) : [] }; blocks.push(section); continue; }
    add(paraBlock(r.text));
  }
  return { meta, blocks };
}

/** Git trailers: the LAST paragraph, when every line in it is "Key: value" with a hyphenated-word key (Co-Authored-By, Refs,
 *  Wrap, Signed-off-by …). A "Key: value" line in the middle of a body is prose, not a trailer. */
export function splitTrailers(body: string): { body: string; trailers: Trailer[] } {
  const text = body.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  const cut = text.lastIndexOf("\n\n");
  const last = cut >= 0 ? text.slice(cut + 2) : text;
  const lines = last.split("\n").filter(l => l.trim() !== "");
  const TRAILER = /^([A-Za-z][A-Za-z0-9-]*):\s+(\S.*)$/;
  if (lines.length === 0 || !lines.every(l => TRAILER.test(l))) return { body: text, trailers: [] };
  const trailers = lines.map(l => { const m = TRAILER.exec(l)!; return { key: m[1], value: m[2] }; });
  return { body: cut >= 0 ? text.slice(0, cut) : "", trailers };
}

/** Plain text of an inline run (for titles, tooltips and tests). */
export function plainText(xs: readonly Inline[]): string {
  return xs.map(x => (x.t === "text" || x.t === "code" ? x.v : x.t === "ref" ? x.id : plainText(x.c))).join("");
}
