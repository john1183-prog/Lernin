// test_mind_map_outline.mjs
// Permanent unit tests for mind-map-outline.js (Document Mind Map outline list)
// Run with: node public/test_mind_map_outline.mjs

import assert from 'node:assert/strict';
import {
  DEPTH_COLORS,
  OUTLINE_MIN_NODES,
  depthColor,
  isCompactViewport,
  shouldStartAsOutline,
  buildOutlineTree,
} from './mind-map-outline.js';

// Nodes the way api/mind_map_engine.py emits them: pre-order, root depth 1, siblings in reading order.
function node(id, parentId, depth, title = `Topic ${id}`) {
  return { id, title, detail: '', depth, x: 0, y: 0, parentId };
}

function flatten(tree) {
  const out = [];
  const walk = (entries) => { for (const e of entries) { out.push(e.node.id); walk(e.children); } };
  walk(tree);
  return out;
}

console.log('=== 1. depthColor: the canvas colours, unchanged, and safe for any depth ===');
{
  assert.deepEqual(DEPTH_COLORS, ['#e8a33d', '#4a90d9', '#7fbf7f', '#c77fbf']);
  assert.equal(depthColor(1), '#e8a33d');
  assert.equal(depthColor(2), '#4a90d9');
  assert.equal(depthColor(3), '#7fbf7f');
  assert.equal(depthColor(4), '#c77fbf');
  assert.equal(depthColor(5), '#e8a33d', 'wraps round after the fourth depth');
  for (let d = -6; d <= 12; d++) {
    assert.ok(DEPTH_COLORS.includes(depthColor(d)), `depth ${d} must still give a palette colour`);
  }
  // Identical to the expression mind-map-doc.js used before the helper existed, for every real depth.
  for (let d = 1; d <= 8; d++) assert.equal(depthColor(d), DEPTH_COLORS[(d - 1) % DEPTH_COLORS.length]);
  console.log('  ok - depthColor matches the old canvas formula and never returns undefined');
}

console.log('=== 2. isCompactViewport: narrower than 600 px, or shorter than 480 px ===');
{
  assert.equal(isCompactViewport({ width: 360, height: 704 }), true, 'portrait phone');
  assert.equal(isCompactViewport({ width: 320, height: 568 }), true, 'small phone');
  assert.equal(isCompactViewport({ width: 844, height: 390 }), true, 'phone held sideways');
  assert.equal(isCompactViewport({ width: 704, height: 360 }), true, 'small phone held sideways');
  assert.equal(isCompactViewport({ width: 599, height: 900 }), true, 'one pixel under the width line');
  assert.equal(isCompactViewport({ width: 600, height: 900 }), false, 'on the width line is not compact');
  assert.equal(isCompactViewport({ width: 900, height: 479 }), true, 'one pixel under the height line');
  assert.equal(isCompactViewport({ width: 900, height: 480 }), false, 'on the height line is not compact');
  assert.equal(isCompactViewport({ width: 768, height: 1024 }), false, 'tablet portrait');
  assert.equal(isCompactViewport({ width: 1280, height: 800 }), false, 'laptop');
  assert.equal(isCompactViewport({ width: 1920, height: 1080 }), false, 'desktop');
  console.log('  ok - phones (either way up) are compact; tablets and desktops are not');

  assert.equal(isCompactViewport(), false, 'no viewport given');
  assert.equal(isCompactViewport({}), false);
  assert.equal(isCompactViewport({ width: NaN, height: NaN }), false);
  assert.equal(isCompactViewport({ width: undefined, height: 400 }), true, 'a known short height is enough');
  assert.equal(isCompactViewport({ width: 400, height: undefined }), true, 'a known narrow width is enough');
  console.log('  ok - missing or non-numeric measurements never count as compact on their own');
}

console.log('=== 3. shouldStartAsOutline: big map + small screen ===');
{
  assert.equal(OUTLINE_MIN_NODES, 12);
  const phone = { width: 360, height: 704 };
  assert.equal(shouldStartAsOutline(13, phone), true, '13 nodes on a phone');
  assert.equal(shouldStartAsOutline(12, phone), false, '12 nodes is still a small map');
  assert.equal(shouldStartAsOutline(10, phone), false);
  assert.equal(shouldStartAsOutline(0, phone), false);
  assert.equal(shouldStartAsOutline(31, phone), true);
  assert.equal(shouldStartAsOutline(40, { width: 1280, height: 800 }), false, 'a laptop opens on the canvas');
  assert.equal(shouldStartAsOutline(40, { width: 844, height: 390 }), true, 'a phone held sideways is a small screen too');
  assert.equal(shouldStartAsOutline(31, { width: 412, height: 915 }), true);
  assert.equal(shouldStartAsOutline(31, { width: 768, height: 1024 }), false, 'tablet portrait has room for the labels');
  assert.equal(shouldStartAsOutline(31), false, 'no viewport given');
  console.log('  ok - more than 12 nodes on a screen under 600 wide or 480 tall; otherwise the canvas');
}

console.log('=== 4. buildOutlineTree: the same nodes, nested the way the map branches ===');
{
  const nodes = [
    node('r', null, 1, 'Root'),
    node('a', 'r', 2, 'A'),
    node('a1', 'a', 3, 'A1'),
    node('a2', 'a', 3, 'A2'),
    node('b', 'r', 2, 'B'),
    node('b1', 'b', 3, 'B1'),
    node('b1x', 'b1', 4, 'B1x'),
    node('c', 'r', 2, 'C'),
  ];
  const tree = buildOutlineTree(nodes);
  assert.equal(tree.length, 1, 'one root');
  assert.equal(tree[0].node.id, 'r');
  assert.deepEqual(tree[0].children.map(e => e.node.id), ['a', 'b', 'c'], 'siblings keep their order');
  assert.deepEqual(tree[0].children[0].children.map(e => e.node.id), ['a1', 'a2']);
  assert.deepEqual(tree[0].children[1].children[0].children.map(e => e.node.id), ['b1x'], 'four levels deep');
  assert.deepEqual(tree[0].children[2].children, [], 'a leaf has an empty children list');
  assert.deepEqual(flatten(tree), nodes.map(n => n.id), 'reading the outline top to bottom is the order nodes arrived in');
  assert.equal(tree[0].node, nodes[0], 'the entry carries the node itself, not a copy');
  console.log('  ok - nesting, sibling order, depth and node identity');
}

console.log('=== 5. buildOutlineTree: input the layout engine would not produce ===');
{
  // A child listed before its parent still nests under it.
  const shuffled = [node('c', 'p', 2), node('p', null, 1), node('d', 'c', 3)];
  const t1 = buildOutlineTree(shuffled);
  assert.equal(t1.length, 1);
  assert.equal(t1[0].node.id, 'p');
  assert.deepEqual(t1[0].children.map(e => e.node.id), ['c']);
  assert.deepEqual(t1[0].children[0].children.map(e => e.node.id), ['d']);
  console.log('  ok - a child that arrives before its parent still nests under it');

  // A node whose parent does not exist becomes its own top-level row (never dropped).
  const orphan = [node('r', null, 1), node('x', 'ghost', 2), node('k', 'r', 2)];
  const t2 = buildOutlineTree(orphan);
  assert.deepEqual(t2.map(e => e.node.id), ['r', 'x']);
  assert.deepEqual(t2[0].children.map(e => e.node.id), ['k']);
  console.log('  ok - a missing parent makes the node a top-level row');

  // A node that names itself as its parent is treated as a root.
  const selfRef = [node('s', 's', 1)];
  assert.deepEqual(flatten(buildOutlineTree(selfRef)), ['s']);
  console.log('  ok - a self-parent does not loop');

  // A cycle that no root reaches is still listed, once each, and terminates.
  const cycle = [node('r', null, 1), node('a', 'b', 2), node('b', 'a', 2)];
  const t3 = buildOutlineTree(cycle);
  const ids = flatten(t3);
  assert.equal(ids.length, 3, 'every node exactly once');
  assert.deepEqual([...ids].sort(), ['a', 'b', 'r']);
  console.log('  ok - an unreachable cycle is listed once per node and terminates');

  // Several roots are all kept, in order.
  const forest = [node('r1', null, 1), node('r2', null, 1), node('k', 'r2', 2)];
  assert.deepEqual(buildOutlineTree(forest).map(e => e.node.id), ['r1', 'r2']);
  console.log('  ok - more than one root');

  // Nothing in, nothing out - and nothing throws.
  assert.deepEqual(buildOutlineTree([]), []);
  assert.deepEqual(buildOutlineTree(undefined), []);
  assert.deepEqual(buildOutlineTree(null), []);
  assert.deepEqual(buildOutlineTree('not a list'), []);
  console.log('  ok - empty and non-array input give an empty outline');
}

console.log('=== 6. buildOutlineTree: every node appears exactly once, at engine scale ===');
{
  // 40 nodes (the engine's cap), four levels deep, parents always earlier in the list - from a fixed seed.
  let seed = 12345;
  const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const nodes = [node('n0', null, 1)];
  for (let i = 1; i < 40; i++) {
    let parent;
    do { parent = nodes[Math.floor(rand() * nodes.length)]; } while (parent.depth >= 4);
    nodes.push(node(`n${i}`, parent.id, parent.depth + 1));
  }
  const tree = buildOutlineTree(nodes);
  const ids = flatten(tree);
  assert.equal(ids.length, 40);
  assert.equal(new Set(ids).size, 40, 'no duplicates');
  assert.deepEqual([...ids].sort(), nodes.map(n => n.id).sort(), 'no node lost');
  // Every entry sits one level below its parent's entry.
  const check = (entries, depth) => { for (const e of entries) { assert.equal(e.node.depth, depth); check(e.children, depth + 1); } };
  check(tree, 1);
  console.log('  ok - 40 generated nodes: all present once, each one level below its parent');
}

console.log('\nAll mind-map-outline unit tests passed! ✨');
