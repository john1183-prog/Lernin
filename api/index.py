# api/index.py
# Single FastAPI app = single Vercel Function (Python runtime). Stateless:
# no DB connection, no persisted state server-side — cards live in the
# client's IndexedDB. This endpoint's only job is text -> validated JSON.
#
# NOTE ON THE LLM CALL: Anthropic has a native "structured outputs" feature
# (the `output_format` parameter) that constrains generation to a JSON
# schema at the token level. I didn't find an unambiguous, stable example
# of its exact request shape to copy verbatim, so rather than guess at a
# parameter format, I've used the older, extensively documented
# "forced tool use" pattern instead (tools=[...], tool_choice={"type":
# "tool", "name": ...}) — this has been stable in the Anthropic API for a
# long time and is guaranteed to work. If you want to switch to native
# structured outputs later, that's a change scoped to `_call_llm()` only —
# nothing else in this file needs to know which method produced the JSON.

import os
import json
import re
import time
from collections import defaultdict, deque
from typing import Literal, Optional

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, ValidationError
import anthropic

app = FastAPI()

client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))

MODEL = "claude-sonnet-4-6"
MAX_RETRIES = 3
CHUNK_CHAR_LIMIT = 12000  # rough char budget per chunk, not a token-exact split

# ---------------------------------------------------------------------------
# Rate limiting
#
# Chosen approach: in-memory, per-Function-instance sliding-window counter,
# NOT Vercel KV. Reasoning: Vercel Functions on the Python runtime are
# effectively single-instance-per-active-request-burst in practice for a
# low-to-moderate traffic app like this one, and adding a KV dependency
# (extra env vars, an external network call on every single request, a new
# failure mode if KV is briefly unavailable) is not worth it for a v1 whose
# whole design principle elsewhere in this file is "stateless, no external
# dependencies beyond the LLM call itself." The tradeoff being accepted: this
# limiter resets if the underlying Function instance is recycled, and does
# NOT share state across concurrent cold-started instances. If this endpoint
# ever needs to be strict/abuse-proof rather than just a sane default guard,
# swap this dict for Vercel KV (`in .set/.incr` per IP with a TTL) — nothing
# else in this file needs to change, since callers only see the 429.
# ---------------------------------------------------------------------------

RATE_LIMIT_PER_MINUTE = 5
RATE_LIMIT_PER_HOUR = 30

# ip -> deque of request timestamps (epoch seconds), pruned on each check.
_request_log: dict[str, deque] = defaultdict(deque)


def _check_rate_limit(client_ip: str) -> None:
    now = time.time()
    log = _request_log[client_ip]

    # Drop anything older than an hour; everything still in the deque after
    # this is within the last hour, so counting entries newer than 60s covers
    # the per-minute check too.
    while log and now - log[0] > 3600:
        log.popleft()

    requests_last_hour = len(log)
    requests_last_minute = sum(1 for t in log if now - t <= 60)

    if requests_last_minute >= RATE_LIMIT_PER_MINUTE:
        raise HTTPException(
            status_code=429,
            detail=f"Rate limit exceeded: max {RATE_LIMIT_PER_MINUTE} requests per minute. Please wait and try again."
        )
    if requests_last_hour >= RATE_LIMIT_PER_HOUR:
        raise HTTPException(
            status_code=429,
            detail=f"Rate limit exceeded: max {RATE_LIMIT_PER_HOUR} requests per hour. Please wait and try again."
        )

    log.append(now)


def _client_ip(request: Request) -> str:
    # Vercel (and most proxies in front of it) set X-Forwarded-For; fall back
    # to the direct connection if it's ever absent (e.g. local dev).
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


# ---------------------------------------------------------------------------
# Request size limit
# ---------------------------------------------------------------------------

MAX_TEXT_CHARS = 200_000  # generous bound; chunk_text() has no upper bound on
                          # total chunk count per request otherwise

# ---------------------------------------------------------------------------
# Schema — this is the contract the client's saveNewCards()/commitGeneratedCards()
# expect. Keep in sync with db.js's card shape (front, back, type).
# ---------------------------------------------------------------------------

class Card(BaseModel):
    front: str
    back: str
    type: Literal["basic", "cloze"]

class CardBatch(BaseModel):
    cards: list[Card]

class GenerateRequest(BaseModel):
    text: str
    deck_id: str

class GenerateResponse(BaseModel):
    cards: list[Card]

GENERATE_CARDS_TOOL = {
    "name": "submit_cards",
    "description": "Submit the generated flashcards.",
    "input_schema": {
        "type": "object",
        "properties": {
            "cards": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "front": {"type": "string"},
                        "back": {"type": "string"},
                        "type": {"type": "string", "enum": ["basic", "cloze"]}
                    },
                    "required": ["front", "back", "type"]
                }
            }
        },
        "required": ["cards"]
    }
}

SYSTEM_PROMPT = """You write flashcards from source text for spaced repetition study.

Rules:
- Minimum information principle: each card tests one atomic fact. No compound
  questions ("What is X and why does Y happen" is two cards, not one).
- Answers must be unambiguous — a grader could mark it right/wrong with no
  judgment call.
- Prefer cloze deletion ("type": "cloze") for definitions and lists, where the
  front contains {{c1::the answer}} inline. Use "basic" Q&A for everything else.
- Do not invent facts not present in the source text.
- Skip trivial or non-testable content (headers, page numbers, filler).
- Call submit_cards exactly once with the full set of cards for this text."""


# ---------------------------------------------------------------------------
# Chunking
# ---------------------------------------------------------------------------

def chunk_text(text: str, limit: int = CHUNK_CHAR_LIMIT) -> list[str]:
    """Splits on paragraph boundaries, packing chunks up to `limit` chars.
    Never splits mid-sentence where avoidable."""
    paragraphs = re.split(r"\n\s*\n", text.strip())
    chunks: list[str] = []
    current = ""

    for para in paragraphs:
        if len(current) + len(para) + 2 <= limit:
            current = f"{current}\n\n{para}" if current else para
        else:
            if current:
                chunks.append(current)
            # A single paragraph longer than the limit gets hard-split as a
            # last resort — rare, but must not crash on a wall-of-text PDF.
            if len(para) > limit:
                for i in range(0, len(para), limit):
                    chunks.append(para[i:i + limit])
                current = ""
            else:
                current = para

    if current:
        chunks.append(current)

    return chunks


# ---------------------------------------------------------------------------
# LLM call + validation/retry
# ---------------------------------------------------------------------------

def _call_llm(chunk: str) -> dict:
    response = client.messages.create(
        model=MODEL,
        max_tokens=4096,
        system=SYSTEM_PROMPT,
        tools=[GENERATE_CARDS_TOOL],
        tool_choice={"type": "tool", "name": "submit_cards"},
        messages=[{"role": "user", "content": chunk}]
    )

    for block in response.content:
        if block.type == "tool_use" and block.name == "submit_cards":
            return block.input

    raise ValueError("Model did not return a submit_cards tool call")


def generate_cards_for_chunk(chunk: str) -> list[Card]:
    """Calls the LLM and validates the result, retrying on malformed output.
    Malformed responses are NEVER passed through to the client — this
    function either returns a validated card list or raises after
    exhausting retries."""
    last_error: Optional[Exception] = None

    for attempt in range(MAX_RETRIES):
        try:
            raw = _call_llm(chunk)
            batch = CardBatch.model_validate(raw)
            return batch.cards
        except (ValidationError, ValueError, json.JSONDecodeError) as e:
            last_error = e
            continue

    raise HTTPException(
        status_code=502,
        detail=f"Card generation failed validation after {MAX_RETRIES} attempts: {last_error}"
    )


# ---------------------------------------------------------------------------
# Route
# ---------------------------------------------------------------------------

@app.post("/api/generate-cards", response_model=GenerateResponse)
async def generate_cards(req: GenerateRequest, request: Request):
    _check_rate_limit(_client_ip(request))

    if not req.text or not req.text.strip():
        raise HTTPException(status_code=400, detail="text must not be empty")

    if len(req.text) > MAX_TEXT_CHARS:
        raise HTTPException(
            status_code=413,
            detail=f"text exceeds the {MAX_TEXT_CHARS}-character limit ({len(req.text)} chars submitted)."
        )

    chunks = chunk_text(req.text)
    all_cards: list[Card] = []

    for chunk in chunks:
        all_cards.extend(generate_cards_for_chunk(chunk))

    return GenerateResponse(cards=all_cards)


@app.get("/api/health")
async def health():
    return {"status": "ok"}
