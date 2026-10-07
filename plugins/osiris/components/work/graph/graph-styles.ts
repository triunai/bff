// Styles for the Work surface GRAPH tab (oi-wg-*). Tokens only (--oi-*): no raw colours. System UI font for titles (>= 12px),
// monospace only for ids. Stage colour is one custom property (--oi-wg-c) set by .oi-wg-s-<stage>, so legend dots, pills and
// card borders share it and the colour change can transition.
/** The ONE definition of a stage's colour. The canvas cards, its legend AND the sidebar mini graph dots all read `--oi-wg-c` from it (GRAPH-1). */
export const stageColorCss = `${[["waiting", "--oi-tone-attention"], ["ready", "--oi-tone-info"], ["building", "--oi-tone-running"], ["review", "--oi-lane-2"], ["done", "--oi-tone-success"]].map(([s, v]) => `.oi-wg-s-${s}{--oi-wg-c:var(${v})}`).join("\n")}`;
export const beadGraphStyles = `
.oi-wgt{display:flex;flex-direction:column;height:100%;min-height:0;min-width:0}
.oi-wgt-body{position:relative;flex:1;min-height:24rem;min-width:0}
.oi-wgt-wave-note{border-top:1px solid var(--oi-border);padding:8px 12px;font:12px/1.4 system-ui,-apple-system,sans-serif;color:var(--oi-text);background:var(--oi-panel)}
.oi-wgt-wave-note b{font-weight:600}
.oi-wgt-wave-note code{font:11px ui-monospace,monospace;margin-right:8px;color:var(--oi-muted)}
.oi-wgt-empty{position:absolute;left:0;right:0;top:50%;z-index:5;transform:translateY(-50%);text-align:center;padding:0 24px;pointer-events:none;font:13px/1.4 system-ui,-apple-system,sans-serif;color:var(--oi-muted)}
.oi-wg{position:absolute;inset:0;min-height:24rem;overflow:hidden;background:var(--oi-bg);color:var(--oi-text);font-family:system-ui,-apple-system,sans-serif}
.oi-wg .react-flow{--xy-background-color:transparent;--xy-node-background-color-default:transparent;--xy-node-border-default:none;--xy-edge-label-background-color-default:transparent;--xy-edge-label-color-default:var(--oi-text);--xy-controls-button-background-color-default:var(--oi-panel);background:transparent}
.oi-wg .react-flow__node{padding:0;border:0;background:transparent}
.oi-wg .react-flow__attribution{display:none}
.oi-wg-handle{opacity:0}
.oi-wg-legend{position:absolute;left:12px;top:12px;z-index:10;display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;padding:6px 10px;border:1px solid var(--oi-border);border-radius:8px;background:var(--oi-panel);font-size:12px;max-width:calc(100% - 24px)}
.oi-wg-legend-h{font-weight:600;color:var(--oi-muted)}
.oi-wg-legend-i{display:inline-flex;align-items:center;gap:6px}
.oi-wg-dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--oi-wg-c)}
.oi-wg-tools{position:absolute;right:12px;top:12px;z-index:10;display:flex;flex-wrap:wrap;justify-content:flex-end;align-items:center;gap:8px;max-width:calc(100% - 24px)}
.oi-wg-seg{display:inline-flex;gap:2px;padding:3px;border:1px solid var(--oi-border);border-radius:8px;background:var(--oi-panel)}
.oi-wg-btn{font:12px system-ui,-apple-system,sans-serif;border:0;border-radius:6px;padding:3px 9px;background:transparent;color:var(--oi-muted);cursor:pointer;white-space:nowrap}
.oi-wg-btn:hover{background:var(--oi-hover);color:var(--oi-text)}
.oi-wg-btn.on{background:var(--oi-selected);color:var(--oi-text)}
.oi-wg-fit,.oi-wg-tools>.oi-wg-btn{border:1px solid var(--oi-border);background:var(--oi-panel)}
.oi-wg-node{position:relative}
${stageColorCss}
.oi-wg-card{box-sizing:border-box;width:18.5rem;padding:10px 12px;border:1px solid color-mix(in srgb,var(--oi-wg-c) 45%,var(--oi-border));border-left:4px solid var(--oi-wg-c);border-radius:10px;text-align:left;background:color-mix(in srgb,var(--oi-wg-c) 9%,var(--oi-panel));color:var(--oi-text);transition:border-color .6s ease,background-color .6s ease,opacity .3s ease,box-shadow .3s ease}
.oi-wg-card:hover{box-shadow:0 2px 10px var(--oi-shadow)}
.oi-wg-epic{border-width:2px}
.oi-wg-ghost{opacity:.35;border-style:dashed}
.oi-wg-s-done.oi-wg-card{opacity:.75}
.oi-wg-dim{opacity:.3}
.oi-wg-cycle{outline:2px solid var(--oi-tone-failure);outline-offset:1px}
.oi-wg-actionable{box-shadow:0 0 0 1px color-mix(in srgb,var(--oi-tone-success) 45%,transparent)}
.oi-wg-selected{box-shadow:0 0 0 2px var(--oi-tone-info)}
.oi-wg-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding-bottom:6px;margin-bottom:6px;border-bottom:1px solid var(--oi-border)}
.oi-wg-head-r{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.oi-wg-id{font:11px ui-monospace,monospace;color:var(--oi-muted)}
.oi-wg-prio{font-size:12px;font-weight:600;color:var(--oi-muted)}
.oi-wg-pill{font-size:11px;font-weight:600;padding:1px 8px;border-radius:999px;color:var(--oi-text);background:color-mix(in srgb,var(--oi-wg-c) 28%,transparent);border:1px solid color-mix(in srgb,var(--oi-wg-c) 55%,transparent);transition:background-color .6s ease,border-color .6s ease}
.oi-wg-wave{font-size:11px;font-weight:600;padding:1px 8px;border-radius:999px;border:1px solid var(--oi-tone-info);color:var(--oi-text);background:var(--oi-selected)}
.oi-wg-chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}
.oi-wg-chip{font:11px ui-monospace,monospace;color:var(--oi-muted);padding:0 5px;border-radius:999px;background:color-mix(in srgb,var(--oi-muted) 14%,transparent);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.oi-wg.oi-wg-full{position:fixed;inset:0;z-index:2147483000;height:auto;min-height:0;background:var(--oi-panel)}
.oi-wg:focus{outline:none}
.oi-wg-title{margin:0;font-size:14px;font-weight:600;line-height:1.3;color:var(--oi-text);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.oi-wg-s-done .oi-wg-title{text-decoration:line-through;opacity:.8}
.oi-wg-wait{margin-top:8px;padding-top:6px;border-top:1px solid var(--oi-border)}
.oi-wg-wait-h{margin:0 0 2px;font-size:11px;font-weight:600;color:var(--oi-tone-failure)}
.oi-wg-wait-l{margin:0;font-size:12px;line-height:1.35;color:var(--oi-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.oi-wg-tip{position:absolute;left:50%;top:100%;z-index:50;margin-top:8px;transform:translateX(-50%);max-width:20rem;min-width:11rem;padding:8px 10px;border:1px solid var(--oi-border);border-radius:8px;background:var(--oi-panel);box-shadow:0 4px 14px var(--oi-shadow);pointer-events:none}
.oi-wg-tip ul{margin:4px 0 0;padding-left:16px;font-size:12px;color:var(--oi-muted)}
.oi-wg-tip-h{margin:0;font-size:12px;font-weight:600}
.oi-wg-tip-b{margin:2px 0 0;font-size:12px;color:var(--oi-muted)}
.oi-wg-tip-ok{color:var(--oi-tone-success)}
.oi-wg-tip-bad{color:var(--oi-tone-failure)}
.oi-wg .animated-edge{animation:oi-wg-dash 1s linear infinite}
@keyframes oi-wg-dash{to{stroke-dashoffset:-10}}
@keyframes oi-wg-glow-a{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--oi-wg-c) 75%,transparent)}100%{box-shadow:0 0 0 12px transparent}}
@keyframes oi-wg-glow-b{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--oi-wg-c) 75%,transparent)}100%{box-shadow:0 0 0 12px transparent}}
@keyframes oi-wg-rework-a{0%{transform:translateY(0);box-shadow:0 0 0 0 color-mix(in srgb,var(--oi-tone-attention) 80%,transparent)}25%{transform:translateY(-10px)}50%{transform:translateY(0)}70%{transform:translateY(-4px)}100%{transform:translateY(0);box-shadow:0 0 0 12px transparent}}
@keyframes oi-wg-rework-b{0%{transform:translateY(0);box-shadow:0 0 0 0 color-mix(in srgb,var(--oi-tone-attention) 80%,transparent)}25%{transform:translateY(-10px)}50%{transform:translateY(0)}70%{transform:translateY(-4px)}100%{transform:translateY(0);box-shadow:0 0 0 12px transparent}}
.oi-wg-pulse-0{animation:oi-wg-glow-a 1.2s ease-out}
.oi-wg-pulse-1{animation:oi-wg-glow-b 1.2s ease-out}
.oi-wg-rework-0{animation:oi-wg-rework-a 1.2s ease-out}
.oi-wg-rework-1{animation:oi-wg-rework-b 1.2s ease-out}
@media (prefers-reduced-motion:reduce){.oi-wg-card{transition:none}.oi-wg-pulse-0,.oi-wg-pulse-1,.oi-wg-rework-0,.oi-wg-rework-1,.oi-wg .animated-edge{animation:none}}
.oi-wgp{display:flex;flex-direction:column;gap:14px;font:13px/1.4 system-ui,-apple-system,sans-serif;color:var(--oi-text)}
.oi-wgp h3{margin:0 0 4px;font-size:13px;font-weight:600}
.oi-wgp-hint{margin:0 0 6px;font-size:12px;color:var(--oi-muted)}
.oi-wgp ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.oi-wgp-row{display:grid;grid-template-columns:auto 1fr;gap:2px 8px;width:100%;box-sizing:border-box;text-align:left;font:inherit;padding:6px 8px;border:1px solid var(--oi-border);border-radius:8px;background:transparent;color:var(--oi-text);cursor:pointer}
.oi-wgp-row:hover{background:var(--oi-hover)}
.oi-wgp-id{font:11px ui-monospace,monospace;color:var(--oi-muted);align-self:center}
.oi-wgp-t{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.oi-wgp-sub{grid-column:2;font-size:12px;color:var(--oi-muted)}
.oi-wgp-empty{margin:0;font-size:12px;color:var(--oi-muted)}
`;
