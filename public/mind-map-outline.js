/* Lernin — Document Mind Map outline (pure helpers)

   The outline is the list form of the same map the canvas draws: the same nodes, the same depth
   colours, the same honest actions. On a phone a map of more than about a dozen nodes cannot show its
   labels without zooming in (they only appear once the zoom passes a cut-off), so there it starts as a
   list you can read at once, with the canvas one tap away.

   Nothing in this file touches the DOM or IndexedDB, so it is unit-tested in Node
   (test_mind_map_outline.mjs). mind-map-doc.js does the drawing. */

/** Node colour by depth (the root is depth 1); the canvas and the outline both use it. */
export const DEPTH_COLORS = ['#e8a33d', '#4a90d9', '#7fbf7f', '#c77fbf'];

export function depthColor(depth) {
  const n = DEPTH_COLORS.length;
  return DEPTH_COLORS[(((depth - 1) % n) + n) % n];
}

/** A map with more nodes than this starts as an outline on a small screen. */
export const OUTLINE_MIN_NODES = 12;

/** A small screen is narrower than 600 px, or shorter than 480 px (a phone held sideways). */
export function isCompactViewport({ width, height } = {}) {
  return (Number.isFinite(width) && width < 600) || (Number.isFinite(height) && height < 480);
}

/** Should this map open as the outline list rather than the canvas? */
export function shouldStartAsOutline(nodeCount, viewport) {
  return nodeCount > OUTLINE_MIN_NODES && isCompactViewport(viewport);
}

/**
 * The map's nodes as a nested tree for the list: [{ node, children: [...] }, ...].
 * Order is the order the nodes arrive in (the layout engine emits each node before its children, and
 * siblings in reading order), so the outline reads the way the map was built. A node whose parent is
 * missing becomes a top-level row, and nodes that cannot be reached from any root (a cycle, which the
 * engine never produces) are still listed once instead of silently dropped.
 */
export function buildOutlineTree(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  const byId = new Map(list.map(n => [n.id, { node: n, children: [] }]));
  const roots = [];
  for (const n of list) {
    const entry = byId.get(n.id);
    const parent = n.parentId != null && n.parentId !== n.id ? byId.get(n.parentId) : null;
    if (parent) parent.children.push(entry); else roots.push(entry);
  }

  const seen = new Set();
  const attach = (entry) => {
    seen.add(entry.node.id);
    return { node: entry.node, children: entry.children.filter(c => !seen.has(c.node.id)).map(attach) };
  };
  const tree = roots.map(attach);
  for (const entry of byId.values()) {
    if (!seen.has(entry.node.id)) tree.push(attach(entry));
  }
  return tree;
}
