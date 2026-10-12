// markdown-log: a defect log in Markdown. Each top-level "- " bullet is one record.
import { createHash } from 'node:crypto';
import { readText } from '../../bin/learn-from-mistakes-axi.mjs';
import { pathSource } from '../config.mjs';
import { inWindow } from '../metrics.mjs';

export const validate = pathSource;

// Each record's id comes from its text, so it survives line moves.
export function read(source, { path }) {
  const text = readText(path, `source ${source}`);
  const seen = new Map();
  let date = '';
  const records = [];
  text.split('\n').forEach((line, i) => {
    if (line.startsWith('## ')) date = line.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? '';
    if (!line.startsWith('- ')) return;
    const body = line.slice(2).trim();
    let id = createHash('sha256').update(body.toLowerCase().replace(/\s+/g, ' ')).digest('hex').slice(0, 12);
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    if (n > 1) id += `~${n}`;
    records.push({ id, source, line: i + 1, date: body.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? date, text: body });
  });
  return { records, hash: createHash('sha256').update(text).digest('hex') };
}

// defects: the records dated in the window, over every markdown-log source; n/a when no record has a date.
export const metricNames = ['defects'];
export const metricRows = 'records';
export const metrics = (rows, window) => ({ defects: rows.some((r) => r.ts) ? inWindow(rows, window).length : null });
