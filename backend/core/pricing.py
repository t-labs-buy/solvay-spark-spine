"""What a run's tokens cost at Anthropic's list prices, for the Admin dashboard.

An estimate, and on the high side, for two reasons the run tables cannot
correct:

  * Each agent records input tokens as one number -- uncached, cache reads and
    cache writes together (see `_billed_input` in the agents) -- so all of it is
    priced here at the full input rate. Cache reads are billed at a tenth of
    that, so a run that cached heavily is over-counted.
  * Only the tokens a run table records are priced. The scope guard, the Ragas
    judge on each Ask answer, Hindsight's memory calls and the embeddings are
    separate calls that no run row carries.

The real bill is in the Anthropic Console, and per trace in Langfuse.

Prices are USD per million tokens, first-party Claude API rates. A model not
listed here is reported as unpriced rather than guessed at.
"""

from __future__ import annotations

# model id -> (input, output) USD per million tokens
PRICES: dict[str, tuple[float, float]] = {
    "claude-fable-5-1": (10.00, 50.00),
    "claude-fable-5": (10.00, 50.00),
    "claude-opus-5-5": (4.00, 20.00),
    "claude-opus-5": (5.00, 25.00),
    "claude-opus-4-8": (5.00, 25.00),
    "claude-opus-4-7": (5.00, 25.00),
    "claude-opus-4-6": (5.00, 25.00),
    "claude-sonnet-5-5": (2.00, 10.00),
    "claude-sonnet-5": (2.00, 10.00),
    "claude-sonnet-4-6": (3.00, 15.00),
    "claude-haiku-4-5": (1.00, 5.00),
}


def price(model: str | None) -> tuple[float, float] | None:
    """(input, output) per million tokens, or None for a model not listed.

    Matches a dated or provider-prefixed id too ("anthropic.claude-opus-5",
    "claude-haiku-4-5-20251001") by its longest listed stem."""
    if not model:
        return None
    m = model.strip().lower().removeprefix("anthropic.")
    if m in PRICES:
        return PRICES[m]
    for stem in sorted(PRICES, key=len, reverse=True):
        if m.startswith(stem + "-") or m.startswith(stem + "@"):
            return PRICES[stem]
    return None


def cost(model: str | None, input_tokens: int, output_tokens: int) -> float | None:
    """USD for these tokens on this model, or None if the model has no price."""
    p = price(model)
    if p is None:
        return None
    return (input_tokens * p[0] + output_tokens * p[1]) / 1_000_000
