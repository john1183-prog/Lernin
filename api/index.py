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
import httpx

app = FastAPI()

# Server-side default key (optional) — set ANTHROPIC_API_KEY in the Vercel
# project's env vars if you want the app to work out of the box without
# every user bringing their own key. If unset, every request must supply
# its own key via Settings in the UI (see _resolve_credentials() below).
DEFAULT_ANTHROPIC_KEY = os.environ.get("ANTHROPIC_API_KEY")

CLAUDE_MODEL = "claude-sonnet-4-6"
GEMINI_MODEL = "gemini-flash-latest"  # Google's auto-updated GA alias
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
# Provider/key resolution
#
# The client (api.js) sends X-LLM-Provider + X-LLM-Api-Key when the user has
# configured their own key in Settings (see db.js's getApiConfig()). Neither
# header is required: with nothing set, Claude + DEFAULT_ANTHROPIC_KEY is
# used as before, so the app keeps working out of the box if the deployer
# set ANTHROPIC_API_KEY. There's currently no server-side default for
# Gemini — a user selecting Gemini in Settings must supply their own key.
#
# The key is read from a header, used for exactly one outbound call to the
# provider, and never written to logs, disk, or any persistent store here —
# this function is the only place it's handled.
# ---------------------------------------------------------------------------

def _resolve_credentials(request: Request) -> tuple[str, str]:
    provider = request.headers.get("x-llm-provider", "claude").strip().lower()
    user_key = request.headers.get("x-llm-api-key", "").strip()

    if provider not in ("claude", "gemini"):
        raise HTTPException(status_code=400, detail=f"Unknown provider '{provider}'. Use 'claude' or 'gemini'.")

    if user_key:
        return provider, user_key

    if provider == "claude" and DEFAULT_ANTHROPIC_KEY:
        return provider, DEFAULT_ANTHROPIC_KEY

    raise HTTPException(
        status_code=400,
        detail=(
            f"No {provider.capitalize()} API key available. Add your own key in Settings, "
            "or ask the app's deployer to configure a default key."
        )
    )


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

# Gemini's `generateContent` supports native schema-constrained JSON output
# (responseSchema + responseMimeType: "application/json") — unlike the
# Anthropic path above, this is stable/documented, so it's used directly
# rather than a tool-call workaround. Same shape as GENERATE_CARDS_TOOL's
# input_schema, just without the outer tool-call wrapper.
GEMINI_RESPONSE_SCHEMA = {
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

def _call_claude(chunk: str, api_key: str) -> dict:
    # A fresh client per call, not a module-level singleton, since the key
    # now varies per-request (the user's own key, or DEFAULT_ANTHROPIC_KEY).
    # anthropic.Anthropic() is cheap to construct — no connection is opened
    # until .messages.create() is actually called.
    client = anthropic.Anthropic(api_key=api_key)
    response = client.messages.create(
        model=CLAUDE_MODEL,
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


def _call_gemini(chunk: str, api_key: str) -> dict:
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"
    payload = {
        "system_instruction": {"parts": [{"text": SYSTEM_PROMPT}]},
        "contents": [{"role": "user", "parts": [{"text": chunk}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": GEMINI_RESPONSE_SCHEMA
        }
    }

    with httpx.Client(timeout=60.0) as http:
        response = http.post(url, params={"key": api_key}, json=payload)

    if response.status_code in (400, 401, 403):
        # Almost always a bad/missing key or a permissions issue on the
        # caller's Google account — surface this immediately rather than
        # burning retries on something that won't change on a second try.
        raise _AuthError(f"Gemini rejected the request (HTTP {response.status_code}): {response.text[:300]}")

    response.raise_for_status()
    data = response.json()

    try:
        text = data["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError) as e:
        raise ValueError(f"Unexpected Gemini response shape: {data}") from e

    return json.loads(text)


class _AuthError(Exception):
    """Raised for provider-reported auth/permission failures — these should
    fail the request immediately instead of being retried, since a bad key
    doesn't become valid on attempt 2 or 3."""
    pass


def generate_cards_for_chunk(chunk: str, provider: str, api_key: str) -> list[Card]:
    """Calls the LLM and validates the result, retrying on malformed output.
    Malformed responses are NEVER passed through to the client — this
    function either returns a validated card list or raises after
    exhausting retries. Auth errors (bad/missing key) raise immediately
    without retrying, since a bad key doesn't fix itself on attempt 2."""
    last_error: Optional[Exception] = None

    for attempt in range(MAX_RETRIES):
        try:
            if provider == "gemini":
                raw = _call_gemini(chunk, api_key)
            else:
                raw = _call_claude(chunk, api_key)
            batch = CardBatch.model_validate(raw)
            return batch.cards
        except _AuthError as e:
            raise HTTPException(status_code=401, detail=str(e))
        except anthropic.AuthenticationError as e:
            raise HTTPException(status_code=401, detail=f"Anthropic rejected the API key: {e}")
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
    provider, api_key = _resolve_credentials(request)

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
        all_cards.extend(generate_cards_for_chunk(chunk, provider, api_key))

    return GenerateResponse(cards=all_cards)


@app.get("/api/health")
async def health():
    return {"status": "ok"}
