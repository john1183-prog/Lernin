"""Schema for the document mind map (Mind Map v2) -- a static, per-document
topic tree generated from a document's actual structure, not derived from
flashcards. Mirrors motion_schema.py's split: Pydantic models here are for
internal validation (self-referencing, arbitrary depth in principle), while
MIND_MAP_SCRIPT_SCHEMA below is a separate, hand-rolled raw JSON-schema dict
actually handed to Claude's tool-calling / Gemini's responseSchema.

That split is deliberate, not just copied out of habit. motion_schema.py's
own history has a real, previously-shipped bug where an assumption about
Gemini's structured-output support (protobuf-backed, not general JSON
Schema) turned out wrong on a live call -- unions for "type" silently
failed. The same caution applies here to an even less-tested feature:
Gemini's responseSchema has never been confirmed (from this sandbox,
generativelanguage.googleapis.com isn't reachable) to support a
self-referencing $ref the way Claude's tool schema comfortably would, and
protobuf messages are not naturally infinitely recursive. Rather than
gambling on that, MIND_MAP_SCRIPT_SCHEMA is written as four explicit,
non-recursive nesting levels (root -> L1 -> L2 -> leaf) with the leaf level
simply having no "children" property at all -- this is valid in both
Claude's schema and Gemini's, unconditionally, because there's no
self-reference anywhere in it. The internal Pydantic TopicNode model is
still genuinely recursive (Python has no such restriction) and enforces
the same 4-level cap via a validator, so a script built by hand or by
manual-mode paste-back that happens to go deeper than the generation
schema allows is still caught, not silently accepted by one path and
rejected by the other.
"""

from typing import List, Optional
from pydantic import BaseModel, Field, model_validator

NODE_TITLE_MAX = 80
NODE_DETAIL_MAX = 240
MIN_TOTAL_NODES = 3
MAX_TOTAL_NODES = 40
MAX_DEPTH = 4  # root counts as depth 1, so this allows 3 further nested levels


class TopicNode(BaseModel):
    title: str = Field(min_length=1, max_length=NODE_TITLE_MAX)
    detail: Optional[str] = Field(default=None, max_length=NODE_DETAIL_MAX)
    children: List["TopicNode"] = Field(default_factory=list)


def _count_nodes(node: TopicNode) -> int:
    return 1 + sum(_count_nodes(c) for c in node.children)


def _max_depth(node: TopicNode) -> int:
    if not node.children:
        return 1
    return 1 + max(_max_depth(c) for c in node.children)


class MindMapScript(BaseModel):
    root: TopicNode

    @model_validator(mode="after")
    def _check_bounds(self):
        count = _count_nodes(self.root)
        if not (MIN_TOTAL_NODES <= count <= MAX_TOTAL_NODES):
            raise ValueError(
                f"Total nodes must be between {MIN_TOTAL_NODES} and {MAX_TOTAL_NODES}, got {count}"
            )
        depth = _max_depth(self.root)
        if depth > MAX_DEPTH:
            raise ValueError(
                f"Tree is {depth} levels deep (root counts as depth 1), max is {MAX_DEPTH}"
            )
        return self


# --- Raw JSON-schema dict, handed to Claude tool-calling / Gemini responseSchema. ---
# Deliberately NOT derived from TopicNode.model_json_schema() -- see module
# docstring for why this is unrolled into explicit levels rather than a
# recursive $ref. "nullable"/"required" conventions match motion_schema.py's
# MOTION_SCRIPT_SCHEMA exactly: Optional[X] scalar fields get "nullable":
# True alongside "type"; array fields with a default (like "children" here)
# are plain "type": "array" and simply omitted from "required" rather than
# marked nullable, since an empty/omitted array and a present-but-empty one
# are equivalent here.

_LEAF_SCHEMA = {
    "type": "object",
    "description": "Deepest level in this tree -- no further nesting below it.",
    "properties": {
        "title": {"type": "string", "description": f"Short, up to {NODE_TITLE_MAX} chars."},
        "detail": {"type": "string", "nullable": True, "description": f"Optional, 1 short sentence, up to {NODE_DETAIL_MAX} chars."},
    },
    "required": ["title"],
}

_L2_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string", "description": f"Short, up to {NODE_TITLE_MAX} chars."},
        "detail": {"type": "string", "nullable": True, "description": f"Optional, 1 short sentence, up to {NODE_DETAIL_MAX} chars."},
        "children": {"type": "array", "items": _LEAF_SCHEMA},
    },
    "required": ["title"],
}

_L1_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string", "description": f"Short, up to {NODE_TITLE_MAX} chars."},
        "detail": {"type": "string", "nullable": True, "description": f"Optional, 1 short sentence, up to {NODE_DETAIL_MAX} chars."},
        "children": {"type": "array", "items": _L2_SCHEMA},
    },
    "required": ["title"],
}

MIND_MAP_SCRIPT_SCHEMA = {
    "type": "object",
    "properties": {
        "root": {
            "type": "object",
            "description": "The mind map's single central node -- the document's main subject as a whole.",
            "properties": {
                "title": {"type": "string", "description": f"Short, up to {NODE_TITLE_MAX} chars."},
                "detail": {"type": "string", "nullable": True, "description": f"Optional, 1 short sentence, up to {NODE_DETAIL_MAX} chars."},
                "children": {"type": "array", "items": _L1_SCHEMA},
            },
            "required": ["title"],
        },
    },
    "required": ["root"],
}
