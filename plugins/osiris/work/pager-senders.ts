// Pager senders + outbox (build8 lane F). OUTBOUND ONLY: this file has no poller, no listener and nothing that reads a reply.
// Third-party: sendRaw is ported from agent-pager (hooks/register.tsx sendRaw, MIT, (c) 2026 RadTech, radtech.nl), cloned at
// commit 79701a8bcd9812fe1f05aa3154dd2db0eebcc68a. Only the SENDER was taken; the inbound phone-to-prompt poller was deliberately
// NOT ported (on a machine that skips the dangerous-mode prompt it is a remote prompt path). Changes from the original: the mod's
// `$.http.fetch` became an injected `fetch`, the credentials come from BB settings (`secret: true`), URLs and ids are validated,
// redirects are refused, and a request has a timeout.
// FREE channels only: ntfy (self-hosted URL, or ntfy.sh with a random topic) and a Telegram bot. Both adapters exist but are
// unconfigured by default; with no channel the pager writes the local outbox only.
import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; redirect: "error"; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

export interface PagerMessage { title: string; text: string; urgent?: boolean }
export type SendResult = { ok: true } | { ok: false; error: string };
/** The pluggable sender. `send` never throws: a failure is a SendResult, so one bad channel cannot stop the tick. */
export interface PagerSender { id: "ntfy" | "telegram"; send(msg: PagerMessage): Promise<SendResult> }

export const NTFY_PUBLIC_HOST = "ntfy.sh";
export const TELEGRAM_API = "https://api.telegram.org";
export const OUT_TAG = "osiris-pager";
const TIMEOUT_MS = 8_000;

export interface NtfyConfig { server: string; topic: string; auth?: string }
export interface TelegramConfig { botKey: string; chatId: string }

/** A random, unguessable ntfy topic (128 bits). Public ntfy topics are readable by anyone who knows the name, so the name IS the password. */
export const generateTopic = (): string => `osiris-${randomBytes(16).toString("hex")}`;

const PRIVATE_HTTP = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[^.]+\.local)$/i;
/** https always; plain http only to this machine or a private network (a self-hosted box). Returns null when the URL is unusable. */
export function parseServer(raw: string): URL | null {
  let u: URL; try { u = new URL(raw.trim()); } catch { return null; }
  if (u.username || u.password) return null; // credentials belong in the secret setting, not the URL
  if (u.protocol === "https:") return u;
  if (u.protocol === "http:" && PRIVATE_HTTP.test(u.hostname)) return u;
  return null;
}
/** Warnings to show next to the settings; never blocks. */
export function ntfyWarnings(c: NtfyConfig): string[] {
  const w: string[] = [], u = parseServer(c.server);
  if (u && u.hostname === NTFY_PUBLIC_HOST) {
    w.push("ntfy.sh topics are PUBLIC: anyone who knows or guesses the topic name can read every page. Use a random topic (generateTopic) or self-host.");
    if (c.topic.length < 24) w.push("This topic is short and guessable. Use a long random one.");
  }
  if (!c.auth && u && u.hostname !== NTFY_PUBLIC_HOST && u.protocol === "https:") w.push("No ntfy access key set: a self-hosted server without auth is open to anyone who finds it.");
  return w;
}

const BOT_RE = /^\d{5,}:[A-Za-z0-9_-]{30,}$/, CHAT_RE = /^(-?\d{3,20}|@[A-Za-z0-9_]{4,32})$/, TOPIC_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** ntfy JSON publish (agent-pager sendRaw, ntfy branch). Page text is already scrubbed by the caller. */
export function ntfySender(cfg: NtfyConfig, fetchFn: FetchLike): PagerSender | null {
  const u = parseServer(cfg.server);
  if (!u || !TOPIC_RE.test(cfg.topic)) return null;
  return { id: "ntfy", async send(m) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (cfg.auth) headers.authorization = `Bearer ${cfg.auth}`;
    try {
      const r = await fetchFn(u.toString(), { method: "POST", headers, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS),
        body: JSON.stringify({ topic: cfg.topic, title: m.title, message: m.text || m.title, tags: [OUT_TAG], priority: m.urgent ? 4 : 3 }) });
      return r.ok ? { ok: true } : { ok: false, error: `ntfy answered ${r.status}` };
    } catch (e) { return { ok: false, error: `ntfy unreachable (${(e as Error)?.name ?? "error"})` }; } // never echo e.message: it can carry the URL
  } };
}
/** Telegram Bot API sendMessage (agent-pager sendRaw, telegram branch). The bot key is in the URL path by API design; it is never logged or returned. */
export function telegramSender(cfg: TelegramConfig, fetchFn: FetchLike): PagerSender | null {
  if (!BOT_RE.test(cfg.botKey) || !CHAT_RE.test(cfg.chatId)) return null;
  return { id: "telegram", async send(m) {
    try {
      const r = await fetchFn(`${TELEGRAM_API}/bot${cfg.botKey}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS),
        body: JSON.stringify({ chat_id: cfg.chatId, text: m.text ? `${m.title}\n${m.text}` : m.title, disable_web_page_preview: true }) });
      return r.ok ? { ok: true } : { ok: false, error: `telegram answered ${r.status}` };
    } catch (e) { return { ok: false, error: `telegram unreachable (${(e as Error)?.name ?? "error"})` }; }
  } };
}

/** Last line of defence before text leaves the machine: drop anything path-like or key-like and cap the length. The page builder
 *  already emits only trigger + counts + short lane names; this makes a future edit unable to leak by accident. */
export function scrubPageText(s: string): string {
  return s.replace(/(?:\/[\w.@~-]+){2,}/g, "[path]").replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]").slice(0, 400);
}

// ---- local outbox: every page (sent or not) and every suppressed trigger, newest last, bounded -------------------------------
export interface OutboxEntry { at: number; kind: "page" | "suppressed"; triggers: string[]; title?: string; text?: string; reason?: string; channel: string; status: "local-only" | "sent" | "failed"; error?: string }
export const OUTBOX_KEEP = 200;
export function appendOutbox(path: string, e: OutboxEntry): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fresh = !existsSync(path);
  appendFileSync(path, JSON.stringify(e) + "\n", { mode: 0o600 });
  if (fresh) { try { chmodSync(path, 0o600); } catch { /* best effort */ } }
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  if (lines.length > OUTBOX_KEEP * 2) writeFileSync(path, lines.slice(-OUTBOX_KEEP).join("\n") + "\n", { mode: 0o600 });
}
/** Newest-last tail the UI can show. A missing or corrupt file is an empty list, never a throw. */
export function readOutbox(path: string, limit = 50): OutboxEntry[] {
  try { return readFileSync(path, "utf8").split("\n").filter(Boolean).slice(-limit).flatMap(l => { try { return [JSON.parse(l) as OutboxEntry]; } catch { return []; } }); } catch { return []; }
}
