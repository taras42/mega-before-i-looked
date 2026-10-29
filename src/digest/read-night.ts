import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DigestRow, DigestStatus, ReadNight } from './types.js';

type Run = {
  at: string;
  job: string;
  status: DigestStatus;
  owner: string | null;
  error?: string;
};

function validNight(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) &&
    new Date(time).toISOString().slice(0, 10) === value;
}

function validTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) &&
    validNight(value.slice(0, 10)) &&
    Number.isFinite(Date.parse(value));
}

function parseRun(line: string): Run | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const { at, job, status, owner, error } = record;
  if (
    typeof at !== 'string' || !validTimestamp(at) ||
    typeof job !== 'string' || job.trim() === '' ||
    (status !== 'ok' && status !== 'retry' && status !== 'fail') ||
    (owner !== null && typeof owner !== 'string') ||
    (error !== undefined && typeof error !== 'string')
  ) {
    return null;
  }

  return { at, job, status, owner, error };
}

export const readNight: ReadNight = (runsDir, night) => {
  if (!validNight(night)) return null;

  let text: string;
  try {
    text = readFileSync(join(runsDir, `${night}.jsonl`), 'utf8');
  } catch (error) {
    if (
      typeof error === 'object' && error !== null &&
      'code' in error && error.code === 'ENOENT'
    ) {
      return null;
    }
    throw error;
  }

  const runs: Run[] = [];
  let badLines = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const run = parseRun(line);
    if (run === null) badLines++;
    else runs.push(run);
  }

  // Stable sorting preserves file order when timestamps identify the same instant.
  runs.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  const counts = { ok: 0, retry: 0, fail: 0 };
  const rows = new Map<string, DigestRow>();
  for (const run of runs) {
    counts[run.status]++;
    let row = rows.get(run.job);
    if (!row) {
      row = {
        job: run.job,
        owner: run.owner,
        runs: 0,
        retries: 0,
        fails: 0,
        lastStatus: run.status,
        lastError: null,
        firstAt: run.at,
        lastAt: run.at,
      };
      rows.set(run.job, row);
    }

    row.runs++;
    if (run.status === 'retry') row.retries++;
    if (run.status === 'fail') row.fails++;
    row.owner = run.owner;
    row.lastStatus = run.status;
    row.lastAt = run.at;
    if (run.error !== undefined) row.lastError = run.error;
  }

  return {
    night,
    rows: [...rows.values()].sort((a, b) =>
      a.job < b.job ? -1 : a.job > b.job ? 1 : 0,
    ),
    badLines,
    counts,
  };
};
