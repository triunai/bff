"""Bounded local provider capture. Capture time is not a source heartbeat."""

import json
import math
import os
from pathlib import Path
import tempfile
import time

from .herdr_observer import FIELDS, NativeCollector, normalize

MAX_FEED_BYTES = 8 * 1024 * 1024
MAX_TIMESTAMP = 253402300799999  # Last representable UTC millisecond in year 9999.


def canonical_call(raw):
    call = normalize(raw)
    if call["source"] not in ("claude-transcript", "codex-transcript"):
        raise ValueError("Capture source must retain its native provider transcript identity")
    for key in FIELDS:
        if key in ("startedAt", "endedAt"):
            value = call[key]
            if (isinstance(value, bool) or not isinstance(value, (int, float)) or
                    not math.isfinite(value) or not 0 <= value <= MAX_TIMESTAMP):
                call[key] = None
        elif key not in ("durationMs",):
            if call[key] is not None and not isinstance(call[key], str):
                call[key] = None
            elif isinstance(call[key], str) and key not in ("sessionId", "callId", "parentCallId", "turnId"):
                call[key] = call[key][:1024]
    return call


def output_path(output):
    output = Path(output).expanduser()
    if ".." in output.parts:
        raise ValueError("Output path must not traverse parent directories")
    output = output.absolute()
    for path in (output,) + tuple(output.parents):
        if path.is_symlink():
            raise ValueError("Output symlink or symlink parent refused")
    if output.exists() and not output.is_file():
        raise ValueError("Output must be a regular file")
    for parent in output.parents:
        if parent.exists() and not parent.is_dir():
            raise ValueError("Output parent must be a directory")
    return output


def feed(calls, coverage, captured_at=None):
    now = time.time_ns() // 1_000_000 if captured_at is None else captured_at
    if isinstance(now, bool) or not isinstance(now, int) or not 0 <= now <= MAX_TIMESTAMP:
        raise ValueError("Invalid capture timestamp")
    scanned = coverage.get("filesScanned", 0)
    if isinstance(scanned, bool) or not isinstance(scanned, int) or scanned < 0:
        raise ValueError("Invalid filesScanned coverage")
    partial = bool(coverage.get("discoveryTruncated"))
    envelope = {"version": 1, "kind": "herdr-provider-capture", "capturedAt": now,
                "calls": [], "coverage": {"filesScanned": scanned, "discoveryTruncated": partial}}
    # Reserve header/coverage room; encode each canonical record once to bound the artifact.
    budget = MAX_FEED_BYTES - 1024
    records = []
    for raw in calls:
        encoded = json.dumps(canonical_call(raw), ensure_ascii=True, allow_nan=False, separators=(",", ":")).encode()
        if len(encoded) + 1 > budget:
            envelope["coverage"]["discoveryTruncated"] = True
            break
        records.append(encoded)
        budget -= len(encoded) + 1
    header = json.dumps(envelope, separators=(",", ":"), allow_nan=False).encode()
    # Empty calls list is replaced without re-serializing potentially large record structures.
    data = header.replace(b'"calls":[]', b'"calls":[' + b','.join(records) + b']', 1) + b"\n"
    if len(data) > MAX_FEED_BYTES:
        raise ValueError("Capture feed exceeds 8 MiB")
    return data, len(records)


def write_atomic(output, data):
    output = output_path(output)
    if len(data) > MAX_FEED_BYTES:
        raise ValueError("Capture feed exceeds 8 MiB")
    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix=".bff-herdr-", dir=str(output.parent))
    temporary = Path(name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        output_path(output)  # Recheck target and parent before activation.
        os.replace(str(temporary), str(output))
    finally:
        if temporary.exists():
            temporary.unlink()


def capture(args):
    if not 1 <= args.latest <= 32:
        raise ValueError("--latest must be 1..32")
    if not math.isfinite(args.interval) or args.interval < 5:
        raise ValueError("--interval must be at least 5 seconds")
    if args.session is not None and (not args.session or len(args.session) > 1024):
        raise ValueError("--session must be a nonempty exact session identity")
    output = output_path(args.output)
    collector = NativeCollector(latest=args.latest, session=args.session)
    try:
        while True:
            calls, coverage = collector.collect()
            if args.session is not None:
                calls = [call for call in calls if call.get("sessionId") == args.session]
            data, count = feed(calls, coverage)
            write_atomic(output, data)
            print("Captured " + str(count) + " local provider calls; pane membership unknown; recent capture is not a heartbeat.", flush=True)
            if args.once:
                return 0
            time.sleep(args.interval)
    except KeyboardInterrupt:
        return 0
