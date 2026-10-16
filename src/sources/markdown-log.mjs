// markdown-log: a defect log in Markdown. Each top-level "- " bullet is one record.
import { createHash, createHmac } from 'node:crypto';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { readText, shq, UsageError } from '../../bin/learn-from-mistakes-axi.mjs';
import { expand, mapping } from '../config.mjs';
import { inWindow } from '../metrics.mjs';

// A markdown-log source is a defect log, unless review: true marks it as a review log (its records do not count as
// defects). The boolean itself is checked in config.mjs, with the other source keys; an unknown key stays an error.
export function validate(s, where, dir) {
  mapping(s, ['type', 'path', 'review'], where);
  if (typeof s.path !== 'string') throw new UsageError(`${where}.path must be a string`);
  return { ...s, path: expand(s.path, dir) };
}
const REVIEWS = 'reviews';
// init: the first defect log at a usual place, as log, and a review log, as reviews.
export function detect(dir) {
  const at = (...paths) => paths.find((f) => statSync(join(dir, f), { throwIfNoEntry: false })?.isFile());
  const found = Object.entries({ log: at('defects.md', 'docs/defects.md', 'DEFECTS.md', 'data/defects.md'), [REVIEWS]: at('reviews.md') }).filter(([, path]) => path);
  return Object.fromEntries(found.map(([id, path]) => [id, { type: 'markdown-log', path, ...(id === REVIEWS ? { review: true } : {}) }]));
}

// Each record's id is an HMAC of its text keyed with the run store's salt: it survives line moves, and whoever reads a
// bundle without the store cannot hash a guessed text to it.
export function read(source, { path }, { project, salt }) {
  const text = readText(path, `source ${source}`, `check sources.${source}.path in ${shq(project)}, or create it: touch ${shq(path)}`);
  const seen = new Map();
  let date = '';
  const records = [];
  text.split('\n').forEach((line, i) => {
    if (line.startsWith('## ')) date = line.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? '';
    if (!line.startsWith('- ')) return;
    const body = line.slice(2).trim();
    let id = createHmac('sha256', salt).update(body.toLowerCase().replace(/\s+/g, ' ')).digest('hex').slice(0, 12);
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    if (n > 1) id += `~${n}`;
    records.push({ id, source, line: i + 1, date: body.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? date, text: body });
  });
  return { records, hash: createHash('sha256').update(text).digest('hex') };
}

// doctor: readable, the records dated in the window, and the bullets with no date, which the window cannot place.
export function doctor(source, entry, { readFrom, project, salt }) {
  const { records } = read(source, entry, { project, salt });
  const undated = records.filter((r) => !r.date).length;
  const inWin = records.filter((r) => Date.parse(r.date) >= readFrom).length;
  return { level: 'ok', detail: `${records.length} records, ${inWin} in the window, ${undated} skipped (no date)` };
}

// defects: the records dated in the window, over the defect logs (not the review logs); n/a when no defect record has
// a date. A source with review: true is a review log; without the flag, a source id of reviews keeps today's meaning,
// so configs that already exist do not change their numbers.
export const metricNames = ['defects'];
export const metricRows = 'records';
export const metrics = (rows, window, v, sources) => {
  const defects = rows.filter((r) => !(sources ? (sources[r.source]?.review ?? r.source === REVIEWS) : r.source === REVIEWS));
  return { defects: defects.some((r) => r.ts) ? inWindow(defects, window).length : null };
};
