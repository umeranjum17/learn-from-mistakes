// markdown-log: a defect log in Markdown. Each top-level "- " bullet is one record.
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { readText, shq } from '../../bin/learn-from-mistakes-axi.mjs';
import { pathSource, PROJECT_FILE } from '../config.mjs';
import { inWindow } from '../metrics.mjs';

export const validate = pathSource;
// init: the first defect log at a usual place.
export function detect(dir) {
  const path = ['defects.md', 'docs/defects.md', 'DEFECTS.md'].find((f) => statSync(join(dir, f), { throwIfNoEntry: false })?.isFile());
  return path && { type: 'markdown-log', path };
}

// Each record's id comes from its text, so it survives line moves.
export function read(source, { path }, { project = PROJECT_FILE } = {}) {
  const text = readText(path, `source ${source}`, `check sources.${source}.path in ${shq(project)}, or create it: touch ${shq(path)}`);
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

// doctor: readable, the records dated in the window, and the bullets with no date, which the window cannot place.
export function doctor(source, entry, { readFrom, project }) {
  const { records } = read(source, entry, { project });
  const undated = records.filter((r) => !r.date).length;
  const inWin = records.filter((r) => Date.parse(r.date) >= readFrom).length;
  return { level: 'ok', detail: `${records.length} records, ${inWin} in the window, ${undated} skipped (no date)` };
}

// defects: the records dated in the window, over every markdown-log source; n/a when no record has a date.
export const metricNames = ['defects'];
export const metricRows = 'records';
export const metrics = (rows, window) => ({ defects: rows.some((r) => r.ts) ? inWindow(rows, window).length : null });
