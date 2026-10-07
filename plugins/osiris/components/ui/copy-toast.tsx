import { useEffect, useRef, useState } from "react";
import { onCopyToast } from "../../work/copy-toast.ts";

/** Mounted once in the app: shows the newest copy message for two seconds. */
export function CopyToastHost() {
  const [msg, setMsg] = useState<string | null>(null), timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { const off = onCopyToast(m => { setMsg(m); if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => setMsg(null), 2000); }); return () => { off(); if (timer.current) clearTimeout(timer.current); }; }, []);
  return <div className="oi-copy-toast" role="status" aria-live="polite">{msg}</div>;
}
export const copyToastStyles = `
.oi-copy-toast:empty{display:none}
.oi-copy-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:60;padding:5px 12px;font-size:12px;color:var(--oi-text);background:var(--oi-raised);box-shadow:0 1px 8px rgba(0,0,0,.35);user-select:text;-webkit-user-select:text}
`;
