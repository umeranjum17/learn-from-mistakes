#!/usr/bin/env node
// Writes the diagrams generated from src/run-shape.mjs between their markers in docs/reference.md: a run's moves and a fix's.
// `npm run build:diagram` writes them; `-- --check` exits 1 when the committed copy differs.
import { readFileSync, writeFileSync } from 'node:fs';
import { diagram, FIX_MOVES, MOVES } from '../src/run-shape.mjs';

const file = new URL('../docs/reference.md', import.meta.url);
const diagrams = { run: diagram(MOVES), fix: diagram(FIX_MOVES, ['worked', 'reverted']) };
const original = readFileSync(file, 'utf8');
let text = original;
for (const [name, body] of Object.entries(diagrams)) {
  const [open, close] = [`<!-- ${name}-diagram:start -->`, `<!-- ${name}-diagram:end -->`];
  const [head, rest] = text.split(open), tail = rest?.split(close)[1];
  if (tail === undefined) { console.error(`docs/reference.md needs ${open} and ${close}`); process.exit(2); }
  text = `${head}${open}\n${body}\n${close}${tail}`;
}
if (process.argv.includes('--check')) {
  if (text !== original) { console.error('docs/reference.md diagrams are stale: run npm run build:diagram'); process.exit(1); }
} else writeFileSync(file, text);
