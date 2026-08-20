import math
import unittest

from pydantic import ValidationError

from mind_map_schema import (
    TopicNode, MindMapScript, MIND_MAP_SCRIPT_SCHEMA,
    MIN_TOTAL_NODES, MAX_TOTAL_NODES, MAX_DEPTH, NODE_TITLE_MAX, NODE_DETAIL_MAX,
    _count_nodes, _max_depth,
)
from mind_map_engine import expand_mind_map, MindMapEngineError


def _node(title="T", detail=None, children=None):
    return {"title": title, "detail": detail, "children": children or []}


def _linear_chain(depth):
    """A single-branch chain exactly `depth` levels deep -- the minimal
    tree that reaches a given depth."""
    node = _node(f"leaf")
    for i in range(depth - 1, 0, -1):
        node = _node(f"level{i}", children=[node])
    return node


def _wide_tree(root_children, per_child_children=0):
    """A root with `root_children` direct children, each of which has
    `per_child_children` of its own -- for node-count and spacing tests."""
    children = []
    for i in range(root_children):
        grandchildren = [_node(f"g{i}_{j}") for j in range(per_child_children)]
        children.append(_node(f"c{i}", children=grandchildren))
    return _node("root", children=children)


class TestSchemaValidation(unittest.TestCase):
    def test_minimal_valid_tree(self):
        script = MindMapScript.model_validate({"root": _wide_tree(3)})
        self.assertEqual(_count_nodes(script.root), 4)

    def test_leaf_needs_no_children_field(self):
        # A leaf TopicNode with no "children" key at all must validate --
        # this is exactly what the unrolled 4-level generation schema
        # produces for its deepest level (no "children" property exists
        # there at all), so the internal model has to accept the same shape.
        TopicNode.model_validate({"title": "Leaf"})

    def test_empty_title_rejected(self):
        with self.assertRaises(ValidationError):
            TopicNode.model_validate({"title": ""})

    def test_title_too_long_rejected(self):
        with self.assertRaises(ValidationError):
            TopicNode.model_validate({"title": "x" * (NODE_TITLE_MAX + 1)})

    def test_detail_too_long_rejected(self):
        with self.assertRaises(ValidationError):
            TopicNode.model_validate({"title": "T", "detail": "x" * (NODE_DETAIL_MAX + 1)})

    def test_too_few_nodes_rejected(self):
        # MIN_TOTAL_NODES=3; a bare root with no children is 1 node.
        with self.assertRaises(ValidationError):
            MindMapScript.model_validate({"root": _node("Alone")})

    def test_too_many_nodes_rejected(self):
        with self.assertRaises(ValidationError):
            MindMapScript.model_validate({"root": _wide_tree(MAX_TOTAL_NODES)})  # root + N = N+1 > MAX

    def test_exactly_min_nodes_accepted(self):
        tree = _wide_tree(MIN_TOTAL_NODES - 1)  # root + (MIN-1) children = MIN nodes
        script = MindMapScript.model_validate({"root": tree})
        self.assertEqual(_count_nodes(script.root), MIN_TOTAL_NODES)

    def test_exactly_max_nodes_accepted(self):
        tree = _wide_tree(MAX_TOTAL_NODES - 1)
        script = MindMapScript.model_validate({"root": tree})
        self.assertEqual(_count_nodes(script.root), MAX_TOTAL_NODES)

    def test_depth_within_limit_accepted(self):
        tree = _linear_chain(MAX_DEPTH)
        script = MindMapScript.model_validate({"root": tree})
        self.assertEqual(_max_depth(script.root), MAX_DEPTH)

    def test_depth_exceeding_limit_rejected(self):
        tree = _linear_chain(MAX_DEPTH + 1)
        with self.assertRaises(ValidationError):
            MindMapScript.model_validate({"root": tree})


class TestGenerationSchemaStructure(unittest.TestCase):
    """Structural checks on the raw dict handed to Claude/Gemini -- the
    same class of check motion_schema.py added after a live Gemini call
    rejected an array-valued "type" field. Nothing here has been run
    against a live Gemini call (not reachable from this sandbox), so this
    only catches the specific failure modes already known from that
    incident, not a general guarantee of Gemini compatibility."""

    def _walk_schema(self, node):
        """Yield every dict in the schema tree, recursively, through
        "properties" and "items"."""
        if not isinstance(node, dict):
            return
        yield node
        for v in node.get("properties", {}).values():
            yield from self._walk_schema(v)
        items = node.get("items")
        if items is not None:
            yield from self._walk_schema(items)

    def test_no_array_valued_type_fields(self):
        for sub in self._walk_schema(MIND_MAP_SCRIPT_SCHEMA):
            t = sub.get("type")
            self.assertNotIsInstance(
                t, list,
                f"found an array-valued 'type' field ({t!r}) -- exactly the shape that broke "
                f"Gemini's structured output for Motion Studio; use 'nullable': True instead"
            )

    def test_no_ref_or_defs_anywhere(self):
        # The whole point of unrolling into 4 explicit levels was to avoid
        # a recursive $ref, since Gemini's schema support for that has
        # never been confirmed. Make sure nothing reintroduces one.
        def _search(node):
            if isinstance(node, dict):
                self.assertNotIn("$ref", node)
                self.assertNotIn("$defs", node)
                for v in node.values():
                    _search(v)
            elif isinstance(node, list):
                for v in node:
                    _search(v)
        _search(MIND_MAP_SCRIPT_SCHEMA)

    def test_exactly_four_levels_deep(self):
        # root -> L1 -> L2 -> leaf. The leaf level's schema must have no
        # "children" property at all (that's what makes it non-recursive).
        root_props = MIND_MAP_SCRIPT_SCHEMA["properties"]["root"]["properties"]
        l1 = root_props["children"]["items"]
        l2 = l1["properties"]["children"]["items"]
        leaf = l2["properties"]["children"]["items"]
        self.assertNotIn("children", leaf["properties"])


class TestLayoutEngine(unittest.TestCase):
    def test_root_is_at_canvas_center(self):
        script = MindMapScript.model_validate({"root": _wide_tree(4)})
        resolved = expand_mind_map(script)
        root_node = resolved["nodes"][0]
        self.assertEqual(root_node["depth"], 1)
        self.assertEqual(root_node["x"], resolved["width"] / 2)
        self.assertEqual(root_node["y"], resolved["height"] / 2)
        self.assertIsNone(root_node["parentId"])

    def test_node_count_matches_input(self):
        script = MindMapScript.model_validate({"root": _wide_tree(5, per_child_children=2)})
        resolved = expand_mind_map(script)
        self.assertEqual(len(resolved["nodes"]), _count_nodes(script.root))

    def test_unique_ids(self):
        script = MindMapScript.model_validate({"root": _wide_tree(6, per_child_children=3)})
        resolved = expand_mind_map(script)
        ids = [n["id"] for n in resolved["nodes"]]
        self.assertEqual(len(ids), len(set(ids)))

    def test_deeper_nodes_are_farther_from_center(self):
        script = MindMapScript.model_validate({"root": _linear_chain(4)})
        resolved = expand_mind_map(script)
        cx, cy = resolved["width"] / 2, resolved["height"] / 2

        def dist(n):
            return math.hypot(n["x"] - cx, n["y"] - cy)

        by_depth = sorted(resolved["nodes"], key=lambda n: n["depth"])
        dists = [dist(n) for n in by_depth]
        for i in range(1, len(dists)):
            self.assertGreater(dists[i], dists[i - 1],
                                f"depth {by_depth[i]['depth']} node should be farther from "
                                f"center than depth {by_depth[i-1]['depth']}")

    def test_parent_ids_are_correct(self):
        # root -> two children, each with its own child -- verify each
        # resolved node's parentId actually points at ITS parent, not just
        # at any valid id.
        tree = _node("root", children=[
            _node("A", children=[_node("A1")]),
            _node("B", children=[_node("B1")]),
        ])
        script = MindMapScript.model_validate({"root": tree})
        resolved = expand_mind_map(script)
        by_title = {n["title"]: n for n in resolved["nodes"]}
        root_id = by_title["root"]["id"]
        a_id = by_title["A"]["id"]
        b_id = by_title["B"]["id"]
        self.assertEqual(by_title["A"]["parentId"], root_id)
        self.assertEqual(by_title["B"]["parentId"], root_id)
        self.assertEqual(by_title["A1"]["parentId"], a_id)
        self.assertEqual(by_title["B1"]["parentId"], b_id)

    def test_no_coincident_positions_on_a_realistic_tree(self):
        tree = _node("root", children=[
            _node(f"branch{i}", children=[_node(f"leaf{i}_{j}") for j in range(3)])
            for i in range(6)
        ])
        script = MindMapScript.model_validate({"root": tree})
        resolved = expand_mind_map(script)
        seen = set()
        for n in resolved["nodes"]:
            key = (n["x"], n["y"])
            self.assertNotIn(key, seen, f"two nodes landed on the exact same position: {n}")
            seen.add(key)

    def test_max_size_tree_does_not_error_or_produce_nan(self):
        tree = _wide_tree(MAX_TOTAL_NODES - 1)
        script = MindMapScript.model_validate({"root": tree})
        resolved = expand_mind_map(script)
        self.assertEqual(len(resolved["nodes"]), MAX_TOTAL_NODES)
        for n in resolved["nodes"]:
            self.assertFalse(math.isnan(n["x"]) or math.isnan(n["y"]))
            self.assertFalse(math.isinf(n["x"]) or math.isinf(n["y"]))

    def test_minimal_tree_does_not_error(self):
        tree = _wide_tree(MIN_TOTAL_NODES - 1)
        script = MindMapScript.model_validate({"root": tree})
        resolved = expand_mind_map(script)
        self.assertEqual(len(resolved["nodes"]), MIN_TOTAL_NODES)

    def test_crowded_ring_gets_a_larger_radius_than_a_sparse_one(self):
        sparse = MindMapScript.model_validate({"root": _wide_tree(2)})
        crowded = MindMapScript.model_validate({"root": _wide_tree(15)})
        r_sparse = expand_mind_map(sparse)
        r_crowded = expand_mind_map(crowded)

        def depth2_radius(resolved):
            cx, cy = resolved["width"] / 2, resolved["height"] / 2
            depth2 = [n for n in resolved["nodes"] if n["depth"] == 2][0]
            return math.hypot(depth2["x"] - cx, depth2["y"] - cy)

        self.assertGreater(depth2_radius(r_crowded), depth2_radius(r_sparse))

    def test_canvas_size_is_positive_and_finite(self):
        script = MindMapScript.model_validate({"root": _wide_tree(8, per_child_children=2)})
        resolved = expand_mind_map(script)
        self.assertGreater(resolved["width"], 0)
        self.assertGreater(resolved["height"], 0)
        self.assertFalse(math.isnan(resolved["width"]) or math.isinf(resolved["width"]))


if __name__ == "__main__":
    unittest.main()
