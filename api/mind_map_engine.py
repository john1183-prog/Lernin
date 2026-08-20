"""Pure expansion/layout for the document mind map. Zero network/FastAPI
import, unit-testable without a live key -- same shape as motion_engine.py's
expand_script(), for the same reason: positions here are DERIVED, not
AI-authored. The model generates semantic structure only (a topic tree:
titles, short details, parent/child relationships); this module turns that
into concrete, non-overlapping (x, y) coordinates via a deterministic
radial-tree layout. Keeping that split means a bad layout is a bug in this
file, reproducible and fixable without ever touching a prompt, and a bad
topic breakdown is a prompt-quality problem, not a geometry one -- they
can't be tangled together the way an AI-specified x/y would tangle them.

Layout approach: root sits at the canvas center. Each subsequent ring
(depth 2, 3, 4) sits at a radius chosen so that ring's own node count fits
comfortably around its circumference (radius grows with how crowded a ring
is, not just a flat step) -- otherwise a topic with many level-1 branches
would visually collide even though a topic with few wouldn't, at the same
fixed radius. Within a ring, each node's angular position is the midpoint
of an arc inherited from its parent, subdivided among siblings weighted by
each sibling's own subtree size (a branch with many descendants gets
proportionally more angular room, so its children don't cram together)."""

import math

from mind_map_schema import MindMapScript, TopicNode, MAX_DEPTH, _count_nodes


class MindMapEngineError(Exception):
    pass


MIN_ARC_GAP = 64.0    # px of ring circumference to reserve per node on that ring
MIN_RING_GAP = 150.0  # px, minimum radius increase from one ring to the next
CANVAS_PADDING = 90.0 # px of margin beyond the outermost ring


def _level_counts(root: TopicNode) -> dict:
    counts = {}

    def _walk(node: TopicNode, depth: int):
        counts[depth] = counts.get(depth, 0) + 1
        for c in node.children:
            _walk(c, depth + 1)

    _walk(root, 1)
    return counts


def _radius_by_depth(root: TopicNode) -> dict:
    """depth 1 (root) is always radius 0. Each ring after that grows by
    at least MIN_RING_GAP, or further still if that ring is crowded enough
    that MIN_ARC_GAP-per-node wouldn't fit on its circumference at the
    minimum radius."""
    counts = _level_counts(root)
    radii = {1: 0.0}
    prev_r = 0.0
    for depth in range(2, MAX_DEPTH + 1):
        count = counts.get(depth, 0)
        if count == 0:
            radii[depth] = prev_r
            continue
        needed_for_spacing = (count * MIN_ARC_GAP) / (2 * math.pi)
        r = prev_r + max(MIN_RING_GAP, needed_for_spacing)
        radii[depth] = r
        prev_r = r
    return radii


def expand_mind_map(script: MindMapScript) -> dict:
    root = script.root
    radii = _radius_by_depth(root)
    max_radius = max(radii.values()) if radii else 0.0
    canvas_size = round(2 * (max_radius + CANVAS_PADDING), 2)
    cx = cy = canvas_size / 2

    nodes = []
    counter = [0]

    def _walk(node: TopicNode, depth: int, angle: float, half_span: float, parent_id):
        node_id = f"n{counter[0]}"
        counter[0] += 1
        r = radii.get(depth, max_radius)
        if depth == 1:
            x, y = cx, cy
        else:
            x = cx + r * math.cos(angle)
            y = cy + r * math.sin(angle)
        nodes.append({
            "id": node_id,
            "title": node.title,
            "detail": node.detail,
            "depth": depth,
            "x": round(x, 2),
            "y": round(y, 2),
            "parentId": parent_id,
        })

        children = node.children
        if not children:
            return
        weights = [max(1, _count_nodes(c)) for c in children]
        total = sum(weights)
        if depth == 1:
            # root has no meaningful angle of its own -- its children get
            # the full circle, not a sub-arc of anything
            start, end = 0.0, 2 * math.pi
        else:
            start, end = angle - half_span, angle + half_span
        span = end - start
        a = start
        for child, w in zip(children, weights):
            child_span = span * (w / total)
            child_angle = a + child_span / 2
            _walk(child, depth + 1, child_angle, child_span / 2, node_id)
            a += child_span

    _walk(root, 1, 0.0, math.pi, None)

    return {
        "width": canvas_size,
        "height": canvas_size,
        "nodes": nodes,
    }
