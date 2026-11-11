#!/usr/bin/env node
// Writes the run diagram generated from src/run-shape.mjs between the markers in docs/reference.md.
// `npm run build:diagram` writes it; `-- --check` exits 1 when the committed copy differs.
import { readFileSync, writeFileSync } from 'node:fs';
import { diagram } from '../src/run-shape.mjs';

const file = new URL('../docs/reference.md', import.meta.url);
const [open, close] = ['<!-- run-diagram:start -->', '<!-- run-diagram:end -->'];
const text = readFileSync(file, 'utf8');
const [head, rest] = text.split(open), tail = rest?.split(close)[1];
if (tail === undefined) { console.error(`docs/reference.md needs ${open} and ${close}`); process.exit(2); }
const next = `${head}${open}\n${diagram()}\n${close}${tail}`;
if (process.argv.includes('--check')) {
  if (next !== text) { console.error('docs/reference.md run diagram is stale: run npm run build:diagram'); process.exit(1); }
} else writeFileSync(file, next);
