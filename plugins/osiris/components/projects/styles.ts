// Projects tab styles: --oi-* tokens only (the fitness test rejects raw colours). Stripe meaning: green ready/healthy, yellow attention, red blocked, grey later, purple review.
export const projectsBoardStyles = `
.oi-pj-quiet,.oi-pj-btn.quiet{border-color:transparent;color:var(--oi-tone-muted)}.oi-pj-btn.quiet:hover:not(:disabled){color:var(--oi-text)}
.oi-pj-sum{color:var(--oi-text);font-size:13px;font-weight:600}.oi-pj-grow{flex:1;min-width:0}.oi-pj-help{position:relative}
.oi-pj-pop{position:absolute;z-index:5;top:100%;left:0;width:340px;max-width:80vw;background:var(--oi-panel);border:1px solid var(--oi-border);box-shadow:0 4px 16px var(--oi-shadow);padding:10px 12px;line-height:1.5;color:var(--oi-text)}
.oi-pj-pop ul{margin:4px 0 8px;padding-left:0;list-style:none}.oi-pj-pop li{margin:3px 0}.oi-pj-pop p{margin:2px 0 8px}
.oi-pj-pb{font-size:9px;padding:0 3px;border:1px solid var(--oi-border)}.oi-pj-pb.V{color:var(--oi-tone-success);border-color:var(--oi-tone-success)}.oi-pj-pb.I{color:var(--oi-tone-muted);border-style:dashed}
.oi-pj-chip{display:inline-block;padding:0 7px;border-radius:999px;border:1px solid currentColor;font-size:11px;font-weight:600;white-space:nowrap}
.t-green.oi-pj-chip,.oi-pj-chip.t-green{color:var(--oi-tone-success)}.oi-pj-chip.t-yellow{color:var(--oi-tone-attention)}.oi-pj-chip.t-red{color:var(--oi-tone-failure)}.oi-pj-chip.t-grey{color:var(--oi-tone-muted)}
.oi-pj-grpbox{margin-bottom:14px}.oi-pj-grp{margin:10px 0 6px;color:var(--oi-tone-muted);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.oi-pj-pc2{display:grid;grid-template-columns:150px minmax(0,1.6fr) minmax(0,1fr);gap:16px;padding:12px 14px;margin-bottom:0;border-bottom:1px solid var(--oi-border);border-left:4px solid var(--oi-tone-muted);cursor:pointer;line-height:1.5}
.oi-pj-pc2:hover{background:var(--oi-hover)}.oi-pj-pc2:focus-visible{outline:1px solid var(--oi-tone-info);outline-offset:-1px}
.oi-pj-pc2.t-green{border-left-color:var(--oi-tone-success)}.oi-pj-pc2.t-yellow{border-left-color:var(--oi-tone-attention)}.oi-pj-pc2.t-red{border-left-color:var(--oi-tone-failure)}.oi-pj-pc2.t-grey{border-left-color:var(--oi-tone-muted)}
.oi-pj-hs{display:flex;flex-direction:column;gap:2px;font-size:12px;color:var(--oi-tone-muted)}.oi-pj-hs b{font-size:12px;font-weight:600}
.t-green .oi-pj-hs b{color:var(--oi-tone-success)}.t-yellow .oi-pj-hs b{color:var(--oi-tone-attention)}.t-red .oi-pj-hs b{color:var(--oi-tone-failure)}
.oi-pj-name{font-size:15px;font-weight:600}.oi-pj-goal{color:var(--oi-text);opacity:.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.oi-pj-cnt{font-size:12px;color:var(--oi-tone-muted);margin-top:2px}
.oi-pj-prog{display:flex;align-items:center;gap:8px;margin-top:6px}.oi-pj-prog small{color:var(--oi-tone-muted);font-size:11px;white-space:nowrap}
.oi-pj-bar{flex:1;height:5px;background:var(--oi-hover);border:1px solid var(--oi-border);max-width:260px}.oi-pj-bar>span{display:block;height:100%;background:var(--oi-tone-success)}
.oi-pj-nx{display:flex;flex-direction:column;gap:6px;font-size:12px;min-width:0}.oi-pj-nx small,.oi-pj-cn small{color:var(--oi-tone-muted);font-size:11px}.oi-pj-wait{color:var(--oi-tone-attention)}
.oi-pj-bh{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;padding:4px 0 8px}.oi-pj-title{margin:0;font-size:19px;font-weight:650}
.oi-pj-tabs{display:flex;gap:2px;border-bottom:1px solid var(--oi-border);margin-bottom:8px}.oi-pj-tab{background:transparent;border:0;border-bottom:2px solid transparent;padding:5px 12px;cursor:pointer;color:var(--oi-tone-muted);font-size:12px;font-weight:600}
.oi-pj-tab[aria-selected="true"]{color:var(--oi-text);border-bottom-color:var(--oi-tone-info)}.oi-pj-tab:hover{color:var(--oi-text)}
.oi-pj-bw{display:flex;gap:12px;align-items:flex-start;min-height:0;flex:1}.oi-pj-main{flex:1;min-width:0;overflow:auto}
.oi-pj-bar2{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;margin-bottom:8px}.oi-pj-flt{display:flex;align-items:center;gap:6px;color:var(--oi-tone-muted);font-size:12px}
.oi-pj-seg{display:inline-flex;border:1px solid var(--oi-border)}.oi-pj-seg button{background:transparent;border:0;padding:3px 12px;cursor:pointer;color:var(--oi-tone-muted);font-size:12px;font-weight:600}
.oi-pj-seg button[aria-pressed="true"]{background:var(--oi-selected);color:var(--oi-text)}
.oi-pj-kan{display:grid;gap:8px;align-items:start;min-width:0}.oi-pj-col{min-width:0}.oi-pj-colh{font-size:12px;font-weight:600;color:var(--oi-tone-muted);padding:2px 2px 6px;border-bottom:1px solid var(--oi-border);margin-bottom:6px}
.oi-pj-pc{color:var(--oi-tone-muted);font-variant-numeric:tabular-nums;font-weight:400}.oi-pj-dot{color:var(--oi-border);padding:4px}
.oi-pj-card{border-bottom:1px solid var(--oi-border);border-left:3px solid var(--oi-tone-muted);padding:9px 11px;margin-bottom:0;cursor:pointer;line-height:1.5}
.oi-pj-card:hover{background:var(--oi-hover)}.oi-pj-card:focus-visible{outline:1px solid var(--oi-tone-info)}.oi-pj-card.sel{background:var(--oi-selected);border-bottom-color:var(--oi-tone-info)}
.oi-pj-card.s-green{border-left-color:var(--oi-tone-success)}.oi-pj-card.s-yellow{border-left-color:var(--oi-tone-attention)}.oi-pj-card.s-red{border-left-color:var(--oi-tone-failure)}.oi-pj-card.s-grey{border-left-color:var(--oi-tone-muted)}.oi-pj-card.s-purple{border-left-color:var(--oi-lane-2)}
.oi-pj-ct{font-size:14px;font-weight:600}.oi-pj-pr{font-size:12px;font-weight:600;margin-top:2px;color:var(--oi-tone-attention)}.s-red .oi-pj-pr{color:var(--oi-tone-failure)}.s-purple .oi-pj-pr{color:var(--oi-lane-2)}
.oi-pj-cn{font-size:12px;color:var(--oi-text);margin-top:3px}.oi-pj-pills2{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}
.oi-pj-tag{font-size:10.5px;font-weight:400;letter-spacing:.03em;padding:0 5px;border:1px solid var(--oi-border);color:var(--oi-tone-muted);white-space:nowrap}
.oi-pj-tag.k-info{color:var(--oi-tone-info);border-color:var(--oi-tone-info)}.oi-pj-tag.k-attention{color:var(--oi-tone-attention);border-color:var(--oi-tone-attention)}.oi-pj-tag.k-failure{color:var(--oi-tone-failure);border-color:var(--oi-tone-failure)}.oi-pj-tag.k-success{color:var(--oi-tone-success);border-color:var(--oi-tone-success)}
.oi-pj-drawer{width:300px;flex:none;border-left:1px solid var(--oi-border);padding-left:12px;max-height:100%;overflow:auto}.oi-pj-drawer ul{margin:0;padding-left:14px}.oi-pj-drawer li{margin:3px 0}
.oi-pj-gl{color:var(--oi-tone-muted);font-size:11px;font-weight:600;margin:10px 0 4px}
.oi-pj-oc{display:flex;flex-direction:column;gap:2px;width:100%;text-align:left;background:transparent;border:1px solid var(--oi-border);padding:6px 8px;margin-bottom:4px;cursor:pointer}.oi-pj-oc:hover{background:var(--oi-hover)}.oi-pj-oc.sel{border-color:var(--oi-tone-info)}.oi-pj-oc.insp{background:var(--oi-selected)}
.oi-pj-ot{font-size:13px;font-weight:600}.oi-pj-os{color:var(--oi-text);opacity:.85}.oi-pj-ol{max-width:720px}.oi-pj-act{margin:0;padding-left:16px;line-height:1.7}
@media (max-width:900px){.oi-pj-pc2{grid-template-columns:1fr}.oi-pj-bw{flex-direction:column}.oi-pj-drawer{width:100%;border-left:0;padding-left:0}.oi-pj-search{flex-basis:100%;max-width:none}}
`;
