"""
Tests for motion_engine.py — run with:  python3 -m unittest test_motion_engine -v
(from inside api/, or with api/ on PYTHONPATH)

These exercise the pure expansion logic against constructed inputs. No
network, no AI key needed — this is exactly the part of Motion Studio
that doesn't need a live model to verify, so it gets verified now rather
than assumed correct because it was carefully ported.
"""

import unittest
from pydantic import ValidationError

from motion_schema import MotionScript
from motion_engine import expand_script, MotionEngineError


def script(**overrides):
    base = {
        "scene": {"name": "Test", "duration": 5, "fps": 30},
        "markers": [{"name": "reveal", "time": 1.0}],
        "layers": [{"name": "box", "type": "rect", "width": 100, "height": 100}],
    }
    base.update(overrides)
    return MotionScript.model_validate(base)


class TestMarkersAndTracks(unittest.TestCase):
    def test_marker_plus_offset_resolves(self):
        s = script(layers=[{
            "name": "box", "type": "rect",
            "keyframes": [{"property": "x", "points": [
                {"time": {"marker": "reveal", "offset": 0.5}, "value": 200, "easing": "easeOut"},
            ]}],
        }])
        out = expand_script(s)
        self.assertEqual(out["layers"][0]["keyframes"]["x"][0]["time"], 1.5)

    def test_null_marker_is_absolute_time(self):
        s = script(layers=[{
            "name": "box", "type": "rect",
            "keyframes": [{"property": "opacity", "points": [
                {"time": {"offset": 2.25}, "value": 1},
            ]}],
        }])
        out = expand_script(s)
        self.assertEqual(out["layers"][0]["keyframes"]["opacity"][0]["time"], 2.25)

    def test_keyframes_sorted_by_time_even_if_given_out_of_order(self):
        s = script(layers=[{
            "name": "box", "type": "rect",
            "keyframes": [{"property": "x", "points": [
                {"time": {"offset": 3.0}, "value": 300},
                {"time": {"offset": 0.0}, "value": 0},
                {"time": {"offset": 1.5}, "value": 150},
            ]}],
        }])
        times = [p["time"] for p in expand_script(s)["layers"][0]["keyframes"]["x"]]
        self.assertEqual(times, [0.0, 1.5, 3.0])

    def test_unknown_marker_rejected_at_validation_not_expansion(self):
        with self.assertRaises(ValidationError):
            script(layers=[{
                "name": "box", "type": "rect",
                "keyframes": [{"property": "x", "points": [
                    {"time": {"marker": "nope", "offset": 0}, "value": 1},
                ]}],
            }])

    def test_time_beyond_duration_raises_at_expansion(self):
        s = script(scene={"name": "Test", "duration": 5, "fps": 30}, layers=[{
            "name": "box", "type": "rect",
            "keyframes": [{"property": "x", "points": [{"time": {"offset": 9.0}, "value": 1}]}],
        }])
        with self.assertRaises(MotionEngineError):
            expand_script(s)


class TestStructuralValidation(unittest.TestCase):
    def test_duplicate_layer_names_rejected(self):
        with self.assertRaises(ValidationError):
            script(layers=[
                {"name": "a", "type": "rect"},
                {"name": "a", "type": "circle", "radius": 10},
            ])

    def test_unknown_parent_rejected(self):
        with self.assertRaises(ValidationError):
            script(layers=[{"name": "a", "type": "rect", "parent": "ghost"}])

    def test_self_parent_rejected(self):
        with self.assertRaises(ValidationError):
            script(layers=[{"name": "a", "type": "rect", "parent": "a"}])

    def test_emphasis_without_style_rejected(self):
        with self.assertRaises(ValidationError):
            script(layers=[{"name": "e", "type": "emphasis", "text": "Hi", "at": {"offset": 1}}])

    def test_emphasis_fields_on_non_emphasis_layer_rejected(self):
        # Reproduces the real bug found in a live script: a caption using
        # 'at'/'style' (which only work on type: emphasis) instead of
        # explicit opacity keyframes. Previously silently ignored, leaving
        # the layer static and always-visible with no way to tell why.
        with self.assertRaises(ValidationError):
            script(layers=[{
                "name": "subtitle", "type": "caption", "text": "The fundamental science",
                "at": {"marker": "reveal", "offset": 0.5}, "style": "fade",
            }])

    def test_hold_on_non_emphasis_layer_rejected(self):
        with self.assertRaises(ValidationError):
            script(layers=[{"name": "a", "type": "text", "text": "hi", "hold": 1.0}])

    def test_unknown_easing_rejected(self):
        with self.assertRaises(ValidationError):
            script(layers=[{
                "name": "a", "type": "rect",
                "keyframes": [{"property": "x", "points": [
                    {"time": {"offset": 0}, "value": 1, "easing": "superBounce"},
                ]}],
            }])


class TestEmphasisExpansion(unittest.TestCase):
    def _emphasis(self, style, **extra):
        layer = {"name": "e", "type": "emphasis", "text": "LAUNCH",
                 "at": {"marker": "reveal", "offset": 0.5}, "style": style}
        layer.update(extra)
        s = script(scene={"name": "Test", "duration": 10, "fps": 30}, layers=[layer])
        return expand_script(s)["layers"][0]

    def test_pop_style_produces_expected_scale_and_opacity_beats(self):
        l = self._emphasis("pop", hold=1.0)
        at = 1.5  # marker "reveal" (1.0) + offset (0.5)
        scale_times = [p["time"] for p in l["keyframes"]["scale"]]
        opacity_times = [p["time"] for p in l["keyframes"]["opacity"]]
        # entrance (3 scale pts: 0.3 -> 1.12 -> 1) + exit (2 scale pts: 1 -> 0.85) = 5
        # entrance (2 opacity pts: 0 -> 1) + exit (2 opacity pts: 1 -> 0) = 4
        self.assertEqual(len(scale_times), 5)
        self.assertEqual(len(opacity_times), 4)
        self.assertAlmostEqual(scale_times[0], at)
        self.assertAlmostEqual(opacity_times[0], at)
        # exit begins at at + hold
        self.assertAlmostEqual(scale_times[-1], at + 1.0 + 0.25)

    def test_slideup_style_animates_y_not_scale(self):
        l = self._emphasis("slideup", hold=0.5)
        self.assertIn("y", l["keyframes"])
        self.assertNotIn("x", l["keyframes"])
        # slideup still gets the shared exit-scale beats
        self.assertIn("scale", l["keyframes"])

    def test_fade_style_only_touches_opacity_on_entrance(self):
        l = self._emphasis("fade", hold=0.5)
        self.assertNotIn("y", l["keyframes"])
        entrance_and_exit_opacity_points = len(l["keyframes"]["opacity"])
        self.assertEqual(entrance_and_exit_opacity_points, 4)  # 2 entrance + 2 exit

    def test_slot_and_size_drive_position_and_font(self):
        l = self._emphasis("pop", slot="upper", size="huge")
        self.assertAlmostEqual(l["y"], 500 * 0.28)  # default scene height 500 * upper fraction
        self.assertEqual(l["fontSize"], round(500 * 0.16))

    def test_default_hold_is_used_when_omitted(self):
        l = self._emphasis("fade")  # no hold given
        at = 1.5
        exit_opacity_time = sorted(p["time"] for p in l["keyframes"]["opacity"])[-1]
        self.assertAlmostEqual(exit_opacity_time, at + 0.9 + 0.25)


class TestCamera(unittest.TestCase):
    def test_camera_defaults_to_scene_center_when_unset(self):
        s = script(camera={"zoom": 1.4, "keyframes": []})
        out = expand_script(s)
        self.assertEqual(out["camera"]["x"], 400)  # default scene width 800 / 2
        self.assertEqual(out["camera"]["y"], 250)  # default scene height 500 / 2

    def test_camera_keyframes_resolve_markers_too(self):
        s = script(camera={
            "keyframes": [{"property": "zoom", "points": [
                {"time": {"marker": "reveal", "offset": 0}, "value": 1.1},
            ]}],
        })
        out = expand_script(s)
        self.assertEqual(out["camera"]["keyframes"]["zoom"][0]["time"], 1.0)


class TestFullScene(unittest.TestCase):
    def test_end_to_end_scene_shape(self):
        s = MotionScript.model_validate({
            "scene": {"name": "Newton's First Law", "duration": 12, "fps": 30,
                      "background": "#0a0e14", "width": 800, "height": 500},
            "markers": [{"name": "release", "time": 1.3}, {"name": "impact", "time": 2.15}],
            "camera": {"zoom": 1.0, "keyframes": [
                {"property": "zoom", "points": [
                    {"time": {"offset": 0}, "value": 1.3},
                    {"time": {"marker": "release", "offset": 0}, "value": 1.0, "easing": "easeInOut"},
                ]},
            ]},
            "layers": [
                {"name": "ball", "type": "circle", "radius": 22, "color": "#ffe066",
                 "x": 250, "y": 120,
                 "keyframes": [
                     {"property": "y", "points": [
                         {"time": {"marker": "release", "offset": 0}, "value": 120},
                         {"time": {"marker": "impact", "offset": 0}, "value": 450, "easing": "easeIn"},
                     ]},
                 ]},
                {"name": "impact_word", "type": "emphasis", "text": "IMPACT",
                 "at": {"marker": "impact", "offset": 0}, "hold": 0.5, "style": "zoom",
                 "size": "medium", "slot": "upper"},
                {"name": "formula_label", "type": "caption", "text": "F = ma",
                 "format": "formula", "x": 400, "y": 460},
            ],
        })
        out = expand_script(s)
        self.assertEqual(out["scene"]["name"], "Newton's First Law")
        self.assertEqual(len(out["layers"]), 3)
        ball, impact_word, formula = out["layers"]
        self.assertEqual(ball["keyframes"]["y"][0]["time"], 1.3)
        self.assertEqual(ball["keyframes"]["y"][1]["time"], 2.15)
        self.assertIn("scale", impact_word["keyframes"])
        self.assertEqual(formula["format"], "formula")
        self.assertEqual(out["camera"]["keyframes"]["zoom"][1]["time"], 1.3)


if __name__ == "__main__":
    unittest.main()
