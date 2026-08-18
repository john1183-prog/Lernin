from fastapi import FastAPI, Request, HTTPException, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, ValidationError
from typing import List, Optional
import os
import sys
import json
import base64
import logging
import httpx
import anthropic

# Vercel's runtime (_vendor/vercel_runtime/vc_init.py) loads this file
# dynamically via importlib.import_module() rather than running it as a
# script -- so unlike a normal `python3 index.py` invocation, this file's
# own directory is NOT automatically added to sys.path. Sibling local
# imports (motion_schema, motion_engine) fail to resolve without this,
# even though the files themselves are present in the deployed bundle.
# This was the actual cause of the "ModuleNotFoundError: No module named
# 'motion_schema'" seen in production -- an explicit includeFiles glob in
# vercel.json (tried first) controls what's *bundled*, not what's on
# sys.path, so it didn't touch the real problem. Confirmed locally that
# this doesn't change behavior when run normally (this directory is
# already on sys.path in that case; insert() with a duplicate is a no-op
# in practice), so this is safe for both environments.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from motion_schema import MotionScript, MOTION_SCRIPT_SCHEMA
from motion_engine import expand_script, MotionEngineError

logger = logging.getLogger("lernin.motion")

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------- Rate limiting ----------
from collections import defaultdict
import time

_rate_limit = defaultdict(list)
RATE_LIMIT_WINDOW = 60
RATE_LIMIT_MAX = 10

def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    if request.client:
        return request.client.host
    return "unknown"

def _check_rate_limit(ip: str):
    now = time.time()
    window = _rate_limit[ip]
    while window and window[0] < now - RATE_LIMIT_WINDOW:
        window.pop(0)
    if len(window) >= RATE_LIMIT_MAX:
        raise HTTPException(status_code=429, detail="Rate limit exceeded. Try again in a minute.")
    window.append(now)

# ---------- Models ----------
class CardVariable(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    symbol: Optional[str] = None
    meaning: Optional[str] = None

class Card(BaseModel):
    front: str = Field(..., min_length=1)
    back: str = Field(..., min_length=1)
    type: str = Field(default="basic", pattern="^(basic|cloze|formula)$")
    formula: Optional[str] = None
    variables: Optional[List[CardVariable]] = None
    assumptions: Optional[str] = None
    commonMistakes: Optional[str] = None
    applications: Optional[str] = None

class CardBatch(BaseModel):
    summary: str = Field(..., min_length=1)
    cards: List[Card] = Field(..., min_length=1)

class GenerateResponse(BaseModel):
    cards: List[Card]
    summary: str

# ---------- Prompts & Tools ----------
SYSTEM_PROMPT = (
    "You are a flashcard generator. Extract key concepts from the user's document "
    "and return ONLY a valid JSON object matching the submit_cards tool schema. "
    "Do not wrap the JSON in markdown fences. Do not add commentary."
)

CLAUDE_MODEL = os.environ.get("CLAUDE_MODEL", "claude-3-5-sonnet-20241022")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.6-flash")

GENERATE_CARDS_TOOL = {
    "name": "submit_cards",
    "description": "Submit generated flashcards",
    "input_schema": {
        "type": "object",
        "properties": {
            "summary": {"type": "string", "description": "1-2 sentence summary of the document"},
            "cards": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "front": {"type": "string"},
                        "back": {"type": "string"},
                        "type": {"type": "string", "enum": ["basic", "cloze", "formula"]},
                        "formula": {"type": ["string", "null"]},
                        "variables": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "name": {"type": ["string", "null"]},
                                    "description": {"type": ["string", "null"]},
                                    "symbol": {"type": ["string", "null"]},
                                    "meaning": {"type": ["string", "null"]},
                                },
                            },
                        },
                        "assumptions": {"type": ["string", "null"]},
                        "commonMistakes": {"type": ["string", "null"]},
                        "applications": {"type": ["string", "null"]},
                    },
                    "required": ["front", "back", "type"],
                },
            },
        },
        "required": ["summary", "cards"],
    },
}

GEMINI_RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "cards": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "front": {"type": "string"},
                    "back": {"type": "string"},
                    "type": {"type": "string", "enum": ["basic", "cloze", "formula"]},
                    "formula": {"type": "string", "nullable": True},
                    "variables": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "name": {"type": "string", "nullable": True},
                                "description": {"type": "string", "nullable": True},
                                "symbol": {"type": "string", "nullable": True},
                                "meaning": {"type": "string", "nullable": True},
                            },
                        },
                    },
                    "assumptions": {"type": "string", "nullable": True},
                    "commonMistakes": {"type": "string", "nullable": True},
                    "applications": {"type": "string", "nullable": True},
                },
                "required": ["front", "back", "type"],
            },
        },
    },
    "required": ["summary", "cards"],
}

# ---------- Helpers ----------
def _resolve_credentials(request: Request):
    provider = request.headers.get("x-llm-provider", "claude").lower()
    api_key = request.headers.get("x-llm-api-key", "")
    if not api_key:
        raise HTTPException(status_code=401, detail="Missing X-LLM-Api-Key header")
    if provider not in ("claude", "gemini"):
        raise HTTPException(status_code=400, detail="Unsupported provider. Use 'claude' or 'gemini'.")
    return provider, api_key

def _call_claude(text: str, provider: str, api_key: str):
    client = anthropic.Anthropic(api_key=api_key)
    response = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=4096,
        system=SYSTEM_PROMPT,
        tools=[GENERATE_CARDS_TOOL],
        tool_choice={"type": "tool", "name": "submit_cards"},
        messages=[{"role": "user", "content": text}],
    )
    for block in response.content:
        if block.type == "tool_use" and block.name == "submit_cards":
            batch = CardBatch.model_validate(block.input)
            return batch.cards, batch.summary
    raise ValueError("Model did not return a submit_cards tool call")

def _call_gemini(text: str, provider: str, api_key: str):
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"
    payload = {
        "system_instruction": {"parts": [{"text": SYSTEM_PROMPT}]},
        "contents": [
            {
                "role": "user",
                "parts": [{"text": text}],
            }
        ],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": GEMINI_RESPONSE_SCHEMA,
        },
    }
    with httpx.Client(timeout=120.0) as http:
        response = http.post(url, params={"key": api_key}, json=payload)
        response.raise_for_status()
        data = response.json()
        text = data["candidates"][0]["content"]["parts"][0]["text"]
        parsed = json.loads(text)
        batch = CardBatch.model_validate(parsed)
        return batch.cards, batch.summary

def _extract_shape_text(shape, texts):
    """Recursively pull text out of a shape: plain text frames, tables
    (cell by cell), and grouped shapes (which don't expose .text
    directly — python-pptx nests their children under .shapes)."""
    try:
        if shape.shape_type == 6:  # MSO_SHAPE_TYPE.GROUP
            for child in shape.shapes:
                _extract_shape_text(child, texts)
            return
    except Exception:
        pass

    if getattr(shape, "has_table", False):
        try:
            for row in shape.table.rows:
                cells = [c.text for c in row.cells if c.text]
                if cells:
                    texts.append(" | ".join(cells))
        except Exception:
            pass
        return

    if hasattr(shape, "text") and shape.text:
        texts.append(shape.text)

def _extract_ppt_text(content: bytes) -> str:
    try:
        from pptx import Presentation
        from io import BytesIO
        prs = Presentation(BytesIO(content))
        texts = []
        for slide in prs.slides:
            for shape in slide.shapes:
                _extract_shape_text(shape, texts)
            if slide.has_notes_slide:
                notes = slide.notes_slide.notes_text_frame.text
                if notes and notes.strip():
                    texts.append(f"[Speaker notes: {notes.strip()}]")
        return "\n\n".join(texts)
    except Exception:
        return ""

def _call_claude_vision(base64_data: str, mime_type: str, provider: str, api_key: str):
    client = anthropic.Anthropic(api_key=api_key)

    if mime_type == "application/pdf":
        content_blocks = [
            {
                "type": "document",
                "source": {
                    "type": "base64",
                    "media_type": "application/pdf",
                    "data": base64_data
                }
            },
            {
                "type": "text",
                "text": "Generate flashcards from this document."
            }
        ]
    else:
        content_blocks = [
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": mime_type,
                    "data": base64_data
                }
            },
            {
                "type": "text",
                "text": "Generate flashcards from this image."
            }
        ]

    response = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=4096,
        system=SYSTEM_PROMPT,
        tools=[GENERATE_CARDS_TOOL],
        tool_choice={"type": "tool", "name": "submit_cards"},
        messages=[{"role": "user", "content": content_blocks}]
    )

    for block in response.content:
        if block.type == "tool_use" and block.name == "submit_cards":
            batch = CardBatch.model_validate(block.input)
            return batch.cards, batch.summary
    raise ValueError("Model did not return a submit_cards tool call")

def _call_gemini_vision(base64_data: str, mime_type: str, provider: str, api_key: str):
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"
    payload = {
        "system_instruction": {"parts": [{"text": SYSTEM_PROMPT}]},
        "contents": [{
            "role": "user",
            "parts": [
                {
                    "inline_data": {
                        "mime_type": mime_type,
                        "data": base64_data
                    }
                },
                {"text": "Generate flashcards from this document."}
            ]
        }],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": GEMINI_RESPONSE_SCHEMA
        }
    }
    with httpx.Client(timeout=120.0) as http:
        response = http.post(url, params={"key": api_key}, json=payload)
        response.raise_for_status()
        data = response.json()
        text = data["candidates"][0]["content"]["parts"][0]["text"]
        parsed = json.loads(text)
        batch = CardBatch.model_validate(parsed)
        return batch.cards, batch.summary

# ---------- Motion Studio ----------
# Same relay shape as card generation above (tool-calling for Claude,
# responseSchema for Gemini) — the model never writes free-text DSL, it
# fills in MOTION_SCRIPT_SCHEMA directly. See motion_schema.py for the
# schema itself and motion_engine.py for what happens to its output
# after Pydantic validates it. Nothing here is ever sent to the frontend
# except the fully resolved script that expand_script() returns.

# Fully worked example on an unrelated topic, shared between the API system
# prompt below and the manual-mode prompt in build_motion_manual_prompt() --
# deliberately demonstrates the non-obvious mechanics in one place:
# marker-driven pacing, a layer that persists with no second opacity point,
# two layers timing their exit to a NEGATIVE offset from the next marker (so
# the fade finishes exactly as the next beat starts), a layer with two
# independent keyframe tracks at once, the emphasis shorthand needing no
# manual keyframes/x/y/fontSize, and a camera move synced to the same
# markers as the content. Content validated end to end
# (MotionScript.model_validate + expand_script) before landing here -- an
# example that doesn't itself pass the schema it's demonstrating would be
# worse than no example at all.
_MOTION_EXAMPLE_JSON = """{
  "scene": {"name": "Newton's Second Law", "duration": 16, "fps": 30, "background": "#161616", "width": 800, "height": 500},
  "markers": [
    {"name": "setup", "time": 2.5},
    {"name": "reveal", "time": 8.0},
    {"name": "conclusion", "time": 13.0}
  ],
  "camera": {
    "keyframes": [
      {"property": "zoom", "points": [
        {"time": {"marker": "setup", "offset": 0}, "value": 1.0, "easing": "easeInOut"},
        {"time": {"marker": "reveal", "offset": 0}, "value": 1.25, "easing": "easeInOut"},
        {"time": {"marker": "conclusion", "offset": 0}, "value": 1.0, "easing": "easeInOut"}
      ]}
    ]
  },
  "layers": [
    {
      "name": "header", "type": "text", "text": "Newton's Second Law",
      "x": 90, "y": 36, "fontSize": 20, "color": "#8b95a5",
      "keyframes": [
        {"property": "opacity", "points": [
          {"time": {"offset": 0}, "value": 0},
          {"time": {"offset": 0.6}, "value": 1, "easing": "easeOut"}
        ]}
      ]
    },
    {
      "name": "force_arrow", "type": "arrow",
      "x": 190, "y": 250, "x2": 310, "y2": 250, "color": "#e8a33d", "strokeWidth": 5,
      "keyframes": [
        {"property": "opacity", "points": [
          {"time": {"marker": "setup", "offset": 0}, "value": 0},
          {"time": {"marker": "setup", "offset": 0.4}, "value": 1, "easing": "easeOut"},
          {"time": {"marker": "reveal", "offset": -0.4}, "value": 1},
          {"time": {"marker": "reveal", "offset": 0}, "value": 0, "easing": "easeIn"}
        ]}
      ]
    },
    {
      "name": "setup_caption", "type": "caption", "text": "A force acts on an object with mass",
      "x": 400, "y": 310, "fontSize": 22, "color": "#ffffff",
      "keyframes": [
        {"property": "opacity", "points": [
          {"time": {"marker": "setup", "offset": 0}, "value": 0},
          {"time": {"marker": "setup", "offset": 0.4}, "value": 1, "easing": "easeOut"},
          {"time": {"marker": "reveal", "offset": -0.4}, "value": 1},
          {"time": {"marker": "reveal", "offset": 0}, "value": 0, "easing": "easeIn"}
        ]}
      ]
    },
    {
      "name": "formula", "type": "text", "text": "F = ma", "format": "formula",
      "x": 400, "y": 260, "fontSize": 64, "color": "#ffffff",
      "keyframes": [
        {"property": "opacity", "points": [
          {"time": {"marker": "reveal", "offset": 0}, "value": 0},
          {"time": {"marker": "reveal", "offset": 0.5}, "value": 1, "easing": "easeOut"},
          {"time": {"marker": "conclusion", "offset": -0.4}, "value": 1},
          {"time": {"marker": "conclusion", "offset": 0}, "value": 0, "easing": "easeIn"}
        ]},
        {"property": "scale", "points": [
          {"time": {"marker": "reveal", "offset": 0}, "value": 0.85},
          {"time": {"marker": "reveal", "offset": 0.5}, "value": 1, "easing": "easeOut"}
        ]}
      ]
    },
    {
      "name": "formula_emphasis", "type": "emphasis", "text": "Directly proportional!",
      "at": {"marker": "reveal", "offset": 1.2}, "hold": 2.5,
      "style": "pop", "size": "medium", "slot": "lower", "color": "#f2c14e"
    },
    {
      "name": "closing_caption", "type": "caption",
      "text": "Double the force means double the acceleration, for the same mass.",
      "x": 400, "y": 420, "fontSize": 26, "color": "#ffffff",
      "keyframes": [
        {"property": "opacity", "points": [
          {"time": {"marker": "conclusion", "offset": 0}, "value": 0},
          {"time": {"marker": "conclusion", "offset": 0.5}, "value": 1, "easing": "easeOut"}
        ]}
      ]
    }
  ]
}"""

MOTION_SYSTEM_PROMPT = (
    "You create short, clear motion-graphics scripts that explain a single "
    "study concept, returned ONLY as a valid instance of the submit_motion_script "
    "tool schema. Keep scenes tight: 8-45 seconds is typical for one concept. "
    "Scene width/height must be 200-1920 pixels (800x500 is a good default); "
    "fps must be 15-60 (30 is a good default). "
    "Use markers for the beats of your explanation (e.g. 'setup', 'reveal', "
    "'conclusion') and reference them from keyframe times instead of raw "
    "numbers, so pacing stays legible and easy to adjust. Use the emphasis "
    "layer type for the one or two words that should land hardest, not for "
    "every label -- it animates itself from 'at' and 'style' alone, no "
    "manual keyframes needed. 'at'/'hold'/'style'/'size'/'slot' ONLY work on "
    "type: 'emphasis' -- every other layer type is rejected if it sets any "
    "of them, so any text/caption layer that isn't type 'emphasis' needs its "
    "own explicit 'keyframes' (an opacity track at minimum) to appear at all. "
    "Treat the scene like a sequence of beats, not a pile: when a new beat "
    "starts, fade out or otherwise hide the layers from the previous beat "
    "(an opacity keyframe back to 0 is enough) unless something is "
    "deliberately meant to persist as shared context throughout (e.g. a "
    "title or a background element). A script where everything that's ever "
    "appeared is still on screen at the end is a bug, not a feature -- aim "
    "for roughly 2-4 layers visible at any single moment, not the whole cast. "
    "Set format to 'formula' only for actual mathematical notation, valid "
    "KaTeX/LaTeX -- never for plain words.\n\n"
    "Below is a fully worked example on an unrelated topic (Newton's Second "
    "Law) -- study it for the PACING and MECHANICS, not the subject matter, "
    "which has nothing to do with whatever concept you're actually asked to "
    "explain. The fences below are for readability in this instruction "
    "only; your own output must not use them.\n\n"
    "```\n" + _MOTION_EXAMPLE_JSON + "\n```\n\n"
    "A few things worth noticing there: 'header' gets a fade-in and no "
    "second opacity point, so it just holds at full opacity for the rest of "
    "the scene -- that's the entire mechanism for a deliberately persistent "
    "layer, no special flag needed. 'force_arrow' and 'setup_caption' both "
    "time their fade-out to a NEGATIVE offset from the 'reveal' marker "
    "({\"marker\": \"reveal\", \"offset\": -0.4}), so they finish "
    "disappearing exactly as the next beat starts instead of guessing an "
    "absolute time. 'formula' carries two independent keyframe tracks at "
    "once (opacity and scale) for a slightly more dynamic entrance -- a "
    "layer isn't limited to one track. 'formula_emphasis' sets only "
    "text/at/hold/style/size/slot/color -- no 'keyframes', no manual "
    "x/y/fontSize -- because the emphasis shorthand computes all of that "
    "itself. The camera's 'zoom' track ramps in on the same 'reveal' "
    "marker the formula appears on and eases back out on 'conclusion', so "
    "the camera move reinforces the beat structure rather than running on "
    "its own timeline. At no point are more than 3-4 of the 6 total layers "
    "visible together.\n\n"
    "Do not wrap your own output in markdown fences. Do not add commentary."
)

GENERATE_MOTION_TOOL = {
    "name": "submit_motion_script",
    "description": "Submit a motion-graphics script for a study explainer.",
    "input_schema": MOTION_SCRIPT_SCHEMA,
}

def _format_validation_error(e: ValidationError) -> str:
    """Pydantic's bare error message ('Input should be less than or
    equal to 1920') doesn't say which field -- width and height share
    that exact bound, so on its own the message is ambiguous. Prefix
    with the dotted field path from e.errors()[0]['loc']."""
    first = e.errors()[0]
    path = ".".join(str(p) for p in first["loc"])
    return f"{path}: {first['msg']}" if path else first["msg"]


def build_motion_manual_prompt(topic: str) -> str:
    """The plain-text prompt for manual mode: no tool-calling exists when
    a person pastes into a generic AI chat tab, so the shape has to be
    spelled out in the prompt itself. Frontend surfaces this verbatim for
    copying; kept here as the single source of truth for now. Shares
    _MOTION_EXAMPLE_JSON with MOTION_SYSTEM_PROMPT above rather than
    keeping a second, separately-maintained example -- see that constant's
    comment for what it deliberately demonstrates."""
    return (
        f"Create a short motion-graphics script explaining: {topic}\n\n"
        "Respond with ONLY a JSON object (no markdown fences, no commentary) "
        "shaped like this fully worked example. The topic below (Newton's "
        "Second Law) is unrelated to yours -- match its PACING and "
        "MECHANICS, not its subject matter:\n\n"
        + _MOTION_EXAMPLE_JSON +
        "\n\n"
        "Rules:\n"
        "- layer \"type\" must be one of: rect, circle, text, polygon, arrow, line, group, caption, emphasis\n"
        "- keyframe \"property\" must be one of: x, y, scale, rotation, opacity, color\n"
        "- \"time\" is either {\"marker\": \"name\", \"offset\": seconds-after-it} "
        "or {\"offset\": seconds} for an absolute time (omit marker)\n"
        "- \"offset\" can be negative to land a moment BEFORE a marker, e.g. "
        "{\"marker\": \"reveal\", \"offset\": -0.4} -- handy for timing a "
        "fade-out to finish exactly as the next beat begins (see "
        "\"force_arrow\" and \"setup_caption\" above)\n"
        "- \"easing\" is one of: linear, easeIn, easeOut, easeInOut, bounce, elastic, back\n"
        "- an \"emphasis\" layer needs \"at\" (a time object) and \"style\" "
        "(pop, slideup, fade, or zoom) -- no manual keyframes needed for it, "
        "and no manual \"x\"/\"y\"/\"fontSize\" either (see \"formula_emphasis\" "
        "above) -- it positions and sizes itself from \"size\"/\"slot\"\n"
        "- \"at\"/\"hold\"/\"style\"/\"size\"/\"slot\" ONLY work on an \"emphasis\" "
        "layer -- setting any of them on any other type is rejected, and that "
        "other layer needs its own \"keyframes\" (an opacity track at least) "
        "to appear at all\n"
        "- a layer can carry more than one keyframe track at once (see "
        "\"formula\" above, which animates both \"opacity\" and \"scale\") "
        "for a richer entrance or exit\n"
        "- treat the scene as a sequence of beats, not a pile: when a new "
        "beat starts, fade out the previous beat's layers (an opacity "
        "keyframe back to 0) unless something is deliberately meant to "
        "persist throughout (e.g. \"header\" above, which fades in once and "
        "is simply never given a second opacity point). Don't leave "
        "everything that's ever appeared still on screen at the end -- aim "
        "for roughly 2-4 layers visible at once, not the whole cast\n"
        "- set \"format\": \"formula\" only for real mathematical notation "
        "(valid KaTeX/LaTeX) on a text/caption/emphasis layer, never for plain words\n"
        "- keep duration reasonable, 8-45 seconds for one concept\n"
        "- scene \"width\"/\"height\" must be 200-1920 pixels (800x500 is a good "
        "default); \"fps\" must be 15-60 (30 is a good default)\n"
        "- 1-40 layers, unique names"
    )

# TEMPORARY: in-memory, same limitation as _rate_limit above -- this dict
# does not survive a cold start and is not shared across concurrent
# function instances, so it's a soft speed bump, not an enforced cap.
# Fine for now while there's no real traffic; needs a real persistent
# counter (Vercel Marketplace -> Upstash Redis is the natural fit, since
# Vercel KV itself was sunset) before the server key is trusted with any
# real volume. Swapping it in only touches the two functions below.
_motion_quota = defaultdict(int)
MOTION_FREE_LIMIT = int(os.environ.get("MOTION_FREE_LIMIT", "3"))

def _check_and_increment_motion_quota(client_id: str):
    if _motion_quota[client_id] >= MOTION_FREE_LIMIT:
        raise HTTPException(
            status_code=402,
            detail=(
                f"You've used your {MOTION_FREE_LIMIT} free Motion Studio generations. "
                "Add a Claude or Gemini key in Settings to keep going."
            ),
        )
    _motion_quota[client_id] += 1

def _resolve_motion_credentials(request: Request):
    """BYOK header present -> use it, no quota touched, costs the server
    nothing. Otherwise -> fall back to Lernin's own key, gated by the
    free-generation quota. Returns (provider, api_key, used_server_key)."""
    provider = request.headers.get("x-llm-provider", "").lower()
    api_key = request.headers.get("x-llm-api-key", "")
    if api_key:
        if provider not in ("claude", "gemini"):
            raise HTTPException(status_code=400, detail="Unsupported provider. Use 'claude' or 'gemini'.")
        return provider, api_key, False

    server_key = os.environ.get("MOTION_SERVER_CLAUDE_KEY", "")
    if not server_key:
        raise HTTPException(
            status_code=401,
            detail="Add a Claude or Gemini key in Settings to use Motion Studio.",
        )
    client_id = request.headers.get("x-client-id", "")
    if not client_id:
        raise HTTPException(status_code=400, detail="Missing X-Client-Id header.")
    _check_and_increment_motion_quota(client_id)
    return "claude", server_key, True

def _call_claude_motion(topic: str, api_key: str, retry_note: str = None) -> MotionScript:
    client = anthropic.Anthropic(api_key=api_key)
    user_text = f"Explain: {topic}"
    if retry_note:
        user_text += (
            f"\n\n(A previous attempt at this failed: {retry_note} "
            f"Please avoid that mistake this time.)"
        )
    response = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=8192,
        system=MOTION_SYSTEM_PROMPT,
        tools=[GENERATE_MOTION_TOOL],
        tool_choice={"type": "tool", "name": "submit_motion_script"},
        messages=[{"role": "user", "content": user_text}],
    )
    for block in response.content:
        if block.type == "tool_use" and block.name == "submit_motion_script":
            return MotionScript.model_validate(block.input)
    raise ValueError("Model did not return a submit_motion_script tool call")

def _call_gemini_motion(topic: str, api_key: str, retry_note: str = None) -> MotionScript:
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"
    user_text = f"Explain: {topic}"
    if retry_note:
        user_text += (
            f"\n\n(A previous attempt at this failed: {retry_note} "
            f"Please avoid that mistake this time.)"
        )
    payload = {
        "system_instruction": {"parts": [{"text": MOTION_SYSTEM_PROMPT}]},
        "contents": [{"role": "user", "parts": [{"text": user_text}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": MOTION_SCRIPT_SCHEMA,
            # Unset before: Claude gets an explicit max_tokens=8192, Gemini
            # was silently relying on whatever its own default budget is.
            # A rich multi-layer script in this schema's fairly verbose
            # JSON shape can plausibly exceed a smaller default, and when
            # that happens Gemini's structured-output mode can close the
            # JSON out gracefully enough to still pass json.loads() and
            # even schema validation -- while being almost entirely empty
            # (confirmed: a real response came back as one layer with
            # every type-specific field null, syntactically valid,
            # completely useless). Matching Claude's budget here.
            "maxOutputTokens": 8192,
        },
    }
    with httpx.Client(timeout=120.0) as http:
        response = http.post(url, params={"key": api_key}, json=payload)
        response.raise_for_status()
        data = response.json()
        candidate = data["candidates"][0]
        finish_reason = candidate.get("finishReason")
        if finish_reason not in ("STOP", None):
            raise GeminiIncompleteError(finish_reason)
        text = candidate["content"]["parts"][0]["text"]
        parsed = json.loads(text)
        return MotionScript.model_validate(parsed)


class GeminiIncompleteError(Exception):
    """Gemini's response didn't finish normally -- most commonly
    MAX_TOKENS (ran out of output budget mid-generation, see the comment
    above _call_gemini_motion), but also covers SAFETY/RECITATION/OTHER.
    Distinct from a plain generation failure so the caller can give a
    specific, honest message instead of a generic parse error."""

    def __init__(self, finish_reason):
        self.finish_reason = finish_reason
        super().__init__(f"Gemini response did not finish normally: {finish_reason}")

class GenerateMotionResponse(BaseModel):
    script: Optional[dict] = None
    retryable: bool = False
    error: Optional[str] = None

# ---------- Endpoints ----------
@app.post("/api/generate-cards", response_model=GenerateResponse)
async def generate_cards(request: Request):
    _check_rate_limit(_client_ip(request))
    provider, api_key = _resolve_credentials(request)

    body = await request.json()
    text = body.get("text", "")
    if not text or len(text.strip()) < 10:
        raise HTTPException(status_code=400, detail="Text too short or missing.")

    try:
        if provider == "claude":
            cards, summary = _call_claude(text, provider, api_key)
        else:
            cards, summary = _call_gemini(text, provider, api_key)
    except anthropic.AuthenticationError:
        raise HTTPException(status_code=401, detail="Invalid Claude API key.")
    except anthropic.RateLimitError:
        raise HTTPException(status_code=429, detail="Claude rate limit hit. Wait a moment and retry.")
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=502, detail=f"Gemini error: {e.response.status_code}")
    except Exception:
        # Never send internal details to clients.
        raise HTTPException(
            status_code=500,
            detail="Card generation failed. Please try again."
        )

    return GenerateResponse(cards=cards, summary=summary)

@app.post("/api/generate-cards-vision", response_model=GenerateResponse)
async def generate_cards_vision(
    request: Request,
    file: UploadFile = File(...),
    deck_id: str = Form(...)
):
    _check_rate_limit(_client_ip(request))
    provider, api_key = _resolve_credentials(request)

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="No file uploaded")

    if len(content) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="File too large. Max 20MB.")

    mime_type = file.content_type or "application/octet-stream"
    filename = file.filename or "upload"
    ext = filename.split('.')[-1].lower() if '.' in filename else ''

    # For PowerPoint: text extraction only (a .pptx is not an image)
    if ext in ('ppt', 'pptx'):
        text = _extract_ppt_text(content)
        if text and len(text.strip()) > 50:
            try:
                if provider == "claude":
                    cards, summary = _call_claude(text, provider, api_key)
                else:
                    cards, summary = _call_gemini(text, provider, api_key)
                return GenerateResponse(cards=cards, summary=summary)
            except anthropic.AuthenticationError:
                raise HTTPException(status_code=401, detail="Invalid Claude API key.")
            except anthropic.RateLimitError:
                raise HTTPException(status_code=429, detail="Claude rate limit hit. Wait a moment and retry.")
            except httpx.HTTPStatusError as e:
                raise HTTPException(status_code=502, detail=f"Gemini error: {e.response.status_code}")
            except Exception:
                raise HTTPException(
                    status_code=500,
                    detail="Card generation failed. Please try again."
                )
        raise HTTPException(
            status_code=400,
            detail="Could not extract text from this PowerPoint. Use the manual paste flow, or export slides as PDF/images."
        )

    # For images and PDFs, use vision API
    allowed_mimes = {
        'application/pdf',
        'image/jpeg',
        'image/png',
        'image/jpg',
        'image/webp',
    }
    allowed_exts = {'pdf', 'jpg', 'jpeg', 'png', 'webp'}
    if mime_type not in allowed_mimes and ext not in allowed_exts:
        raise HTTPException(
            status_code=400,
            detail="Unsupported file type. Use PDF, JPG, or PNG — or the manual paste flow."
        )

    base64_data = base64.b64encode(content).decode('utf-8')

    try:
        if provider == "claude":
            cards, summary = _call_claude_vision(base64_data, mime_type, provider, api_key)
        else:
            cards, summary = _call_gemini_vision(base64_data, mime_type, provider, api_key)
    except anthropic.AuthenticationError:
        raise HTTPException(status_code=401, detail="Invalid Claude API key.")
    except anthropic.RateLimitError:
        raise HTTPException(status_code=429, detail="Claude rate limit hit. Wait a moment and retry.")
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=502, detail=f"Gemini error: {e.response.status_code}")
    except Exception:
        # Never send internal details to clients.
        raise HTTPException(
            status_code=500,
            detail="Card generation failed. Please try again."
        )

    return GenerateResponse(cards=cards, summary=summary)

class ExtractTextResponse(BaseModel):
    text: str

@app.post("/api/extract-ppt-text", response_model=ExtractTextResponse)
async def extract_ppt_text(request: Request, file: UploadFile = File(...)):
    """
    Text-only extraction for PowerPoint files — no LLM call, no API key
    required. Exists so manual (non-BYOK) users get the same pre-filled
    prompt experience BYOK users get, matching how PDF text extraction
    already runs client-side for everyone regardless of BYOK status.
    Rate-limited like the generation endpoints since it's still unauthenticated.
    """
    _check_rate_limit(_client_ip(request))

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="No file uploaded")
    if len(content) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="File too large. Max 20MB.")

    filename = file.filename or "upload"
    ext = filename.split('.')[-1].lower() if '.' in filename else ''
    if ext not in ('ppt', 'pptx'):
        raise HTTPException(status_code=400, detail="This endpoint only extracts PowerPoint files.")

    text = _extract_ppt_text(content)
    return ExtractTextResponse(text=text)

@app.post("/api/generate-motion", response_model=GenerateMotionResponse)
async def generate_motion(request: Request):
    try:
        _check_rate_limit(_client_ip(request))

        body = await request.json()
        topic = body.get("topic", "")
        if not topic or len(topic.strip()) < 3:
            raise HTTPException(status_code=400, detail="Topic too short or missing.")

        # Credentials (and any quota spend) resolved only after the topic is
        # known to be valid — a request that was always going to fail
        # shouldn't cost someone one of their free generations. This used
        # to sit outside the try/except entirely, so a bug in here would
        # crash with no detail message at all -- see the outer except below.
        provider, api_key, _used_server_key = _resolve_motion_credentials(request)

        # A non-empty retry_of_error means the frontend is making a
        # user-confirmed retry after a previous attempt's model output
        # failed validation/completion -- see build_motion_manual_prompt's
        # sibling functions below. Not a loop: one retry per user
        # confirmation, driven entirely by the frontend re-calling this
        # same endpoint, not by anything automatic here.
        retry_note = body.get("retry_of_error") or None
        if retry_note:
            logger.info(f"Motion retry attempted: provider={provider} topic={topic!r}")

        try:
            if provider == "claude":
                motion_script = _call_claude_motion(topic, api_key, retry_note)
            else:
                motion_script = _call_gemini_motion(topic, api_key, retry_note)
        except anthropic.AuthenticationError:
            raise HTTPException(status_code=401, detail="Invalid Claude API key.")
        except anthropic.RateLimitError:
            raise HTTPException(status_code=429, detail="Claude rate limit hit. Wait a moment and retry.")
        except httpx.HTTPStatusError as e:
            raise HTTPException(status_code=502, detail=f"Gemini error: {e.response.status_code} — {e.response.text[:300]}")
        except GeminiIncompleteError as e:
            error = (
                f"Gemini's response didn't finish (reason: {e.finish_reason}) -- "
                f"likely ran out of output budget mid-script. Ask for something "
                f"more concise (fewer layers) and try again."
            )
            logger.info(f"Motion retry-eligible failure: provider={provider} topic={topic!r} error={error!r}")
            return GenerateMotionResponse(retryable=True, error=error)
        except ValidationError as e:
            error = f"The model's script didn't match the expected shape: {_format_validation_error(e)}"
            logger.info(f"Motion retry-eligible failure: provider={provider} topic={topic!r} error={error!r}")
            return GenerateMotionResponse(retryable=True, error=error)
        except ValueError as e:
            # Currently only Claude's "didn't return a tool call" case.
            error = str(e)
            logger.info(f"Motion retry-eligible failure: provider={provider} topic={topic!r} error={error!r}")
            return GenerateMotionResponse(retryable=True, error=error)

        try:
            resolved = expand_script(motion_script)
        except MotionEngineError as e:
            error = f"Generated script has a timing issue: {e}"
            logger.info(f"Motion retry-eligible failure: provider={provider} topic={topic!r} error={error!r}")
            return GenerateMotionResponse(retryable=True, error=error)

        return GenerateMotionResponse(script=resolved)

    except HTTPException:
        raise
    except Exception as e:
        # Anything not already translated above lands here — including
        # bugs in credential resolution, which used to be able to crash
        # uncaught. Logged so it's visible in Vercel's Runtime Logs, and
        # the exception itself is included in the response for now since
        # this is still pre-launch/dev-only traffic. TEMPORARY: tighten
        # this to a generic client-facing message (log-only detail) before
        # any real public traffic — see UPCOMING_FEATURES.md.
        logger.exception("generate_motion crashed unexpectedly")
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}")

@app.post("/api/expand-motion-script", response_model=GenerateMotionResponse)
async def expand_motion_script(request: Request):
    """Manual mode lands here: no AI call happens in this route at all —
    the person already ran build_motion_manual_prompt's text in their own
    AI chat and is pasting the JSON back. Same validation, same
    expand_script() call generate_motion uses after its own AI call, so
    both paths converge on identical output from here on."""
    try:
        _check_rate_limit(_client_ip(request))
        body = await request.json()
        try:
            motion_script = MotionScript.model_validate(body)
        except ValidationError as e:
            raise HTTPException(status_code=400, detail=f"That doesn't match the expected shape: {_format_validation_error(e)}")

        try:
            resolved = expand_script(motion_script)
        except MotionEngineError as e:
            raise HTTPException(status_code=400, detail=f"Timing issue: {e}")

        return GenerateMotionResponse(script=resolved)

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("expand_motion_script crashed unexpectedly")
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}")
