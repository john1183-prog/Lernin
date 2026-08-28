"""
Lernin — Motion Studio expansion engine.

Takes an already-Pydantic-validated MotionScript (see motion_schema.py) and
expands it into the fully resolved layer/keyframe JSON the frontend player
actually reads: markers resolved to absolute seconds, emphasis shorthand
expanded into its full keyframe sequence, keyframes regrouped from
"tracks" (schema-friendly, what the LLM produces) into a dict keyed by
property (runtime-friendly, what Layer.get() in the player wants to look
up) and sorted by time.

Deliberately trimmed versus the reference tool's interpret(): no particle
seeding, no physics simulation, no audio-reactive config, no glow/shadow
effect config — none of those are in v1 scope. See UPCOMING_FEATURES.md.

Pure function of its input. No I/O, no network, no FastAPI import — this
is what makes it unit-testable without a live AI key (see
test_motion_engine.py).
"""

from motion_schema import MotionScript, Layer, TimeRef, EMPHASIS_STYLES

# Fractions of scene height, matching the reference tool's own tuned
# constants — kept identical rather than re-derived, since they're a
# visual-taste choice already made, not something to re-litigate.
_EMPHASIS_SIZE_SCALE = {"small": 0.045, "medium": 0.075, "large": 0.11, "huge": 0.16}
_EMPHASIS_SLOT_Y = {"center": 0.5, "upper": 0.28, "lower": 0.75}
_EMPHASIS_DEFAULT_HOLD = 0.9


class MotionEngineError(ValueError):
    """Raised for issues Pydantic's structural validation can't catch —
    e.g. a keyframe landing outside the scene's own duration. Distinct
    from pydantic.ValidationError so callers can tell the two apart."""


def _build_marker_lookup(script: MotionScript) -> dict:
    return {m.name: m.time for m in script.markers}


def _resolve_time(ref: TimeRef, markers: dict, duration: float, where: str) -> float:
    t = markers[ref.marker] + ref.offset if ref.marker else ref.offset
    if t < 0:
        raise MotionEngineError(f"{where}: resolved time {t:.2f}s is negative.")
    if t > duration + 0.001:
        raise MotionEngineError(
            f"{where}: resolved time {t:.2f}s falls after the scene's {duration:.2f}s duration."
        )
    return round(t, 4)


def _expand_tracks(tracks, markers: dict, duration: float, where: str) -> dict:
    """List[KeyframeTrack] -> {property: [{time, value, easing}, ...]}, sorted by time."""
    out = {}
    for track in tracks:
        points = [
            {
                "time": _resolve_time(p.time, markers, duration, f"{where} ({track.property})"),
                "value": p.value,
                "easing": p.easing,
            }
            for p in track.points
        ]
        points.sort(key=lambda p: p["time"])
        out[track.property] = points
    return out


def _add_point(keyframes: dict, prop: str, time: float, value, easing: str):
    keyframes.setdefault(prop, []).append({"time": round(time, 4), "value": value, "easing": easing})


def _apply_emphasis(layer: Layer, keyframes: dict, scene, markers: dict) -> dict:
    """Mirrors the reference tool's emphasis auto-keyframing. Always
    auto-positions from slot/size rather than only when x/y/fontSize are
    unset — a deliberate v1 simplification, since a shorthand primitive
    that sometimes honors manual placement and sometimes doesn't is a
    harder contract for an LLM to reason about than one that always does
    one thing."""
    at = _resolve_time(layer.at, markers, scene.duration, f"layer '{layer.name}' (at)")
    hold = layer.hold if layer.hold is not None else _EMPHASIS_DEFAULT_HOLD
    style = layer.style

    x = scene.width / 2
    y = scene.height * _EMPHASIS_SLOT_Y.get(layer.slot, _EMPHASIS_SLOT_Y["center"])
    font_size = round(scene.height * _EMPHASIS_SIZE_SCALE.get(layer.size, _EMPHASIS_SIZE_SCALE["large"]))

    exit_start = at + hold

    if style == "slideup":
        _add_point(keyframes, "y", at, y + scene.height * 0.06, "linear")
        _add_point(keyframes, "y", at + 0.28, y, "easeOut")
        _add_point(keyframes, "opacity", at, 0, "linear")
        _add_point(keyframes, "opacity", at + 0.22, 1, "easeOut")
    elif style == "fade":
        _add_point(keyframes, "opacity", at, 0, "linear")
        _add_point(keyframes, "opacity", at + 0.25, 1, "easeOut")
    elif style == "zoom":
        _add_point(keyframes, "scale", at, 2.4, "linear")
        _add_point(keyframes, "scale", at + 0.3, 1, "easeOut")
        _add_point(keyframes, "opacity", at, 0, "linear")
        _add_point(keyframes, "opacity", at + 0.12, 1, "easeOut")
    else:  # "pop", and the fallback if something slips past schema validation
        _add_point(keyframes, "scale", at, 0.3, "linear")
        _add_point(keyframes, "scale", at + 0.18, 1.12, "back")
        _add_point(keyframes, "scale", at + 0.32, 1, "easeInOut")
        _add_point(keyframes, "opacity", at, 0, "linear")
        _add_point(keyframes, "opacity", at + 0.08, 1, "easeOut")

    _add_point(keyframes, "opacity", exit_start, 1, "linear")
    _add_point(keyframes, "opacity", exit_start + 0.25, 0, "easeIn")
    _add_point(keyframes, "scale", exit_start, 1, "linear")
    _add_point(keyframes, "scale", exit_start + 0.25, 0.85, "easeIn")

    for prop in keyframes:
        keyframes[prop].sort(key=lambda p: p["time"])

    return {"x": x, "y": y, "fontSize": font_size}


def _expand_layer(layer: Layer, markers: dict, scene) -> dict:
    where = f"layer '{layer.name}'"
    keyframes = _expand_tracks(layer.keyframes, markers, scene.duration, where)

    resolved = {
        "name": layer.name,
        "type": layer.type,
        "parent": layer.parent,
        "x": layer.x,
        "y": layer.y,
        "scale": layer.scale,
        "rotation": layer.rotation,
        "opacity": layer.opacity,
        "color": layer.color,
        "width": layer.width,
        "height": layer.height,
        "radius": layer.radius,
        "sides": layer.sides,
        "x2": layer.x2,
        "y2": layer.y2,
        "strokeWidth": layer.strokeWidth,
        "text": layer.text,
        "fontSize": layer.fontSize,
        "format": layer.format,
    }

    if layer.type == "emphasis":
        resolved.update(_apply_emphasis(layer, keyframes, scene, markers))

    resolved["keyframes"] = keyframes
    return resolved


def expand_script(script: MotionScript) -> dict:
    """The one function the FastAPI route calls. script is already
    Pydantic-valid; this only raises MotionEngineError, for the semantic
    checks Pydantic can't express (mainly: resolved times in range)."""
    markers = _build_marker_lookup(script)
    scene = script.scene

    resolved_camera = None
    if script.camera:
        cam = script.camera
        resolved_camera = {
            "x": cam.x if cam.x is not None else scene.width / 2,
            "y": cam.y if cam.y is not None else scene.height / 2,
            "zoom": cam.zoom,
            "rotation": cam.rotation,
            "keyframes": _expand_tracks(cam.keyframes, markers, scene.duration, "camera"),
        }

    resolved_audio = sorted(
        (
            {
                "time": _resolve_time(cue.at, markers, scene.duration, f"audio cue '{cue.tone}'"),
                "tone": cue.tone,
            }
            for cue in script.audio
        ),
        key=lambda c: c["time"],
    )

    return {
        "scene": {
            "name": scene.name,
            "duration": scene.duration,
            "fps": scene.fps,
            "background": scene.background,
            "width": scene.width,
            "height": scene.height,
        },
        "camera": resolved_camera,
        "layers": [_expand_layer(layer, markers, scene) for layer in script.layers],
        "audio": resolved_audio,
    }
