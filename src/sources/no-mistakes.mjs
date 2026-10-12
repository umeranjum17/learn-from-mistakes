// no-mistakes: failed pipeline steps from a no-mistakes state database, opened read-only. One fixed query; no user SQL.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { UsageError } from '../../bin/learn-from-mistakes-axi.mjs';
import { pathSource } from '../config.mjs';

export const validate = pathSource;

// Its identity is the sha256 of the rows read, so it follows content, not file time. A row takes the first cause
// whose match rule names this source and whose error_contains is in its error.
// node:sqlite is loaded here, and only here, so runs that never read a store never warn about it.
export async function read(source, { path }, { causes = {} } = {}) {
  const fix = `remove the ${source} source or point its path at your no-mistakes state.sqlite`;
  if (!existsSync(path)) throw new UsageError(`source ${source}: no such file`, fix);
  let db;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(path, { readOnly: true });
    const rows = db.prepare(`SELECT s.id, s.run_id, s.step_name, s.error, COALESCE(s.completed_at, s.started_at) AS t, r.branch
      FROM step_results s JOIN runs r ON r.id = s.run_id WHERE s.status = 'failed' ORDER BY t, s.id`).all();
    const tag = (error) => Object.entries(causes).find(([, c]) => c.match?.source === source && error.includes(c.match.error_contains))?.[0] ?? null;
    return { rows: rows.map((r) => ({ id: r.id, source, run: r.run_id, step: r.step_name, branch: r.branch,
      at: r.t ? new Date(r.t > 1e11 ? r.t : r.t * 1000).toISOString() : '', error: r.error ?? '', cause: tag(r.error ?? '') })),
      hash: createHash('sha256').update(JSON.stringify(rows)).digest('hex') };
  } catch (e) {
    throw new UsageError(`source ${source}: not a readable no-mistakes store (${e.message})`, fix);
  } finally { db?.close(); }
}
