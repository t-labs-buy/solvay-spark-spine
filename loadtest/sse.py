"""Time a server-sent-events endpoint the way a person feels it.

Locust stops its clock when the response headers arrive, which for a stream is
almost immediately and says nothing. Here the body is read to the end and two
rows are reported instead: `<name> ttfe` (time to the first event) and
`<name> total` (time to `done`, or whichever event ends that endpoint). An
`error` event, a stream that ends without its last event, or a non-200 status
fails both.
"""

from __future__ import annotations

import json
import time


def _events(response):
    """(event, data) for each event in the body, as it arrives."""
    event, data = "message", []
    for raw in response.iter_lines(decode_unicode=True):
        if raw is None:
            continue
        if raw == "":
            if data:
                yield event, "\n".join(data)
            event, data = "message", []
        elif raw.startswith("event:"):
            event = raw[6:].strip()
        elif raw.startswith("data:"):
            data.append(raw[5:].lstrip())
    if data:
        yield event, "\n".join(data)


def post_stream(user, path: str, payload: dict, name: str, timeout: float = 600,
                done_events: tuple[str, ...] = ("done",), read_to_end: bool = False) -> dict:
    """POST `payload` to `path`, read the stream to its end, report the timings.

    The run counts as finished at the first of `done_events`. With
    `read_to_end`, reading goes on until the server closes the stream, for an
    endpoint that still sends something after its answer (Evidence sends its
    scores) -- closing early would cut that work off.

    Returns {"events": n, "kinds": {event: count}, "error": str | None}."""
    fire = user.environment.events.request.fire
    start = time.perf_counter()
    first = None
    kinds: dict[str, int] = {}
    size = 0
    error = None
    done = False

    try:
        with user.client.post(path, json=payload, stream=True, timeout=timeout,
                              headers={"Accept": "text/event-stream"},
                              name=f"{name} headers", catch_response=True) as response:
            if response.status_code != 200:
                error = f"HTTP {response.status_code}: {response.text[:200]}"
                response.failure(error)
            else:
                response.success()
                for event, data in _events(response):
                    if first is None:
                        first = time.perf_counter()
                    size += len(data)
                    kinds[event] = kinds.get(event, 0) + 1
                    if event == "error":
                        try:
                            error = json.loads(data).get("message") or data
                        except ValueError:
                            error = data
                        break
                    if event in done_events and not done:
                        done = True
                        if not read_to_end:
                            break
                if error is None and not done:
                    error = "stream ended without a done event"
    except Exception as exc:  # connection reset, read timeout
        error = f"{type(exc).__name__}: {exc}"

    end = time.perf_counter()
    exc = Exception(error) if error else None
    if first is not None:
        fire(request_type="SSE", name=f"{name} ttfe", response_time=(first - start) * 1000,
             response_length=0, exception=exc, context={})
    fire(request_type="SSE", name=f"{name} total", response_time=(end - start) * 1000,
         response_length=size, exception=exc, context={})
    return {"events": sum(kinds.values()), "kinds": kinds, "error": error}
