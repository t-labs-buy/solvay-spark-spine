"""Agent runs kept alive past the connection that started them.

InsightLens and the Fit-Gap Copilot each used to be driven by their HTTP
response: the endpoint iterated the orchestrator as it streamed. Two things
followed. Closing the tab left the generator suspended at its last yield, so
the run never finished and there was nothing to reopen. And while the model
spent minutes writing one long turn nothing crossed the wire, so a reverse
proxy with an idle timeout -- the one in front of the deployed app has one --
cut the stream, and the page showed "network error" for a run that was fine.

Here the orchestrator is drained on a thread of its own into an event log.
Every stream -- the one that started the run, a reconnect after a dropped
connection, one opened later from the history -- replays that log from the
start and then follows it, with a keep-alive whenever it has been quiet for
PING_SECONDS. One uvicorn process serves the app, so a module-level registry
is the whole story.
"""
from __future__ import annotations

import threading
import time
from typing import Any, Iterator

# How long a finished run's log is kept for a late reader. After that the
# stored register is what the history opens.
KEEP_SECONDS = 15 * 60
# How often a follower with nothing new wakes up, so the stream can send a
# keep-alive past any proxy that closes idle connections.
PING_SECONDS = 15

PING = "__ping__"

# Keyed by (engine, run id): "fitgap" for InsightLens, "rollout" for the
# Fit-Gap Copilot.
_runs: dict[tuple[str, str], "LiveRun"] = {}
_lock = threading.Lock()


class LiveRun:
    def __init__(self, owner: int | None, stop: threading.Event):
        self.owner = owner
        self.run_id: str | None = None
        self.events: list[tuple[str, Any]] = []
        self.finished_at: float | None = None
        # Read by the orchestrator, which finishes the run early once set.
        self.stop = stop
        self._cond = threading.Condition()

    def _add(self, event: str, data: Any) -> None:
        with self._cond:
            self.events.append((event, data))
            self._cond.notify_all()

    def _finish(self) -> None:
        with self._cond:
            self.finished_at = time.time()
            self._cond.notify_all()

    def follow(self) -> Iterator[tuple[str, Any]]:
        """Every event so far, then each new one as it comes, until the run
        ends. Yields (PING, None) while there is nothing to send."""
        i = 0
        while True:
            with self._cond:
                if i >= len(self.events) and self.finished_at is None:
                    self._cond.wait(timeout=PING_SECONDS)
                batch = self.events[i:]
                finished = self.finished_at is not None
            i += len(batch)
            yield from batch
            if finished and i >= len(self.events):
                return
            if not batch:
                yield PING, None


def start(kind: str, events: Iterator[tuple[str, Any]], owner: int | None,
          stop: threading.Event) -> LiveRun:
    """Drain `events` on a thread of its own and register the run under its
    id once the `scope` event names it. `stop` is the event the generator
    behind `events` watches."""
    _prune()
    live = LiveRun(owner, stop)

    def drain() -> None:
        try:
            for event, data in events:
                if event == "scope" and isinstance(data, dict) and data.get("run_id"):
                    live.run_id = data["run_id"]
                    with _lock:
                        _runs[(kind, live.run_id)] = live
                live._add(event, data)
        except Exception as exc:
            live._add("error", {"message": f"{type(exc).__name__}: {exc}"})
        finally:
            live._finish()

    threading.Thread(target=drain, daemon=True, name=f"{kind}-live").start()
    return live


def get(kind: str, run_id: str, owner: int | None = None) -> LiveRun | None:
    """The live run with this id, if there is one and `owner` may see it.
    `owner` None is an Admin, who may see anyone's."""
    with _lock:
        live = _runs.get((kind, run_id))
    if live is None or (owner is not None and live.owner != owner):
        return None
    return live


def _prune() -> None:
    cutoff = time.time() - KEEP_SECONDS
    with _lock:
        for run_id in [k for k, v in _runs.items() if v.finished_at and v.finished_at < cutoff]:
            del _runs[run_id]
