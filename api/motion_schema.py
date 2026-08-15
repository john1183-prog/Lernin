"""
Lernin — Motion Studio schema.

Defines the "shorthand" JSON an LLM produces (via Claude tool-calling or a
Gemini responseSchema) to describe an educational motion-graphics script,
plus the raw JSON-Schema dict used to constrain that generation.

This carries over the vocabulary of the reference "Grok Motion Studio" DSL
(scene / layer / keyframe / camera / marker / emphasis) but as a JSON shape
instead of a hand-parsed text grammar — Pydantic does the job a lexer and
parser would otherwise do, and does it with a stronger reliability
guarantee than hoping a model writes syntactically valid custom-DSL text.

See motion_engine.py for the step that expands this validated shorthand
into the fully resolved keyframe data the frontend player actually reads.
Nothing in this file, or anything built from it, is ever sent to the
frontend — only motion_engine's resolved output is.

v1 scope: rect, circle, text, polygon, arrow, line, group, caption,
emphasis. No particles, physics, audio-reactive, or beat detection — see
UPCOMING_FEATURES.md for why those are cut for the study-explainer case.
"""

from pydantic import BaseModel, Field, field_validator, model_validator
from typing import List, Optional, Union

LAYER_TYPES = ("rect", "circle", "text", "polygon", "arrow", "line", "group", "caption", "emphasis")
EASINGS = ("linear", "easeIn", "easeOut", "easeInOut", "bounce", "elastic", "back")
EMPHASIS_STYLES = ("pop", "slideup", "fade", "zoom")
EMPHASIS_SIZES = ("small", "medium", "large", "huge")
EMPHASIS_SLOTS = ("center", "upper", "lower")
TEXT_FORMATS = ("text", "formula")
ANIMATABLE_PROPS = ("x", "y", "scale", "rotation", "opacity", "color")
CAMERA_PROPS = ("x", "y", "zoom", "rotation")


class TimeRef(BaseModel):
    """A point in time. If marker is set, time = marker's time + offset.
    If marker is null, offset IS the absolute time in seconds."""
    marker: Optional[str] = None
    offset: float = 0.0


class KeyframePoint(BaseModel):
    time: TimeRef
    value: Union[float, str]
    easing: str = "linear"

    @field_validator("easing")
    @classmethod
    def _known_easing(cls, v):
        if v not in EASINGS:
            raise ValueError(f"Unknown easing '{v}'. Use one of {EASINGS}.")
        return v


class KeyframeTrack(BaseModel):
    property: str
    points: List[KeyframePoint] = Field(..., min_length=1)

    @field_validator("property")
    @classmethod
    def _known_prop(cls, v):
        if v not in ANIMATABLE_PROPS:
            raise ValueError(f"Unknown animatable property '{v}'. Use one of {ANIMATABLE_PROPS}.")
        return v


class Layer(BaseModel):
    name: str = Field(..., min_length=1)
    type: str
    parent: Optional[str] = None

    x: float = 0
    y: float = 0
    scale: float = 1
    rotation: float = 0
    opacity: float = 1
    color: str = "#ffffff"

    width: Optional[float] = None
    height: Optional[float] = None
    radius: Optional[float] = None
    sides: Optional[int] = None
    x2: Optional[float] = None
    y2: Optional[float] = None
    strokeWidth: Optional[float] = None

    text: Optional[str] = None
    fontSize: Optional[float] = None
    format: str = "text"  # "formula" renders through KaTeX instead of plain text

    # Emphasis shorthand only — expanded server-side into a full keyframe
    # sequence by motion_engine, mirroring the reference tool's behavior.
    at: Optional[TimeRef] = None
    hold: Optional[float] = None
    style: Optional[str] = None
    size: Optional[str] = None
    slot: Optional[str] = None

    keyframes: List[KeyframeTrack] = Field(default_factory=list)

    @field_validator("type")
    @classmethod
    def _known_type(cls, v):
        if v not in LAYER_TYPES:
            raise ValueError(f"Unknown layer type '{v}'. Use one of {LAYER_TYPES}.")
        return v

    @field_validator("format")
    @classmethod
    def _known_format(cls, v):
        if v not in TEXT_FORMATS:
            raise ValueError(f"Unknown text format '{v}'. Use one of {TEXT_FORMATS}.")
        return v

    @model_validator(mode="after")
    def _emphasis_shape(self):
        emphasis_fields = {
            "at": self.at, "hold": self.hold, "style": self.style,
            "size": self.size, "slot": self.slot,
        }
        set_fields = [k for k, v in emphasis_fields.items() if v is not None]

        if self.type == "emphasis":
            if self.at is None or self.style is None:
                raise ValueError(f"emphasis layer '{self.name}' requires 'at' and 'style'.")
            if self.style not in EMPHASIS_STYLES:
                raise ValueError(f"Unknown emphasis style '{self.style}'. Use one of {EMPHASIS_STYLES}.")
            if self.size is not None and self.size not in EMPHASIS_SIZES:
                raise ValueError(f"Unknown emphasis size '{self.size}'. Use one of {EMPHASIS_SIZES}.")
            if self.slot is not None and self.slot not in EMPHASIS_SLOTS:
                raise ValueError(f"Unknown emphasis slot '{self.slot}'. Use one of {EMPHASIS_SLOTS}.")
        elif set_fields:
            # 'at'/'hold'/'style'/'size'/'slot' only do anything on an
            # emphasis layer -- expand_script() silently ignores them on
            # every other type. A layer that sets them almost certainly
            # meant type: "emphasis" (to get the auto fade/pop-in) and
            # will otherwise end up static and always-visible with no
            # opacity keyframes at all, which is a confusing, silent
            # failure mode rather than a loud, fixable one.
            raise ValueError(
                f"layer '{self.name}' sets {set_fields} but type is '{self.type}', not "
                f"'emphasis' -- these fields only work on emphasis layers and are otherwise "
                f"ignored. Either change type to 'emphasis', or remove {set_fields} and give "
                f"this layer explicit 'keyframes' instead (e.g. an opacity track)."
            )
        return self


class CameraTrack(BaseModel):
    property: str
    points: List[KeyframePoint] = Field(..., min_length=1)

    @field_validator("property")
    @classmethod
    def _known_camera_prop(cls, v):
        if v not in CAMERA_PROPS:
            raise ValueError(f"Unknown camera property '{v}'. Use one of {CAMERA_PROPS}.")
        return v


class Camera(BaseModel):
    x: Optional[float] = None
    y: Optional[float] = None
    zoom: float = 1
    rotation: float = 0
    keyframes: List[CameraTrack] = Field(default_factory=list)


class Scene(BaseModel):
    name: str = Field(..., min_length=1)
    duration: float = Field(..., gt=0, le=120)
    fps: int = Field(default=30, ge=15, le=60)
    background: str = "#161616"
    width: int = Field(default=800, ge=200, le=1920)
    height: int = Field(default=500, ge=200, le=1920)


class Marker(BaseModel):
    name: str = Field(..., min_length=1)
    time: float = Field(..., ge=0)


class MotionScript(BaseModel):
    """The full shorthand an LLM produces for one Motion Studio animation."""
    scene: Scene
    markers: List[Marker] = Field(default_factory=list)
    camera: Optional[Camera] = None
    layers: List[Layer] = Field(..., min_length=1, max_length=40)

    @model_validator(mode="after")
    def _cross_reference_checks(self):
        names = [l.name for l in self.layers]
        if len(names) != len(set(names)):
            raise ValueError("Layer names must be unique.")
        name_set = set(names)
        marker_names = {m.name for m in self.markers}
        for layer in self.layers:
            if layer.parent and layer.parent not in name_set:
                raise ValueError(f"Layer '{layer.name}' has unknown parent '{layer.parent}'.")
            if layer.parent == layer.name:
                raise ValueError(f"Layer '{layer.name}' cannot be its own parent.")
            for ref in _time_refs_of(layer):
                if ref.marker and ref.marker not in marker_names:
                    raise ValueError(f"Layer '{layer.name}' references unknown marker '@{ref.marker}'.")
        if self.camera:
            for track in self.camera.keyframes:
                for point in track.points:
                    if point.time.marker and point.time.marker not in marker_names:
                        raise ValueError(f"Camera references unknown marker '@{point.time.marker}'.")
        return self


def _time_refs_of(layer: Layer) -> List[TimeRef]:
    refs = []
    if layer.at:
        refs.append(layer.at)
    for track in layer.keyframes:
        for point in track.points:
            refs.append(point.time)
    return refs


# ---------- Raw schema for the LLM (Claude tool input_schema / Gemini responseSchema) ----------
# One dict, used for both providers — Gemini's schema dialect is a subset
# of what Claude's tool-calling accepts, and this project's existing
# GEMINI_RESPONSE_SCHEMA already relies on the same "type": [x, "null"]
# union style used here, so a single shared dict covers both without
# duplicating ~150 lines of near-identical JSON Schema per provider.
_TIME_REF_SCHEMA = {
    "type": "object",
    "description": "A point in time. Set 'marker' to a name from the markers list and use 'offset' as seconds relative to it, or leave marker null and use 'offset' as the absolute time in seconds.",
    "properties": {
        "marker": {"type": ["string", "null"]},
        "offset": {"type": "number"},
    },
    "required": ["offset"],
}

_KEYFRAME_POINT_SCHEMA = {
    "type": "object",
    "properties": {
        "time": _TIME_REF_SCHEMA,
        "value": {"type": ["number", "string"], "description": "Number for x/y/scale/rotation/opacity, hex string for color."},
        "easing": {"type": "string", "enum": list(EASINGS)},
    },
    "required": ["time", "value"],
}

_KEYFRAME_TRACK_SCHEMA = {
    "type": "object",
    "properties": {
        "property": {"type": "string", "enum": list(ANIMATABLE_PROPS)},
        "points": {"type": "array", "items": _KEYFRAME_POINT_SCHEMA},
    },
    "required": ["property", "points"],
}

_CAMERA_TRACK_SCHEMA = {
    "type": "object",
    "properties": {
        "property": {"type": "string", "enum": list(CAMERA_PROPS)},
        "points": {"type": "array", "items": _KEYFRAME_POINT_SCHEMA},
    },
    "required": ["property", "points"],
}

MOTION_SCRIPT_SCHEMA = {
    "type": "object",
    "properties": {
        "scene": {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "duration": {"type": "number", "description": "Seconds. Keep it tight — 8 to 45s is typical for one concept, 120s hard max."},
                "fps": {"type": "integer"},
                "background": {"type": "string", "description": "Hex color."},
                "width": {"type": "integer"},
                "height": {"type": "integer"},
            },
            "required": ["name", "duration"],
        },
        "markers": {
            "type": "array",
            "description": "Named beats in the timeline, referenced from any 'time' field instead of a raw number, so pacing reads clearly and can be adjusted in one place.",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "time": {"type": "number"},
                },
                "required": ["name", "time"],
            },
        },
        "camera": {
            "type": ["object", "null"],
            "properties": {
                "x": {"type": ["number", "null"]},
                "y": {"type": ["number", "null"]},
                "zoom": {"type": "number"},
                "rotation": {"type": "number"},
                "keyframes": {"type": "array", "items": _CAMERA_TRACK_SCHEMA},
            },
        },
        "layers": {
            "type": "array",
            "description": "1 to 40 layers, back to front.",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Unique within the script."},
                    "type": {"type": "string", "enum": list(LAYER_TYPES)},
                    "parent": {"type": ["string", "null"], "description": "Another layer's name, for grouped transforms."},
                    "x": {"type": "number"},
                    "y": {"type": "number"},
                    "scale": {"type": "number"},
                    "rotation": {"type": "number"},
                    "opacity": {"type": "number"},
                    "color": {"type": "string"},
                    "width": {"type": ["number", "null"], "description": "rect only."},
                    "height": {"type": ["number", "null"], "description": "rect only."},
                    "radius": {"type": ["number", "null"], "description": "circle/polygon only."},
                    "sides": {"type": ["integer", "null"], "description": "polygon only, 3-12."},
                    "x2": {"type": ["number", "null"], "description": "arrow/line endpoint."},
                    "y2": {"type": ["number", "null"], "description": "arrow/line endpoint."},
                    "strokeWidth": {"type": ["number", "null"]},
                    "text": {"type": ["string", "null"], "description": "text/caption/emphasis only. If format is 'formula', valid KaTeX/LaTeX."},
                    "fontSize": {"type": ["number", "null"]},
                    "format": {"type": "string", "enum": list(TEXT_FORMATS), "description": "'formula' for KaTeX-rendered math, 'text' otherwise."},
                    "at": {**_TIME_REF_SCHEMA, "type": ["object", "null"], "description": "emphasis only: when it appears."},
                    "hold": {"type": ["number", "null"], "description": "emphasis only: seconds fully visible before it exits."},
                    "style": {"type": ["string", "null"], "enum": list(EMPHASIS_STYLES) + [None]},
                    "size": {"type": ["string", "null"], "enum": list(EMPHASIS_SIZES) + [None]},
                    "slot": {"type": ["string", "null"], "enum": list(EMPHASIS_SLOTS) + [None]},
                    "keyframes": {"type": "array", "items": _KEYFRAME_TRACK_SCHEMA},
                },
                "required": ["name", "type"],
            },
        },
    },
    "required": ["scene", "layers"],
}
