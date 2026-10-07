#!/usr/bin/env python3
"""Local metadata-only tool observer. No native agent configuration changes."""
import argparse
import collections
import datetime
import json
import math
import os
from pathlib import Path
import re
import statistics
import sys
import time

try:
    from . import trusted_bin
except ImportError:  # run as a script (python bff/herdr_observer.py): the module sits beside it
    import trusted_bin

# What the herdr child may see besides the minimal base: how to find the user's own server.
HERDR_INHERIT = ('HERDR_SOCKET_PATH', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR', 'TMPDIR', 'USER', 'LOGNAME')
FIELDS = ('source provider sessionId callId turnId parentCallId model tool server status '
          'startedAt endedAt durationMs durationKind errorCode').split()
STATUSES = ('success', 'error', 'denied', 'cancelled', 'unknown', 'running')
TOOL_ITEMS = {'commandexecution', 'mcptoolcall', 'dynamictoolcall', 'filechange',
              'websearch', 'extension', 'collabagenttoolcall'}
MAX_FILE_BYTES = 8 * 1024 * 1024
MAX_COLLECTION_BYTES = 32 * 1024 * 1024
MAX_LINE_BYTES = 512 * 1024
MAX_DISCOVERY_ENTRIES = 20000


def timestamp(value):
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        try:
            return round(datetime.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000)
        except ValueError:
            pass
    return None


def record(source, provider, sid, cid, tool, start=None, **kw):
    r = dict.fromkeys(FIELDS)
    r.update(source=source, provider=provider, sessionId=sid, callId=cid, tool=tool,
             startedAt=start, status='unknown', durationKind='unknown')
    r.update(kw)
    if tool.startswith('mcp__'):
        parts = tool.split('__', 2)
        if len(parts) == 3:
            r.update(server=parts[1], tool=parts[2])
    return r


def normalize(raw):
    r = {k: raw.get(k) for k in FIELDS}
    if not all(isinstance(r[k], str) and r[k] for k in ('source', 'provider', 'sessionId', 'callId', 'tool')):
        raise ValueError('Call requires opaque source/provider/sessionId/callId and tool identity')
    if r['status'] not in STATUSES:
        r['status'] = 'unknown'
    duration = r['durationMs']
    if not isinstance(duration, (float, int)) or isinstance(duration, bool) or not math.isfinite(duration) or duration < 0:
        r['durationMs'] = None
    if r['durationMs'] is None:
        r['durationKind'] = 'unknown'
    elif r['durationKind'] not in ('provider', 'observed'):
        r['durationKind'] = 'unknown'
    return r


def dedupe(calls):
    unique = {}
    for raw in calls:
        r = normalize(raw)
        key = tuple(r[k] for k in ('source', 'provider', 'sessionId', 'callId'))
        old = unique.get(key)
        # A replayed start must never replace an already observed terminal result.
        if old and old['status'] not in ('unknown', 'running') and r['status'] in ('unknown', 'running'):
            continue
        unique[key] = r
    return list(unique.values())


def metrics(calls):
    counts = collections.Counter(c['status'] for c in calls)
    durations = [c['durationMs'] for c in calls if c['durationMs'] is not None]
    executed = counts['success'] + counts['error']
    return {'calls': len(calls), **{s: counts[s] for s in STATUSES}, 'executed': executed,
            'errorRate': counts['error'] / executed if executed else None,
            'measuredDurations': len(durations),
            'meanDurationMs': statistics.mean(durations) if durations else None,
            'p50DurationMs': statistics.median(durations) if durations else None}


def analyze(calls):
    rows = dedupe(calls)
    groups = collections.defaultdict(list)
    for r in rows:
        groups[(r['provider'], r['server'] or '', r['tool'])].append(r)
    timeline = sorted(rows, key=lambda r: (r['startedAt'] is None, r['startedAt'] or 0,
                                          r['sessionId'], r['callId']))
    recoveries = []
    # This is sequence visibility, never a claim that the next success fixes the same task.
    failed = {}
    for r in timeline:
        key = (r['source'], r['provider'], r['sessionId'], r['server'], r['tool'])
        if r['status'] == 'error':
            failed[key] = r
        elif r['status'] == 'success' and key in failed:
            previous = failed.pop(key)
            recoveries.append({'sessionId': r['sessionId'], 'tool': r['tool'],
                               'errorCallId': previous['callId'], 'laterSuccessCallId': r['callId'],
                               'kind': 'later_same_tool_success'})
    return {'version': 1, 'calls': rows, 'totals': metrics(rows), 'tools': [
        {'provider': k[0], 'server': k[1] or None, 'tool': k[2], **metrics(v)}
        for k, v in sorted(groups.items())], 'timeline': timeline, 'recoverySequences': recoveries}


def events(path, coverage):
    coverage.setdefault('oversizeLines', 0)
    with path.open('rb') as stream:
        consumed = 0
        for _ in range(40000):
            line = stream.readline(MAX_LINE_BYTES + 1)
            if not line:
                break
            consumed += len(line)
            if len(line) > MAX_LINE_BYTES:
                coverage['oversizeLines'] += 1
                while line and not line.endswith(b'\n'):
                    line = stream.readline(MAX_LINE_BYTES + 1)
                    consumed += len(line)
                    if consumed > MAX_FILE_BYTES:
                        coverage['parseTruncated'] = True
                        return
                continue
            if consumed > MAX_FILE_BYTES:
                coverage['parseTruncated'] = True
                return
            try:
                event = json.loads(line)
            except ValueError:
                coverage['malformedRecords'] += 1
                continue
            if isinstance(event, dict):
                yield event
        else:
            coverage['parseTruncated'] = True


def structured_status(data, default='unknown'):
    status = str(data.get('status', '')).lower()
    if data.get('interrupted') is True or status in ('cancelled', 'canceled', 'interrupted', 'aborted'):
        return 'cancelled', 'CANCELLED'
    if status in ('denied', 'permission_denied', 'rejected'):
        return 'denied', 'PERMISSION_DENIED'
    if data.get('is_error') is True or data.get('isError') is True or data.get('success') is False:
        return 'error', 'TOOL_ERROR'
    if data.get('error') is not None or status in ('failed', 'error'):
        return 'error', 'TOOL_ERROR'
    code = data.get('exit_code', data.get('exitCode'))
    if isinstance(code, (int, float)) and code != 0:
        return 'error', 'NONZERO_EXIT'
    if isinstance(code, (int, float)) and code == 0:
        return 'success', None
    if status in ('completed', 'success', 'succeeded') or data.get('success') is True:
        return 'success', None
    return default, None


def parse_claude(path):
    coverage = {'malformedRecords': 0, 'orphanResults': 0, 'adapter': 'claude-tool-use-result'}
    calls, results = {}, {}
    sid = None
    for e in events(path, coverage):
        sid = e.get('sessionId') or sid
        m = e.get('message') or {}
        if not isinstance(m, dict):
            coverage['malformedRecords'] += 1
            continue
        parts = m.get('content')
        if not isinstance(parts, list):
            continue
        for part in parts:
            if not isinstance(part, dict):
                continue
            if part.get('type') == 'tool_use' and part.get('id'):
                cid = part['id']
                # Subagent files retain parent sessionId; agentId is the original child identity.
                session = str(e.get('agentId') or sid or 'unknown-session')
                calls[cid] = record('claude-transcript', 'claude-code', session, cid,
                                    part.get('name') or 'unknown-tool', timestamp(e.get('timestamp')),
                                    model=m.get('model'), parentCallId=e.get('parentToolUseID'))
            elif part.get('type') == 'tool_result' and part.get('tool_use_id'):
                status, code = structured_status(e.get('toolUseResult') if isinstance(e.get('toolUseResult'), dict) else {}, 'success')
                if part.get('is_error') is True and status not in ('cancelled', 'denied'):
                    status, code = 'error', 'TOOL_ERROR'
                results[part['tool_use_id']] = (timestamp(e.get('timestamp')), status, code)
    for cid, (end, status, code) in results.items():
        if cid not in calls:
            coverage['orphanResults'] += 1
            continue
        r = calls[cid]
        r.update(endedAt=end, status=status, errorCode=code)
        # Transcript wall time is observed, not measured execution. Keep unknown by default.
    coverage['unmatchedStarts'] = sum(c['status'] == 'unknown' for c in calls.values())
    coverage['durationCoverage'] = 'No provider execution durations; timestamps retained, duration unknown'
    return list(calls.values()), coverage


def item_kind(item):
    return str(item.get('type') or '').replace('_', '').lower()


def parse_codex(path):
    coverage = {'malformedRecords': 0, 'orphanResults': 0, 'adapter': 'codex-completed-items', 'ignoredResponseWrappers': 0}
    authoritative, fallback, results, wrapper_ids, correlated_ids = {}, {}, {}, set(), set()
    unsupported = collections.Counter()
    sid, turn, model = None, None, None
    for e in events(path, coverage):
        p = e.get('payload') or {}
        if not isinstance(p, dict):
            continue
        typ = p.get('type')
        if e.get('type') == 'session_meta':
            sid = p.get('id') or p.get('session_id') or sid
        if e.get('type') == 'turn_context':
            turn, model = p.get('turn_id'), p.get('model')
        if typ == 'task_started':
            turn = p.get('turn_id') or turn
        if typ in ('item_completed', 'item_started') or e.get('type') in ('item.completed', 'item.started'):
            it = p.get('item') or e.get('item') or {}
            kind = item_kind(it)
            if kind not in TOOL_ITEMS or not it.get('id'):
                if kind and kind not in ('reasoning', 'agentmessage', 'usermessage', 'subagentactivity', 'plan'):
                    unsupported[kind] += 1
                continue
            cid = it['id']
            correlated_ids.add(cid)
            if it.get('call_id'):
                correlated_ids.add(it['call_id'])
            tool = {'commandexecution': 'commandExecution', 'mcptoolcall': 'mcpToolCall',
                    'filechange': 'fileChange', 'websearch': 'webSearch'}.get(kind, it.get('type'))
            if kind in ('mcptoolcall', 'dynamictoolcall'):
                tool = it.get('tool') or it.get('tool_name') or tool
            if kind == 'extension':
                tool = it.get('kind') or 'extension'
            r = record('codex-transcript', 'codex', sid or 'unknown-session', cid, tool,
                       p.get('started_at_ms'), turnId=p.get('turn_id') or turn, model=model,
                       server=it.get('server'), parentCallId=it.get('parent_call_id'))
            completed = typ == 'item_completed' or e.get('type') == 'item.completed'
            status, code = structured_status(it, 'success' if completed and kind in ('filechange', 'websearch', 'extension') else 'unknown')
            r.update(status=status, errorCode=code, endedAt=p.get('completed_at_ms'))
            duration = it.get('duration', it.get('durationMs'))
            if isinstance(duration, dict) and isinstance(duration.get('secs'), (int, float)):
                duration = duration['secs'] * 1000 + duration.get('nanos', 0) / 1_000_000
            if isinstance(duration, (int, float)) and duration >= 0:
                r.update(durationMs=duration, durationKind='provider')
            old = authoritative.get(cid)
            if not old or completed or old['status'] in ('unknown', 'running'):
                authoritative[cid] = r
        elif typ in ('function_call', 'custom_tool_call') and p.get('call_id'):
            cid = p['call_id']
            name = p.get('name') or 'unknown-tool'
            if p.get('namespace'):
                name = str(p['namespace']) + '.' + name
            fallback[cid] = record('codex-transcript', 'codex', sid or 'unknown-session', cid,
                                   name, timestamp(e.get('timestamp')), turnId=turn, model=model)
            if typ == 'custom_tool_call' and p.get('name') == 'exec':
                wrapper_ids.add(cid)
        elif typ in ('function_call_output', 'custom_tool_call_output') and p.get('call_id'):
            output = p.get('output')
            # Never interpret arbitrary natural-language output as proof of success.
            metadata = output if isinstance(output, dict) else {}
            status, code = structured_status(metadata)
            results[p['call_id']] = (timestamp(e.get('timestamp')), status, code)
    for cid, (end, status, code) in results.items():
        if cid in fallback:
            fallback[cid].update(endedAt=end, status=status, errorCode=code)
        else:
            coverage['orphanResults'] += 1
    if authoritative:
        omitted = [r for cid,r in fallback.items() if cid in wrapper_ids and cid not in correlated_ids]
        coverage['ignoredResponseWrappers'] = len(omitted)
        coverage['excludedWrappers'] = [{'callId':r['callId'],'tool':r['tool']} for r in omitted]
        coverage['exactlyCorrelatedResponseRecords'] = sum(cid in correlated_ids for cid in fallback)
        remainder = [r for cid,r in fallback.items() if cid not in wrapper_ids and cid not in correlated_ids]
        calls = list(authoritative.values()) + remainder
        coverage['uncorrelatedResponseCalls'] = len(remainder)
        coverage['countingTier'] = 'Native execution items plus uncorrelated response calls; exec orchestration wrappers explicitly excluded'
    else:
        coverage['adapter'] = 'codex-response-call-fallback'
        coverage['countingTier'] = 'Response requests; opaque result strings leave outcome unknown'
        calls = list(fallback.values())
    coverage['unsupportedNativeKinds'] = dict(unsupported)
    coverage['unmatchedStarts'] = sum(c['endedAt'] is None for c in calls)
    return calls, coverage


class NativeCollector:
    def __init__(self, latest=8, session=None, files=None):
        self.latest, self.session, self.files = latest, session, files or []
        self.cache = {}
        self.discovered, self.last_discovery, self.discovery_truncated = [], 0, False

    def discover(self):
        if self.last_discovery and time.monotonic()-self.last_discovery < 30:
            return self.discovered
        paths, examined = [], 0
        started = time.monotonic()
        self.discovery_truncated = False
        roots = [(Path(os.environ.get('CLAUDE_CONFIG_DIR', Path.home()/'.claude'))/'projects', 'claude'),
                 (Path(os.environ.get('CODEX_HOME', Path.home()/'.codex'))/'sessions', 'codex')]
        for root, provider in roots:
            candidates = []
            for directory, dirs, names in os.walk(root):
                dirs[:] = [d for d in dirs if not d.startswith('.')]
                examined += len(dirs)
                for name in names:
                    examined += 1
                    if examined > MAX_DISCOVERY_ENTRIES or time.monotonic()-started > 1:
                        self.discovery_truncated = True
                        dirs.clear()
                        break
                    if not name.endswith('.jsonl') or self.session and self.session not in name:
                        continue
                    p = Path(directory)/name
                    if p.is_symlink() or not p.is_file():
                        continue
                    try:
                        candidates.append((p.stat().st_mtime_ns,p))
                    except OSError:
                        pass
                if self.discovery_truncated:
                    break
            candidates.sort(reverse=True)
            paths.extend((p,provider) for _,p in candidates[:self.latest])
        self.discovered, self.last_discovery = paths, time.monotonic()
        return paths

    def collect(self):
        paths = list(self.discover())
        for filename in self.files:
            p = Path(filename).expanduser().resolve()
            if p.suffix != '.jsonl':
                raise ValueError('Explicit native files must be JSONL session files')
            provider = 'claude' if '.claude' in p.parts else 'codex'
            paths.append((p, provider))
        rows, coverage, read_budget = [], [], MAX_COLLECTION_BYTES
        for p, provider in dict(paths).items():
            if p.is_symlink():
                coverage.append({'provider':provider,'calls':0,'skipped':'symlink'})
                continue
            try:
                stat = p.stat()
            except OSError:
                coverage.append({'provider':provider,'calls':0,'skipped':'unavailable'})
                continue
            if stat.st_size > MAX_FILE_BYTES:
                coverage.append({'provider':provider,'calls':0,'skipped':'oversize'})
                continue
            signature = (stat.st_mtime_ns, stat.st_size)
            cached = self.cache.get(str(p))
            if not cached or cached[0] != signature:
                if stat.st_size > read_budget:
                    coverage.append({'provider':provider,'calls':0,'skipped':'collection-byte-budget'})
                    continue
                read_budget -= stat.st_size
                try:
                    calls, detail = parse_claude(p) if provider == 'claude' else parse_codex(p)
                except OSError:
                    coverage.append({'provider':provider,'calls':0,'skipped':'unavailable'})
                    continue
                self.cache[str(p)] = (signature, calls, detail)
            _, calls, detail = self.cache[str(p)]
            if self.session:
                calls = [c for c in calls if c['sessionId'] == self.session]
            rows.extend(calls)
            coverage.append({'provider': provider, 'calls': len(calls), **detail})
        active = {str(p) for p, _ in paths}
        self.cache = {k:v for k,v in self.cache.items() if k in active}
        return dedupe(rows), {'mode': 'native', 'filesScanned': len(coverage), 'files': coverage,
                             'discoveryTruncated': self.discovery_truncated,
                             'limits': {'latestPerProvider':self.latest,'maxFileBytes':MAX_FILE_BYTES,
                                        'maxCollectionBytes':MAX_COLLECTION_BYTES,'discoveryRefreshSeconds':30},
                             'paneIdentity': 'unknown until compatible Herdr session mapping is queried',
                             'liveState': 'Unmatched records stay unknown; no liveness inferred from file age'}


def fixture(path):
    envelope = json.loads(Path(path).expanduser().read_text())
    if envelope.get('version') != 1 or not isinstance(envelope.get('calls'), list):
        raise ValueError('Expected comparison version1 calls envelope')
    calls = dedupe(envelope['calls'])
    sources = {c['source'] for c in calls}
    if 'fixture' in sources and len(sources) > 1:
        raise ValueError('Fixture and native calls must be viewed separately')
    return calls, {'mode': 'fixture' if sources == {'fixture'} else 'import', 'paneIdentity': 'unknown'}


def presentation(result, view='tools', provider=None, errors=False):
    rows = result['timeline']
    if provider:
        rows = [r for r in rows if r['provider'] == provider]
    if errors:
        rows = [r for r in rows if r['status'] in ('error', 'denied', 'cancelled', 'unknown')]
    selected = analyze(rows)
    t = selected['totals']
    rate = '-' if t['errorRate'] is None else f"{100*t['errorRate']:.2f}%"
    details = result['coverage'].get('files', [])
    skipped = sum(bool(d.get('skipped')) for d in details)
    malformed = sum(d.get('malformedRecords',0)+d.get('oversizeLines',0) for d in details)
    partial = bool(result['coverage'].get('discoveryTruncated')) or skipped or malformed or any(d.get('parseTruncated') for d in details)
    lines = [f"Herdr Tool Observer | {result['coverage']['mode']} | view {view}",
             f"Calls {t['calls']}  success {t['success']}  error {t['error']}  denied {t['denied']}  cancelled {t['cancelled']}",
             f"unknown {t['unknown']}  running {t['running']}  error rate {rate}  measured durations {t['measuredDurations']}",
             'T tools / L timeline / R recovery / E exceptions / 1 all / 2 Claude / 3 Codex / Q quit',
             'Pane join unknown. Missing timing stays unknown. Next success does not prove task recovery.',
             f"Coverage {'PARTIAL' if partial else 'bounded'}: skipped files {skipped}, skipped/malformed records {malformed}", '']
    if view == 'tools':
        lines.append('PROVIDER       SERVER          TOOL                    CALLS  OK  ERR DEN CAN UNK')
        for g in selected['tools']:
            lines.append(f"{g['provider'][:13]:13}  {(g['server'] or '-')[:14]:14}  {g['tool'][:23]:23} {g['calls']:5} {g['success']:3} {g['error']:3} {g['denied']:3} {g['cancelled']:3} {g['unknown']:3}")
    elif view == 'timeline':
        lines.append('TIME (UTC)     PROVIDER     TOOL                 STATUS      MS         CALL / PARENT')
        for r in rows:
            when = datetime.datetime.fromtimestamp(r['startedAt']/1000, datetime.timezone.utc).strftime('%H:%M:%S.%f')[:12] if r['startedAt'] is not None else 'unknown'
            duration = '-' if r['durationMs'] is None else f"{r['durationMs']:.4g}"
            lines.append(f"{when:13} {r['provider'][:12]:12} {r['tool'][:20]:20} {r['status']:10} {duration:9} {r['callId']} / {r['parentCallId'] or '-'}")
    else:
        lines.append('Same session + same tool: error followed by later success (sequence only)')
        lines.extend(f"{r['tool']}: {r['errorCallId']} -> {r['laterSuccessCallId']}" for r in selected['recoverySequences'])
    return lines


def tui(loader):
    try:
        import curses
    except ImportError:
        raise ValueError('Terminal view unavailable: this Python has no curses support')
    def run(screen):
        screen.timeout(500)
        view, offset, provider, errors = 'tools', 0, None, False
        result, refreshed = None, 0
        while True:
            if time.monotonic() - refreshed >= 2 or result is None:
                calls, coverage = loader()
                result = {**analyze(calls), 'coverage': coverage}
                refreshed = time.monotonic()
            lines = presentation(result, view, provider, errors)
            h, w = screen.getmaxyx()
            screen.erase()
            for y, line in enumerate(lines[:6] + lines[6+offset:6+offset+max(0,h-6)]):
                try:
                    screen.addnstr(y, 0, line, max(0,w-1))
                except curses.error:
                    pass
            screen.refresh()
            key = screen.getch()
            if key in (ord('q'), ord('Q'), 27):
                return
            if key in (ord('t'), ord('T'), ord('l'), ord('L'), ord('r'), ord('R')):
                view = {ord('t'): 'tools', ord('l'): 'timeline', ord('r'): 'recovery'}[key | 32]
                offset = 0
            if key in (ord('e'), ord('E')):
                errors = not errors
                offset = 0
            if key in (ord('1'), ord('2'), ord('3')):
                provider = {ord('1'): None, ord('2'): 'claude-code', ord('3'): 'codex'}[key]
                offset = 0
            if key == curses.KEY_DOWN:
                offset = min(offset+1, max(0,len(lines)-7))
            elif key == curses.KEY_UP:
                offset = max(0,offset-1)
    curses.wrapper(run)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('fixture', 'native', 'tui', 'check-herdr'))
    parser.add_argument('input', nargs='?')
    parser.add_argument('--session')
    parser.add_argument('--latest', type=int, default=8, help='Most recent files per provider')
    parser.add_argument('--file', action='append', default=[])
    parser.add_argument('--export', help='Write a canonical metadata-only calls envelope')
    parser.add_argument('--once', action='store_true', help='Render terminal view once without curses')
    parser.add_argument('--view', choices=('tools', 'timeline', 'recovery'), default='tools')
    args = parser.parse_args()
    if args.command == 'check-herdr':
        executable = trusted_bin.which('herdr')
        if not executable:
            print(json.dumps({'available': False, 'errorCode': 'EXECUTABLE_UNAVAILABLE', 'agents': []}))
            return
        proc = trusted_bin.run([executable,'agent','list'],capture_output=True,text=True,timeout=3,inherit=HERDR_INHERIT)
        try:
            reply = json.loads(proc.stdout or proc.stderr)
            error = (reply.get('error') or {}).get('code')
            agents = (reply.get('result') or {}).get('agents') or []
            print(json.dumps({'available': not error and proc.returncode == 0, 'errorCode': error,
                              'agents': [{k:a.get(k) for k in ('pane_id','workspace_id','tab_id','agent_session')} for a in agents]}))
        except ValueError:
            print(json.dumps({'available': False, 'errorCode': 'SOCKET_UNAVAILABLE', 'agents': []}))
        return
    if args.command == 'fixture' and not args.input:
        parser.error('fixture requires an envelope file')
    if not 1 <= args.latest <= 32:
        parser.error('--latest must be 1..32')
    collector = NativeCollector(args.latest, args.session, args.file)
    loader = (lambda: fixture(args.input)) if args.input else collector.collect
    if args.command == 'tui' and not args.once:
        tui(loader)
        return
    calls, coverage = loader()
    if args.export:
        Path(args.export).expanduser().write_text(json.dumps({'version':1,'calls':calls},indent=2)+'\n')
    result = {**analyze(calls), 'coverage': coverage}
    if args.command == 'tui':
        print('\n'.join(presentation(result,args.view)))
    else:
        print(json.dumps(result,indent=2))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, trusted_bin.TimeoutExpired) as error:
        print(json.dumps({'errorCode':type(error).__name__}),file=sys.stderr)
        sys.exit(1)
