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

# Named, synthesized-tone-only vocabulary — matches sound.js's zero-asset
# philosophy exactly (see playMotionCue() there for what each name actually
# sounds like). Deliberately NOT free-form frequency/duration params: an
# LLM picking raw Hz values has no ear and no way to know what sits well
# against the app's existing sound identity, whereas a small named palette
# is something a prompt example can demonstrate correctly once and have
# every generation match. "tick" a small beat/step landing, "pop" a term
# or detail appearing, "rise" building toward a reveal, "arrive" a reveal
# or camera move settling, "chime" the concept fully landing (used at most
# once, near the end).
AUDIO_TONES = ("tick", "pop", "rise", "arrive", "chime")


class TimeRef(BaseModel):
    """A point in time. If marker is set, time = marker's time + offset.
    If marker is null, offset IS the absolute time in seconds."""
    marker: Optional[str] = None
    offset: float = 0.0


class KeyframePoint(BaseModel):
    time: TimeRef
    value: Union[float, str]
    easing: str = "linear"

    @field_validator("value", mode="before")
    @classmethod
    def _coerce_numeric_string(cls, v):
        # The raw schema declares this field as a plain string (Gemini
        # can't express "number or string" at all -- see the comment
        # above MOTION_SCRIPT_SCHEMA), so Gemini always sends e.g. "42.5"
        # for what should be a numeric x/y/scale/rotation/opacity value.
        # Coerce it back to a real float here; genuinely non-numeric
        # strings (hex colors like "#ff0000") just fail the float() parse
        # and pass through unchanged. Claude sending an actual JSON
        # number skips this entirely (isinstance check below is False).
        if isinstance(v, str):
            try:
                return float(v)
            except ValueError:
                return v
        return v

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

    @model_validator(mode="after")
    def _has_visible_content(self):
        # All of width/height/radius/text are Optional so the schema can
        # share one Layer shape across every type -- but "Optional in the
        # schema" doesn't mean "optional in practice": a rect with no
        # width/height, or a circle with no radius, has nothing to
        # actually draw. This is exactly the shape of a real degenerate
        # response seen in production (a truncated/incomplete generation
        # produced a single rect layer with every type-specific field
        # null) -- syntactically valid, semantically empty, and until
        # this check, silently accepted rather than rejected.
        t = self.type
        if t == "rect" and (self.width is None or self.height is None):
            raise ValueError(f"layer '{self.name}' is type 'rect' but is missing 'width' and/or 'height'.")
        if t in ("circle", "polygon") and self.radius is None:
            raise ValueError(f"layer '{self.name}' is type '{t}' but is missing 'radius'.")
        if t in ("text", "caption", "emphasis") and not (self.text and self.text.strip()):
            raise ValueError(f"layer '{self.name}' is type '{t}' but is missing non-empty 'text'.")
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

    @model_validator(mode="before")
    @classmethod
    def _clamp_out_of_range(cls, data):
        # Prompt guidance tells the model these bounds exist, but nothing
        # guarantees it listens -- and a model picking width=3000 or
        # fps=90 is a mundane, harmless mistake, not a sign the whole
        # script is wrong. Clamp rather than reject: the video is still
        # perfectly valid, just capped. Field(...) above stays as a
        # backstop in case this ever gets bypassed.
        if not isinstance(data, dict):
            return data
        bounds = {"width": (200, 1920), "height": (200, 1920), "fps": (15, 60), "duration": (0.1, 120)}
        for key, (lo, hi) in bounds.items():
            if key in data and isinstance(data[key], (int, float)) and not isinstance(data[key], bool):
                data[key] = max(lo, min(hi, data[key]))
        return data


class Marker(BaseModel):
    name: str = Field(..., min_length=1)
    time: float = Field(..., ge=0)


class AudioCue(BaseModel):
    """A single named, synthesized tone at a point in the timeline. See
    AUDIO_TONES above for the fixed vocabulary and motion_engine.py for how
    'at' gets resolved to an absolute time — the frontend player receives
    only {time, tone}, never anything it could interpret as a file or a
    frequency to synthesize itself."""
    at: TimeRef
    tone: str

    @field_validator("tone")
    @classmethod
    def _known_tone(cls, v):
        if v not in AUDIO_TONES:
            raise ValueError(f"Unknown audio tone '{v}'. Use one of {AUDIO_TONES}.")
        return v


class MotionScript(BaseModel):
    """The full shorthand an LLM produces for one Motion Studio animation."""
    scene: Scene
    markers: List[Marker] = Field(default_factory=list)
    camera: Optional[Camera] = None
    layers: List[Layer] = Field(..., min_length=1, max_length=40)
    # Optional and sparse by design — most beats don't need a sound, and a
    # script with a cue on every single keyframe would just be noise (both
    # literally and as a signal of a model over-using the feature). 12 is
    # generous headroom for even a long, many-beat explainer.
    audio: List[AudioCue] = Field(default_factory=list, max_length=12)

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
        for cue in self.audio:
            if cue.at.marker and cue.at.marker not in marker_names:
                raise ValueError(f"Audio cue '{cue.tone}' references unknown marker '@{cue.at.marker}'.")
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
# One dict, used for both providers. Gemini's schema is a scalar-typed
# subset of OpenAPI 3.0 (see https://ai.google.dev/gemini-api/docs/structured-output)
# -- "type" is a protobuf enum field, not a repeating one, so it rejects
# ANY array value for "type", full stop, not just JSON-Schema-style
# "[x, null]" nullable unions (confirmed against a live Gemini call: a
# 400 "Proto field is not repeating, cannot start list" on exactly that
# pattern). The previous version of this schema used that pattern
# throughout on the (untested) assumption it matched Gemini's card-
# generation schema elsewhere in this project -- it didn't; that schema
# had the identical bug, fixed alongside this one.
#
# Gemini's documented replacement for a nullable field is a single
# "type" plus a sibling "nullable": true (not a type array) -- used
# throughout below. Gemini also has no way to express "this field is
# either a number or a string" (no oneOf/anyOf, no type arrays) --
# KeyframePoint.value hits this for real (a keyframe holds either a
# plain number or a hex color string), so that one field is declared
# as "string" uniformly and coerced back to float on the Python side
# when it parses as a plain number (see KeyframePoint's field_validator
# below) -- transparent to both providers: Claude can still send an
# actual JSON number and it passes through unchanged, Gemini's
# string-only output gets normalized before it ever reaches Pydantic.
_TIME_REF_SCHEMA = {
    "type": "object",
    "description": "A point in time. Set 'marker' to a name from the markers list and use 'offset' as seconds relative to it, or leave marker unset and use 'offset' as the absolute time in seconds.",
    "properties": {
        "marker": {"type": "string", "nullable": True},
        "offset": {"type": "number"},
    },
    "required": ["offset"],
}

_KEYFRAME_POINT_SCHEMA = {
    "type": "object",
    "properties": {
        "time": _TIME_REF_SCHEMA,
        "value": {"type": "string", "description": "A plain number as a string for x/y/scale/rotation/opacity (e.g. \"42.5\"), or a hex string for color (e.g. \"#ff0000\")."},
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
                "fps": {"type": "integer", "description": "15-60. 30 is a good default."},
                "background": {"type": "string", "description": "Hex color."},
                "width": {"type": "integer", "description": "Pixels, 200-1920. 800 is a good default."},
                "height": {"type": "integer", "description": "Pixels, 200-1920. 500 is a good default."},
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
            "type": "object",
            "nullable": True,
            "properties": {
                "x": {"type": "number", "nullable": True},
                "y": {"type": "number", "nullable": True},
                "zoom": {"type": "number"},
                "rotation": {"type": "number"},
                "keyframes": {"type": "array", "items": _CAMERA_TRACK_SCHEMA},
            },
        },
        "audio": {
            "type": "array",
            "description": (
                "Optional, sparse. Up to 12 short synthesized tones placed at specific moments — "
                "not background music, not one per keyframe. Use 'tick' for a small beat/step "
                "landing, 'pop' for a term or detail appearing, 'rise' building toward a reveal, "
                "'arrive' when a reveal or camera move settles, and 'chime' at most once, near the "
                "end, for the concept fully landing. Most scripts need 2-5 cues total, placed on "
                "markers, not on every layer's entrance."
            ),
            "items": {
                "type": "object",
                "properties": {
                    "at": _TIME_REF_SCHEMA,
                    "tone": {"type": "string", "enum": list(AUDIO_TONES)},
                },
                "required": ["at", "tone"],
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
                    "parent": {"type": "string", "nullable": True, "description": "Another layer's name, for grouped transforms."},
                    "x": {"type": "number"},
                    "y": {"type": "number"},
                    "scale": {"type": "number"},
                    "rotation": {"type": "number"},
                    "opacity": {"type": "number"},
                    "color": {"type": "string"},
                    "width": {"type": "number", "nullable": True, "description": "rect only."},
                    "height": {"type": "number", "nullable": True, "description": "rect only."},
                    "radius": {"type": "number", "nullable": True, "description": "circle/polygon only."},
                    "sides": {"type": "integer", "nullable": True, "description": "polygon only, 3-12."},
                    "x2": {"type": "number", "nullable": True, "description": "arrow/line endpoint."},
                    "y2": {"type": "number", "nullable": True, "description": "arrow/line endpoint."},
                    "strokeWidth": {"type": "number", "nullable": True},
                    "text": {"type": "string", "nullable": True, "description": "text/caption/emphasis only. If format is 'formula', valid KaTeX/LaTeX."},
                    "fontSize": {"type": "number", "nullable": True},
                    "format": {"type": "string", "enum": list(TEXT_FORMATS), "description": "'formula' for KaTeX-rendered math, 'text' otherwise."},
                    "at": {
                        "type": "object",
                        "nullable": True,
                        "description": "emphasis only: when it appears.",
                        "properties": _TIME_REF_SCHEMA["properties"],
                        "required": _TIME_REF_SCHEMA["required"],
                    },
                    "hold": {"type": "number", "nullable": True, "description": "emphasis only: seconds fully visible before it exits."},
                    "style": {"type": "string", "nullable": True, "enum": list(EMPHASIS_STYLES)},
                    "size": {"type": "string", "nullable": True, "enum": list(EMPHASIS_SIZES)},
                    "slot": {"type": "string", "nullable": True, "enum": list(EMPHASIS_SLOTS)},
                    "keyframes": {"type": "array", "items": _KEYFRAME_TRACK_SCHEMA},
                },
                "required": ["name", "type"],
            },
        },
    },
    "required": ["scene", "layers"],
}
