"""A stand-in for the Anthropic Messages API, so load tests cost nothing.

    ../.venv/bin/uvicorn mock_anthropic:app --port 8099
    # then start the app with
    ANTHROPIC_BASE_URL=http://localhost:8099 ANTHROPIC_API_KEY=mock RAG_EVAL_SAMPLE=0 ...

It answers POST /v1/messages after a delay that looks like Claude's:

  * a forced tool call (the scope guard's `verdict`) gets that tool with
    {"category": "in_scope"}, so questions are let through;
  * `stream: true` (the Ask answer) gets a streamed text answer;
  * anything else gets a plain text answer that ends the turn.

That is enough for Ask and Cypher generation. The Fit-Gap, Evidence and
Rollout agents expect particular tool calls and will stop early or report an
error against it -- they need the real API, at one or two users.

MOCK_FIRST_TOKEN_MS (default 800) and MOCK_TOKENS_PER_SEC (default 60) set the
pace; MOCK_ANSWER_TOKENS (default 300) the length.
"""

from __future__ import annotations

import asyncio
import json
import os
import uuid

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

FIRST_MS = float(os.environ.get("MOCK_FIRST_TOKEN_MS", "800"))
TOKENS_PER_SEC = float(os.environ.get("MOCK_TOKENS_PER_SEC", "60"))
ANSWER_TOKENS = int(os.environ.get("MOCK_ANSWER_TOKENS", "300"))

WORDS = ("The process is described in the programme documents [1]. Each step is owned by "
         "the business and checked against the standard SAP flow [2]. ").split()

app = FastAPI()


def _usage(out: int) -> dict:
    return {"input_tokens": 1500, "output_tokens": out,
            "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}


def _message(model: str, content: list, stop: str, out: int) -> dict:
    return {"id": f"msg_mock_{uuid.uuid4().hex[:12]}", "type": "message", "role": "assistant",
            "model": model, "content": content, "stop_reason": stop, "stop_sequence": None,
            "usage": _usage(out)}


def _words(n: int) -> list[str]:
    return [WORDS[i % len(WORDS)] + " " for i in range(n)]


@app.post("/v1/messages")
async def messages(request: Request):
    body = await request.json()
    model = body.get("model", "mock")
    choice = body.get("tool_choice") or {}

    if choice.get("type") == "tool":
        await asyncio.sleep(FIRST_MS / 1000)
        block = {"type": "tool_use", "id": f"toolu_mock_{uuid.uuid4().hex[:12]}",
                 "name": choice["name"],
                 "input": {"category": "in_scope", "reason": "mock classifier"}}
        return JSONResponse(_message(model, [block], "tool_use", 20))

    if not body.get("stream"):
        await asyncio.sleep(FIRST_MS / 1000 + ANSWER_TOKENS / TOKENS_PER_SEC)
        text = "".join(_words(ANSWER_TOKENS)).strip()
        return JSONResponse(_message(model, [{"type": "text", "text": text}], "end_turn",
                                     ANSWER_TOKENS))

    async def stream():
        def ev(name: str, data: dict) -> str:
            return f"event: {name}\ndata: {json.dumps({'type': name, **data})}\n\n"

        yield ev("message_start", {"message": _message(model, [], None, 1)})
        await asyncio.sleep(FIRST_MS / 1000)
        yield ev("content_block_start", {"index": 0, "content_block": {"type": "text", "text": ""}})
        for word in _words(ANSWER_TOKENS):
            yield ev("content_block_delta", {"index": 0,
                                             "delta": {"type": "text_delta", "text": word}})
            await asyncio.sleep(1 / TOKENS_PER_SEC)
        yield ev("content_block_stop", {"index": 0})
        yield ev("message_delta", {"delta": {"stop_reason": "end_turn", "stop_sequence": None},
                                   "usage": {"output_tokens": ANSWER_TOKENS}})
        yield ev("message_stop", {})

    return StreamingResponse(stream(), media_type="text/event-stream")
