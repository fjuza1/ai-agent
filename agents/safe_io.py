"""Lock-protected, atomic file storage shared by every agent.

Every read and write of an agent-owned file goes through this module:

* An exclusive ``<file>.lock`` is held for the duration of each read and write, across
  processes and threads. Locks are re-entrant, so a read-modify-write is made atomic by
  wrapping it in ``file_lock(path)`` and calling the read/write helpers inside.
* Writes go to a unique ``<file>.<id>.tmp`` in the same directory, are flushed to disk and
  then moved over the target with ``os.replace()``. Readers (agents, VS Code, a running
  Next.js dev server) therefore see the old or the new document, never a partial one.
* A write whose bytes equal the current file is skipped, so watchers are not woken up and
  git sees no change when an agent run produced nothing new.
* With ``AGENT_DRY_RUN=1`` all writes and lock files are redirected to a scratch directory
  (``AGENT_DRY_RUN_DIR``) and reads prefer that copy, so a whole pipeline can be rehearsed
  without touching the working tree.

The files guarded this way include ``data/supplements.json`` (the published USA catalog),
``data/stickers_catalog.json``, ``data/daily_visual_theme.json``, ``data/cost_ledger.json``
and ``data/qa_session_state.json``; the helpers work for any path.
"""
from __future__ import annotations

from contextlib import ExitStack, contextmanager, suppress
import errno
import json
import os
from pathlib import Path
import tempfile
import threading
import time
from typing import Iterator
from uuid import uuid4

from filelock import FileLock

DRY_RUN_ENV = "AGENT_DRY_RUN"
DRY_RUN_DIR_ENV = "AGENT_DRY_RUN_DIR"
LOCK_TIMEOUT_ENV = "AGENT_LOCK_TIMEOUT_SECONDS"
DEFAULT_LOCK_TIMEOUT = 60.0
# Windows refuses to replace a file that another process (editor, indexer, antivirus) has open.
REPLACE_ATTEMPTS = 8

_locks: dict[str, FileLock] = {}
_locks_guard = threading.Lock()


def dry_run() -> bool:
    return os.environ.get(DRY_RUN_ENV, "").strip().lower() in ("1", "true", "yes", "on")


def dry_run_dir() -> Path:
    configured = os.environ.get(DRY_RUN_DIR_ENV, "").strip()
    if not configured:
        configured = tempfile.mkdtemp(prefix="agent-dry-run-")
        os.environ[DRY_RUN_DIR_ENV] = configured
    return Path(configured)


def _shadow(path: Path) -> Path:
    return dry_run_dir().joinpath(*path.resolve().parts[1:])


def resolve_write(path: str | os.PathLike[str]) -> Path:
    """Where a write to ``path`` lands: the file itself, or its scratch copy during a dry run."""
    path = Path(path)
    return _shadow(path) if dry_run() else path


def resolve_read(path: str | os.PathLike[str]) -> Path:
    """Where ``path`` is read from: a dry run sees its own earlier writes, otherwise the real file."""
    path = Path(path)
    if dry_run():
        shadow = _shadow(path)
        if shadow.exists():
            return shadow
    return path


def _lock_timeout(timeout: float | None) -> float:
    if timeout is not None:
        return timeout
    try:
        configured = float(os.environ.get(LOCK_TIMEOUT_ENV, DEFAULT_LOCK_TIMEOUT))
    except ValueError:
        return DEFAULT_LOCK_TIMEOUT
    return configured if configured >= 0 else DEFAULT_LOCK_TIMEOUT


def _lock_for(path: Path) -> FileLock:
    target = resolve_write(path).resolve()
    lock_file = target.with_name(target.name + ".lock")
    key = os.path.normcase(str(lock_file))
    with _locks_guard:
        lock = _locks.get(key)
        if lock is None:
            lock = _locks[key] = FileLock(str(lock_file))
        return lock


@contextmanager
def file_lock(*paths: str | os.PathLike[str], timeout: float | None = None) -> Iterator[None]:
    """Holds the exclusive ``<path>.lock`` of every given path.

    Locks are taken in one global order, so callers that need several files cannot deadlock
    each other. ``filelock.Timeout`` (an ``OSError``) is raised when a lock stays busy.
    """
    locks = {lock.lock_file: lock for lock in (_lock_for(Path(path)) for path in paths)}
    wait = _lock_timeout(timeout)
    with ExitStack() as stack:
        for name in sorted(locks):
            lock = locks[name]
            Path(name).parent.mkdir(parents=True, exist_ok=True)
            lock.acquire(timeout=wait)
            stack.callback(lock.release)
        yield


def _replace(temp: Path, target: Path) -> None:
    delay = 0.02
    for attempt in range(REPLACE_ATTEMPTS):
        try:
            os.replace(temp, target)
            return
        except PermissionError:
            if os.name != "nt" or attempt == REPLACE_ATTEMPTS - 1:
                raise
            time.sleep(delay)
            delay = min(delay * 2, 0.5)


def _sync_directory(directory: Path) -> None:
    if os.name == "nt":
        return
    with suppress(OSError):
        descriptor = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def atomic_write_bytes(path: str | os.PathLike[str], data: bytes) -> bool:
    """Replaces ``path`` with ``data`` under its lock; returns False when it already held exactly that."""
    path = Path(path)
    with file_lock(path):
        with suppress(OSError):
            if resolve_read(path).read_bytes() == data:
                return False
        target = resolve_write(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        temp = target.with_name(f"{target.name}.{os.getpid()}-{uuid4().hex[:8]}.tmp")
        try:
            with open(temp, "xb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            _replace(temp, target)
        except BaseException:
            with suppress(OSError):
                temp.unlink()
            raise
        _sync_directory(target.parent)
    return True


def atomic_write_text(path: str | os.PathLike[str], text: str) -> bool:
    return atomic_write_bytes(path, text.encode("utf-8"))


def atomic_write_json(path: str | os.PathLike[str], data: object) -> bool:
    return atomic_write_text(path, json.dumps(data, indent=2, ensure_ascii=True) + "\n")


def atomic_read_text(path: str | os.PathLike[str]) -> str:
    path = Path(path)
    if not resolve_read(path).is_file():
        raise FileNotFoundError(errno.ENOENT, os.strerror(errno.ENOENT), str(path))
    with file_lock(path):
        return resolve_read(path).read_text(encoding="utf-8")


def atomic_read_json(path: str | os.PathLike[str]) -> object:
    return json.loads(atomic_read_text(path))
