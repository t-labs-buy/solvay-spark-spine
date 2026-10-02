"""Langfuse tracing for the three agents and the RAG pipeline.

Optional by construction. With no `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY`
in the environment every function here returns a null object that accepts every
call and does nothing, so the call sites need no `if tracing:` branches and the
application behaves exactly as it did before. That matters more than usual
here: this is a local single-user tool that has to keep working on a machine
with no Langfuse account and no network.

What gets traced, and why this shape:

  - One trace per *run* -- a Fit-to-Standard analysis, a Fit-Gap run, one
    investigation, one question to the corpus. A run is the self-contained
    unit of work a user starts and waits for, which is what Langfuse asks a
    trace to be.
  - Under it, one `agent` observation per pass or per BPML step, and one
    `retriever` / `tool` observation per tool call, so a slow run can be read
    as "which step" rather than "somewhere in nine minutes".
  - The model calls themselves are not instrumented here at all. The
    OpenTelemetry Anthropic instrumentor wraps both `messages.create` and
    `messages.stream` and records model, prompt, completion and token usage on
    its own, which is both less code and more detail than anything written by
    hand -- and it means a new call site is traced the day it is added.

The parenting is explicit rather than contextual, and that is the one design
decision worth knowing about. OpenTelemetry nests by an ambient context held
in a context variable; this application runs its agents on worker threads and
streams the result out of a generator that Starlette iterates in a thread
pool, so the ambient context at any given moment belongs to whichever thread
happens to be pumping the generator. Instead of relying on it, `start_run`
creates the root observation manually and `Run.step` opens each child *from
that object*, inside the worker thread that does the work. The child is made
current for that thread, which is all the Anthropic instrumentor needs to file
its generations in the right place.
"""

from __future__ import annotations

import atexit
import contextvars
import logging
import os
import re
import threading
from contextlib import contextmanager
from pathlib import Path

from backend.core.paths import ROOT
from typing import Any, Iterator

from dotenv import load_dotenv

# Langfuse reads its credentials when the client is first constructed, so .env
# has to be on os.environ before that happens -- the one ordering mistake that
# produces a client authenticated with nothing. rag.py loads the same file;
# load_dotenv is idempotent and override=False keeps a real shell variable
# winning over the file either way.
load_dotenv(ROOT / ".env", override=False)

logger = logging.getLogger(__name__)

# Tracing is on when both keys are present. A half-configured environment is
# treated as off rather than as an error: the alternative is a local run that
# refuses to start because of an observability tool.
ENABLED = bool(os.environ.get("LANGFUSE_PUBLIC_KEY") and os.environ.get("LANGFUSE_SECRET_KEY"))

# Which Langfuse environment these traces belong to. Defaults to development
# because that is what a checkout on someone's laptop is; run.sh or the shell
# can say otherwise.
ENVIRONMENT = os.environ.get("LANGFUSE_TRACING_ENVIRONMENT", "development")

_client = None
_started = False
# The first call can come from any of the worker threads the orchestrators
# start. Without this, a second thread arriving while the first is still
# building the client would see `_started` already true, get None back, and
# quietly drop that observation.
_lock = threading.Lock()


# --- masking ------------------------------------------------------------------
# Applied at export, to the raw OpenTelemetry attributes, so it also covers the
# spans the Anthropic instrumentor creates -- which carry whole prompts, and
# therefore whole excerpts of the corpus.
#
# Deliberately narrow. The documents this tool reads are the point of the
# trace: masking them would leave an observability record that cannot answer
# the question it exists for. What is masked is what is never legitimately
# part of an analysis: credentials that leak through an error message or a
# copied config, and the personal contact details that SOPs are full of.

_SECRETS = re.compile(
    r"""(
        sk-ant-[A-Za-z0-9_-]{8,}      # Anthropic
      | (?:pk|sk)-lf-[A-Za-z0-9-]{8,}  # Langfuse itself
      | postgres(?:ql)?://[^\s:]+:[^\s@]+@   # a DSN carrying a password
      | \b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b  # JWT
    )""",
    re.VERBOSE,
)
_EMAIL = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b")


def _redact(text: str) -> str:
    out = _SECRETS.sub("[REDACTED]", text)
    return _EMAIL.sub("[EMAIL]", out)


def _mask_otel_spans(*, params):
    """Redact credentials and email addresses on the way out.

    Runs on the exporter's batch thread, so it stays a couple of regex passes
    over the string attributes and nothing more; anything slower here backs up
    the export queue."""
    from langfuse.types import MaskOtelSpansResult, OtelSpanPatch

    patches = {}
    for identifier, span in params.spans.items():
        replacements = {}
        for key, value in span.attributes.items():
            if isinstance(value, str) and value:
                masked = _redact(value)
                if masked != value:
                    replacements[key] = masked
        if replacements:
            patches[identifier] = OtelSpanPatch(set_attributes=replacements)
    return MaskOtelSpansResult(span_patches=patches)


# --- client -------------------------------------------------------------------


def client():
    """The Langfuse client, or None when tracing is off.

    Built on first use rather than at import so that importing this module --
    which app.py does at startup -- never opens a network connection on a
    machine that has no Langfuse."""
    global _client, _started
    if not ENABLED or _started:
        return _client
    with _lock:
        if _started:  # built while this thread waited for the lock
            return _client
        try:
            from langfuse import Langfuse

            _client = Langfuse(
                environment=ENVIRONMENT,
                release=os.environ.get("LANGFUSE_RELEASE") or None,
                mask_otel_spans=_mask_otel_spans,
            )
            _instrument()
            atexit.register(shutdown)
            logger.info("Langfuse tracing enabled (environment=%s)", ENVIRONMENT)
        except Exception as exc:  # an observability tool may not break the tool
            logger.warning("Langfuse tracing is configured but failed to start: %s", exc)
            _client = None
        finally:
            _started = True
    return _client


def _instrument() -> None:
    """Patch the Anthropic SDK, and make context follow worker threads.

    Both instrumentors refuse a second call, which would otherwise happen
    under `uvicorn --reload`; the exception is caught rather than guarded
    against because the state that would have to be guarded lives inside
    them."""
    from opentelemetry.instrumentation.anthropic import AnthropicInstrumentor
    from opentelemetry.instrumentation.threading import ThreadingInstrumentor

    for instrumentor in (AnthropicInstrumentor(), ThreadingInstrumentor()):
        try:
            instrumentor.instrument()
        except Exception as exc:
            logger.debug("%s was already instrumented: %s", type(instrumentor).__name__, exc)


def start() -> str:
    """Build the client at server start-up and say, in one line, what happened.

    Worth doing eagerly in the server: the credentials are checked here rather
    than on the first run, so a typo in .env is a log line at start-up instead
    of a run that finishes with no trace and no explanation. Returns the line
    it logged, for callers that want to show it."""
    if not ENABLED:
        line = ("Langfuse tracing is off: set LANGFUSE_PUBLIC_KEY and "
                "LANGFUSE_SECRET_KEY to turn it on.")
        logger.info(line)
        return line
    lf = client()
    if lf is None:
        return "Langfuse tracing is configured but the client failed to start; see the log."
    try:
        if not lf.auth_check():
            line = "Langfuse rejected these credentials; nothing will be traced."
            logger.warning(line)
            return line
    except Exception as exc:
        line = f"Langfuse could not be reached ({exc}); traces will be dropped."
        logger.warning(line)
        return line
    line = (f"Langfuse tracing is on ({os.environ.get('LANGFUSE_BASE_URL', 'cloud')}, "
            f"environment={ENVIRONMENT}).")
    logger.info(line)
    return line


def flush() -> None:
    """Send what is queued. Worth calling at the end of a run: a run is minutes
    long and the trace is of no use to someone watching it if it arrives on the
    batch timer several minutes after they went looking."""
    if _client is not None:
        try:
            _client.flush()
        except Exception as exc:
            logger.debug("Langfuse flush failed: %s", exc)


def shutdown() -> None:
    global _client
    if _client is not None:
        try:
            _client.shutdown()
        except Exception as exc:
            logger.debug("Langfuse shutdown failed: %s", exc)
        _client = None


# --- the null object ----------------------------------------------------------


class _Null:
    """Accepts everything a span accepts and records nothing.

    So that a call site reads the same whether or not tracing is configured.
    `update` and `end` return self so chained use is safe too."""

    def update(self, **_kw) -> "_Null":
        return self

    def end(self, **_kw) -> "_Null":
        return self

    def score(self, *_a, **_kw) -> "_Null":
        return self

    def start_observation(self, **_kw) -> "_Null":
        return self

    @contextmanager
    def start_as_current_observation(self, **_kw) -> Iterator["_Null"]:
        yield self


NULL = _Null()


# --- the public surface -------------------------------------------------------


class Run:
    """One traced run, and the attributes every observation in it carries.

    Holds the root observation plus the run's correlating attributes
    (`session_id`, `user_id`, tags, metadata). In the Langfuse v4 data model
    those attributes live on every observation rather than on the trace, and
    they are applied by a context manager that works off the ambient context
    -- so `step` re-enters it on whichever thread the step runs on. Keeping
    them on this object is what makes that reliable across the thread hand-offs
    the orchestrators make."""

    def __init__(self, span: Any, attrs: dict[str, Any]):
        self._span = span
        self._attrs = attrs

    def __bool__(self) -> bool:
        return self._span is not None

    @property
    def trace_id(self) -> str:
        if self._span is None:
            return ""
        try:
            return self._span.trace_id
        except Exception:
            return ""

    def url(self) -> str:
        """A link to this trace, for a log line. Empty when tracing is off."""
        if self._span is None:
            return ""
        try:
            return client().get_trace_url(trace_id=self._span.trace_id)
        except Exception:
            return ""

    @contextmanager
    def current(self) -> Iterator[None]:
        """Make the run's observation the current one for this thread, without
        opening a child.

        For the loops that cannot hold a `step` open: `evidence.agent.run` and
        `rag.ask_events` are generators that yield from inside the agent loop,
        and a generator here is resumed by whichever thread Starlette's pool
        hands it, with the context it was suspended in discarded. A `with`
        block spanning a `yield` therefore loses the nesting it was opened for
        -- so instead this is entered and left around each single model call,
        which has no yield inside it, and the generation the Anthropic
        instrumentor creates lands under the run.

        `use_span` is OpenTelemetry's own API and is what the Langfuse client
        itself calls to parent a span explicitly; `_otel_span` is the wrapper's
        internal handle on it, which `test_tracing.py` asserts still exists so
        that an SDK upgrade that renames it fails a test rather than quietly
        detaching every generation into a trace of its own."""
        span = getattr(self._span, "_otel_span", None)
        if span is None:
            yield
            return
        from langfuse import propagate_attributes
        from opentelemetry import trace as otel

        # The attributes as well as the parent. In the v4 data model the
        # session id, tags and environment live on every observation rather
        # than on the trace, so a generation created here without them is a
        # row that no filter over this run will return.
        with otel.use_span(span, end_on_exit=False), propagate_attributes(**self._attrs):
            yield

    @contextmanager
    def step(self, name: str, as_type: str = "span", **kw) -> Iterator[Any]:
        """Open `name` as a child of the run and make it current *for this
        thread*, so model calls made inside it are filed under it."""
        if self._span is None:
            yield NULL
            return
        from langfuse import propagate_attributes

        try:
            with propagate_attributes(**self._attrs):
                with self._span.start_as_current_observation(
                    name=name, as_type=as_type, **kw
                ) as span:
                    yield span
        except Exception as exc:
            logger.debug("Langfuse step %r failed: %s", name, exc)
            yield NULL

    def update(self, **kw) -> None:
        if self._span is not None:
            try:
                self._span.update(**kw)
            except Exception as exc:
                logger.debug("Langfuse update failed: %s", exc)

    def fail(self, exc: BaseException) -> None:
        self.update(level="ERROR", status_message=f"{type(exc).__name__}: {exc}")

    def end(self, **kw) -> None:
        """End the run and push it. Safe to call twice."""
        if self._span is None:
            return
        try:
            self._span.update(**kw)
            self._span.end()
        except Exception as exc:
            logger.debug("Langfuse end failed: %s", exc)
        finally:
            self._span = None
            flush()


# The signed-in account, set by the auth middleware for each request. Read by
# start_run when no user_id is passed, so every trace a request opens carries
# its user without the user being threaded through every agent's signature.
# Context variables follow the request into Starlette's threadpool; a thread
# an agent starts itself does not inherit them, so such a thread passes
# user_id explicitly.
USER: contextvars.ContextVar[str | None] = contextvars.ContextVar("trace_user", default=None)


def start_run(
    name: str,
    *,
    input: Any = None,
    metadata: dict[str, Any] | None = None,
    session_id: str | None = None,
    user_id: str | None = None,
    tags: list[str] | None = None,
    as_type: str = "agent",
) -> Run:
    """Begin a trace for one run. Returns a Run that does nothing when tracing
    is off, so the caller never has to ask whether it is."""
    lf = client()
    if lf is None:
        return Run(None, {})

    attrs: dict[str, Any] = {"trace_name": name}
    user_id = user_id or USER.get()
    if session_id:
        attrs["session_id"] = session_id
    if user_id:
        attrs["user_id"] = user_id
    if tags:
        attrs["tags"] = [t for t in tags if t]
    if metadata:
        attrs["metadata"] = metadata
    try:
        from langfuse import propagate_attributes

        # Entered around the creation so the root observation carries the
        # attributes too; children re-enter it on their own threads.
        with propagate_attributes(**attrs):
            span = lf.start_observation(
                name=name, as_type=as_type, input=input, metadata=metadata
            )
        return Run(span, attrs)
    except Exception as exc:
        logger.debug("Langfuse start_run %r failed: %s", name, exc)
        return Run(None, {})


@contextmanager
def observation(name: str, as_type: str = "span", **kw) -> Iterator[Any]:
    """A child of whatever observation is current on this thread.

    For work that already runs inside a `Run.step` -- a tool call inside an
    agent pass -- where the ambient context is correct and passing the parent
    down through the call stack would be noise."""
    lf = client()
    if lf is None:
        yield NULL
        return
    try:
        with lf.start_as_current_observation(name=name, as_type=as_type, **kw) as span:
            yield span
    except Exception as exc:
        logger.debug("Langfuse observation %r failed: %s", name, exc)
        yield NULL


def status() -> dict[str, Any]:
    """For /api/*/status, so the UI can say whether runs are being traced."""
    return {
        "enabled": ENABLED,
        "environment": ENVIRONMENT if ENABLED else "",
        "host": os.environ.get("LANGFUSE_BASE_URL", "") if ENABLED else "",
    }
