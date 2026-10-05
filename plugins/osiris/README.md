# Osiris for BB

Osiris is BFF's BB workbench. The Osiris sidebar entry keeps native BB conversation central, with scanned work threads at left and actual Changes, Trace, Problems and selected-call metadata at right. A separate Toolcalls entry has its own search and starts across all scanned threads. The existing-thread Osiris panel is scoped to that exact BB thread and does not embed a second chat.

This package contains the current source and prebuilt BB artifacts. It preserves plugin identity `tool-observer`, tested with BB **0.45.0** and public SDK **0.6.15**.

```sh
bb plugin install /path/to/bff/plugins/osiris
```

Use the BB sidebar **Osiris** or **Toolcalls** entry. Source, provider, exact thread/session, time/outcome, coverage and import/export controls are in the ellipsis menu. Search supports text and structured predicates such as `status:error tool:exec duration:>5s`.

BB source reads bounded retained lifecycle history (40 threads, 1000 relevant events per thread). All collected calls are reachable through paging; collection caps, scan failures and history truncation remain distinct. Native conversation links use actual BB thread identity. Public environment Changes is the current checkout's uncommitted diff, not historical tool output or agent-specific landing proof.

The separate **Herdr / local provider capture** source consumes the namespaced metadata feed created by `bff herdr`. It reports availability, timestamp, staleness and capture coverage. BB does not read native provider transcripts for that source. Provider sessions are not assumed to be Herdr panes or BB threads. Missing capture remains unavailable, not a fabricated clean zero.

Import/export uses canonical metadata only. Inputs, raw events, credentials, stacks and source content are not included in exports. Selected-call inspection reports only metadata supported by this collector; no inferred retry/recovery, root cause, wait/self timing or completeness percentage is claimed. Zero provider timing retains its precision limitation; p95 needs at least 20 samples.

## Rebuild

The five TypeScript/TSX sources are a closed package; no private BB imports or additional component scaffold is needed. With Node 24, BB 0.45.0 and dependencies installed:

```sh
npm install --ignore-scripts
npm run typecheck
npm run build
```

SDK and Zod versions are pinned; React is supplied by BB's frontend runtime, and the BB SDK is supplied by its plugin host. Zod is bundled in the server artifact. The build emits a server source map for development; omit `*.map` and remove its `sourceMappingURL` comment when making a sanitized release. The distributed `dist/` already contains only required JS/CSS, metadata and the ESM package marker.

## License boundary

Osiris-specific code is MIT, Copyright (c) 2026 triunai. [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt) retains the full BB scaffold/template and generated-adapter MIT notice, bundled Zod MIT notice, and generated Tailwind/animation utility MIT notices. BB, its SDK and React remain separate host-provided products under their own terms; their packages and `node_modules` are not vendored here. Build/typechecking tools are declared dependencies, not distributed implementations. No private logs, fixture captures, source maps, machine paths, example skills or unused component library is included.
