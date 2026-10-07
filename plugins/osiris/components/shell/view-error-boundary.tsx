import { Component, type ReactNode } from "react";
import { CopyErrorButton } from "../ui/copy-error-button.tsx";
import { viewErrorCard } from "../../work/view-error.ts";

/** A calm, per-view error boundary: a crash in Terminal, Calls or Work shows this small card (Copy details + Retry) in THAT view only. */
export class ViewErrorBoundary extends Component<{ title: string; children?: ReactNode }, { error: unknown; failed: boolean }> {
  state = { error: null as unknown, failed: false };
  static getDerivedStateFromError(error: unknown) { return { error, failed: true }; }
  componentDidCatch(error: unknown) { console.error(`[osiris] view "${this.props.title}" crashed:`, viewErrorCard(this.props.title, error).why); }
  render() {
    if (!this.state.failed) return this.props.children;
    const c = viewErrorCard(this.props.title, this.state.error);
    return <div className="oi-view-err" role="alert">
      <strong>{c.what}</strong>
      <div className="oi-view-err-why">{c.why}</div>
      <div className="oi-view-err-fix">{c.fix}</div>
      <div className="oi-view-err-actions">
        <button type="button" className="oi-term-btn" onClick={() => this.setState({ error: null, failed: false })}>Retry</button>
        <CopyErrorButton what={c.what} seam={this.props.title} why={c.why} fix={c.fix} className="oi-term-btn" />
      </div>
    </div>;
  }
}

export const viewErrorStyles = `
.oi-view-err{user-select:text;-webkit-user-select:text;box-sizing:border-box;margin:12px;padding:10px 14px;max-width:520px;background:var(--oi-panel);border-left:3px solid var(--oi-tone-attention);border-bottom:1px solid var(--oi-border);font-size:12px;color:var(--oi-text);overflow-wrap:anywhere}
.oi-view-err-why,.oi-view-err-fix{margin-top:3px;color:var(--oi-muted)}.oi-view-err-actions{display:flex;gap:6px;margin-top:8px}
`;
