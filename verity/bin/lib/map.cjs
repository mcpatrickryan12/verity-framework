// Codebase Mapper (framework-spec.md §6, Role 14) — on-demand, generated code-STRUCTURE
// diagram (distinct from the Planner's Gantt/schedule). Walks the directory tree and
// emits a Mermaid graph to codebase-map.md. Never hand-maintained — regenerate anytime.
const fs = require('node:fs');
const path = require('node:path');

const IGNORE = new Set(['node_modules', '.git', 'dist', '.verity', '.verity-cache']);

function build(cwd, maxDepth) {
  const rootName = path.basename(path.resolve(cwd)) || 'root';
  const nodes = [];
  const edges = [];
  const ids = new Map();
  let counter = 0;

  const idFor = (key, label) => {
    if (!ids.has(key)) {
      const id = `n${counter}`;
      counter += 1;
      ids.set(key, id);
      nodes.push({ id, label });
    }
    return ids.get(key);
  };

  const walk = (dir, parentKey, parentId, depth) => {
    if (depth >= maxDepth) {
      return;
    }
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const dirs = entries
      .filter((e) => e.isDirectory() && !IGNORE.has(e.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const e of dirs) {
      const childKey = `${parentKey}/${e.name}`;
      const childId = idFor(childKey, e.name);
      edges.push([parentId, childId]);
      walk(path.join(dir, e.name), childKey, childId, depth + 1);
    }
  };

  const rootId = idFor(rootName, rootName);
  walk(cwd, rootName, rootId, 0);
  return { nodes, edges };
}

function render({ nodes, edges }) {
  const lines = ['# Codebase Map', '', '```mermaid', 'graph TD'];
  for (const n of nodes) {
    lines.push(`  ${n.id}["${n.label}"]`);
  }
  for (const [from, to] of edges) {
    lines.push(`  ${from} --> ${to}`);
  }
  lines.push('```', '');
  return lines.join('\n');
}

function generate(cwd, opts = {}) {
  const maxDepth = Number(opts.depth) > 0 ? Number(opts.depth) : 2;
  const graph = build(cwd, maxDepth);
  const out = path.join(cwd, 'codebase-map.md');
  fs.writeFileSync(out, render(graph));
  return { path: out, nodes: graph.nodes.length, edges: graph.edges.length };
}

function dispatch(args, flags) {
  const cwd = flags.cwd || process.cwd();
  return generate(cwd, { depth: flags.depth });
}

module.exports = { build, render, generate, dispatch };
