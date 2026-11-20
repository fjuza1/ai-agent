#!/usr/bin/env python3
"""Isolated master orchestrator: the single entrypoint that runs every agent.

Stages run strictly one after another, each in its own process, in dependency order:

  1. product_expander_agent.py   candidate Made-in-USA products (unapproved drafts for human review)
  2. daily_catalog_linker.py     Amazon / Alza.sk search links, "Used For" tags and the daily picks
  3. daily_trend_ui_agent.py     data/daily_visual_theme.json only
  4. fleet_runner.py             the 1,000-worker draft fleet, at most 25 jobs in flight
  5. bug_hunter_agent.py         audits the result and updates BUG_REPORT.md

Only one pipeline can run at a time (``data/pipeline.lock``). A failed stage stops the stages
that would build on it, the audit still runs, and the failure is logged in BUG_REPORT.md.

``--dry-run`` rehearses the whole pipeline: every write and lock file goes to a scratch
directory, no model request is made and nothing is pushed, so ``data/`` is left untouched.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
import hashlib
import logging
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

from filelock import Timeout

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from agents import safe_io  # noqa: E402

LOG = logging.getLogger("pipeline")
FLEET_SHUTDOWN_BUFFER_SECONDS = 120
MIN_FLEET_SECONDS = 300
# Time kept back so the closing audit still fits inside the pipeline's overall limit.
AUDIT_RESERVE_SECONDS = 900


@dataclass(frozen=True)
class Stage:
    name: str
    script: str
    timeout: int
    args: tuple[str, ...] = ()
    reservations: bool = False
    always: bool = False


STAGES = (
    Stage("product_expander", "product_expander_agent.py", 600),
    Stage("catalog_linker", "daily_catalog_linker.py", 780, args=("--max-seconds", "600"), reservations=True),
    Stage("trend_ui", "daily_trend_ui_agent.py", 300, reservations=True),
    Stage("fleet", "fleet_runner.py", 7200, reservations=True),
    Stage("bug_hunter", "bug_hunter_agent.py", 1500, always=True),
)
STAGE_NAMES = tuple(stage.name for stage in STAGES)


@dataclass
class Result:
    stage: str
    status: str
    seconds: float = 0.0
    detail: str = ""

    @property
    def failed(self) -> bool:
        return self.status == "failed"


def snapshot(root: Path) -> dict[str, str]:
    """SHA-256 of every file a pipeline may write, used to prove that a dry run changed none of them."""
    files = [root / "BUG_REPORT.md", *sorted((root / "data").glob("*.json"))]
    files += sorted((root / "apps").glob("*/public/og/daily-theme.svg"))
    return {path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest() for path in files if path.is_file()}


def planned_writes(scratch: Path, root: Path) -> list[str]:
    written = []
    for path in sorted(scratch.rglob("*")):
        if not path.is_file() or path.suffix in (".lock", ".tmp"):
            continue
        real = Path(root.anchor).joinpath(*path.relative_to(scratch).parts)
        try:
            written.append(real.relative_to(root).as_posix())
        except ValueError:
            written.append(str(real))
    return written


def stage_command(stage: Stage, *, dry_run: bool, persist: bool, llm_review: bool, fleet_seconds: int) -> list[str]:
    command = [sys.executable, str(ROOT / "agents" / stage.script), *stage.args]
    if stage.name == "fleet":
        command += ["--agents", "1000", "--max-hours", f"{fleet_seconds / 3600:.4f}"]
    if stage.name == "bug_hunter" and llm_review and not dry_run:
        command.append("--llm")
    if stage.reservations and persist and not dry_run:
        command.append("--persist-reservations")
    return command


def run_pipeline(*, scratch: Path | None = None, only: tuple[str, ...] = (), skip: tuple[str, ...] = (), keep_going: bool = False,
                 llm_review: bool = False, persist: bool | None = None, max_minutes: float = 110, fleet_hours: float = 1.0) -> list[Result]:
    """Runs the selected stages sequentially; a ``scratch`` directory makes it a dry run."""
    dry_run = scratch is not None
    deadline = time.monotonic() + max_minutes * 60
    persist = os.environ.get("GITHUB_ACTIONS") == "true" if persist is None else persist
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    env.setdefault("FLEET_SHUTDOWN_BUFFER_SECONDS", str(FLEET_SHUTDOWN_BUFFER_SECONDS))
    if dry_run:
        env[safe_io.DRY_RUN_ENV] = "1"
        env[safe_io.DRY_RUN_DIR_ENV] = str(scratch)
        # Empty rather than unset, so an agent's .env file cannot put the key back.
        env["LLM_API_KEY"] = ""
    selected = [stage for stage in STAGES if (not only or stage.name in only) and stage.name not in skip]
    results: list[Result] = []
    broken = False
    for stage in selected:
        remaining = deadline - time.monotonic()
        if broken and not stage.always and not keep_going:
            results.append(Result(stage.name, "skipped", detail="an earlier stage failed"))
            continue
        timeout = min(stage.timeout, remaining)
        fleet_seconds = 0
        if stage.name == "fleet":
            reserve = AUDIT_RESERVE_SECONDS if any(later.name == "bug_hunter" for later in selected) else 0
            fleet_seconds = int(min(fleet_hours * 3600, remaining - reserve - 60))
            if fleet_seconds < MIN_FLEET_SECONDS:
                results.append(Result(stage.name, "skipped", detail="not enough of the pipeline time limit is left for the fleet"))
                LOG.warning("Skipping fleet: %s.", results[-1].detail)
                continue
            timeout = fleet_seconds + 60
        if timeout < 1:
            results.append(Result(stage.name, "failed", detail="the pipeline time limit was reached before this stage"))
            broken = True
            LOG.error("%s: %s.", stage.name, results[-1].detail)
            continue
        command = stage_command(stage, dry_run=dry_run, persist=persist, llm_review=llm_review, fleet_seconds=fleet_seconds)
        LOG.info("[%d/%d] %s: %s", selected.index(stage) + 1, len(selected), stage.name,
                 " ".join(command[1:]).replace(str(ROOT / "agents") + os.sep, "agents/"))
        started = time.monotonic()
        try:
            code = subprocess.run(command, cwd=ROOT, env=env, timeout=timeout).returncode
            detail = "" if code == 0 else f"exited with code {code}"
        except subprocess.TimeoutExpired:
            code, detail = 1, f"timed out after {int(timeout)} seconds"
        except OSError as error:
            code, detail = 1, f"could not start ({type(error).__name__})"
        results.append(Result(stage.name, "ok" if code == 0 else "failed", round(time.monotonic() - started, 1), detail))
        if code != 0:
            broken = True
            LOG.error("%s %s.", stage.name, detail)
    return results


def summarize(results: list[Result], dry_run: bool, changes: list[str]) -> str:
    lines = [f"### Agent pipeline{' (dry run)' if dry_run else ''}", "", "| Stage | Result | Seconds | Detail |", "|---|---|---|---|"]
    lines += [f"| `{r.stage}` | {r.status} | {r.seconds} | {r.detail} |" for r in results]
    if dry_run:
        lines += ["", "Files a real run would have written: " + (", ".join(f"`{name}`" for name in changes) or "none") + "."]
    return "\n".join(lines) + "\n"


def run_url() -> str:
    server, repository, run_id = (os.environ.get(name, "") for name in ("GITHUB_SERVER_URL", "GITHUB_REPOSITORY", "GITHUB_RUN_ID"))
    return f"{server}/{repository}/actions/runs/{run_id}" if server and repository and run_id else ""


def record_failure(stage: str, detail: str, url: str = "") -> None:
    from agents import bug_hunter_agent
    bug_hunter_agent.record_pipeline_failure(ROOT, stage, detail, url)
    LOG.info("Logged the failed %s stage in BUG_REPORT.md.", stage)


def execute(args: argparse.Namespace) -> int:
    scratch: Path | None = None
    before: dict[str, str] = {}
    previous = {name: os.environ.get(name) for name in (safe_io.DRY_RUN_ENV, safe_io.DRY_RUN_DIR_ENV)}
    if args.dry_run:
        scratch = Path(tempfile.mkdtemp(prefix="agent-dry-run-"))
        os.environ[safe_io.DRY_RUN_ENV] = "1"
        os.environ[safe_io.DRY_RUN_DIR_ENV] = str(scratch)
        before = snapshot(ROOT)
        LOG.info("Dry run: writes go to %s; data/ and BUG_REPORT.md will not be modified.", scratch)
    try:
        try:
            with safe_io.file_lock(ROOT / "data" / "pipeline", timeout=0):
                results = run_pipeline(scratch=scratch, only=tuple(args.only), skip=tuple(args.skip), keep_going=args.keep_going,
                                       llm_review=args.llm_review, max_minutes=args.max_minutes, fleet_hours=args.fleet_hours)
        except Timeout:
            LOG.error("Another agent pipeline is already running (data/pipeline.lock is held); nothing was started.")
            return 2
        failed = [r for r in results if r.failed]
        changes = planned_writes(scratch, ROOT) if scratch else []
        summary = summarize(results, args.dry_run, changes)
        print("\n" + summary)
        if os.environ.get("GITHUB_STEP_SUMMARY"):
            with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as stream:
                stream.write(summary)
        if args.dry_run and snapshot(ROOT) != before:
            LOG.error("Files under data/ or BUG_REPORT.md changed during the dry run (by this run or another process).")
            return 1
        if failed and not args.dry_run:
            record_failure(failed[0].stage, f"{failed[0].stage} {failed[0].detail}; main is left untouched.", run_url())
        return 1 if failed else 0
    finally:
        if scratch:
            for name, value in previous.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value
            if not args.keep_dry_run_output:
                shutil.rmtree(scratch, ignore_errors=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run every agent sequentially, in dependency order, without overlap.")
    parser.add_argument("--dry-run", action="store_true", help="Rehearse the pipeline without modifying data/, spending budget or pushing.")
    parser.add_argument("--keep-dry-run-output", action="store_true", help="Keep the dry run's scratch directory for inspection.")
    parser.add_argument("--only", nargs="+", default=[], choices=STAGE_NAMES, metavar="STAGE", help=f"Run only these stages ({', '.join(STAGE_NAMES)}).")
    parser.add_argument("--skip", nargs="+", default=[], choices=STAGE_NAMES, metavar="STAGE", help="Leave these stages out.")
    parser.add_argument("--keep-going", action="store_true", help="Run later stages even after one failed.")
    parser.add_argument("--llm-review", action="store_true", help="Add the bug hunter's budget-reserved LLM review.")
    parser.add_argument("--max-minutes", type=float, default=110, help="Overall time limit for all stages (default 110).")
    parser.add_argument("--fleet-hours", type=float, default=1.0, help="Upper bound for the fleet stage (default 1.0).")
    parser.add_argument("--record-failure", metavar="STAGE", help="Only log a failed verification gate in BUG_REPORT.md, then exit.")
    parser.add_argument("--detail", default="", help="Text for --record-failure.")
    parser.add_argument("--run-url", default="", help="Workflow run link for --record-failure.")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    if not 1 <= args.max_minutes <= 120 or not 0 < args.fleet_hours <= 2:
        parser.error("--max-minutes must be 1-120 and --fleet-hours greater than 0 and at most 2")
    if args.record_failure:
        record_failure(args.record_failure, args.detail or "verification gate failed; main is left untouched.", args.run_url)
        return 0
    return execute(args)


if __name__ == "__main__":
    sys.exit(main())
