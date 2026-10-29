import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { readNight } from '../src/digest/read-night.js';

const night = '2026-10-28';
const fixtures = fileURLToPath(new URL('../runs/', import.meta.url));
const temporaryDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rig-digest-'));
  temporaryDirs.push(dir);
  return dir;
}

function readLines(lines: unknown[]) {
  const dir = tempDir();
  writeFileSync(
    join(dir, `${night}.jsonl`),
    lines.map((line) => JSON.stringify(line)).join('\n'),
  );
  return readNight(dir, night);
}

function run(overrides: Record<string, unknown> = {}) {
  return {
    at: '2026-10-28T23:00:00+01:00',
    job: 'lane/sync',
    status: 'ok',
    owner: 'rook',
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('readNight', () => {
  it('reads the immutable fixture, counting records rather than final statuses', () => {
    const digest = readNight(fixtures, night);
    expect(digest).not.toBeNull();
    expect(digest?.night).toBe(night);
    expect(digest?.badLines).toBe(1);
    expect(digest?.counts).toEqual({ ok: 10, retry: 4, fail: 1 });
    expect(digest?.rows.map((row) => row.job)).toEqual([
      'digest/render',
      'fixtures/refresh',
      'lane/sync',
      'notes/backup',
      'rig/rotate-logs',
    ]);
    expect(digest?.rows[0]).toMatchObject({ owner: null, runs: 1 });
    expect(digest?.rows[1]).toMatchObject({
      runs: 4,
      retries: 3,
      fails: 0,
      lastStatus: 'ok',
      lastError: 'upstream 503',
    });
    expect(digest?.rows[2]).toMatchObject({
      runs: 8,
      retries: 1,
      lastError: 'lock held',
    });
    expect(digest?.rows[3]).toMatchObject({
      fails: 1,
      lastStatus: 'fail',
      lastError: 'quota exceeded',
    });
  });

  it('distinguishes a missing file from an empty or blank file', () => {
    const dir = tempDir();
    expect(readNight(dir, night)).toBeNull();

    for (const text of ['', ' \n\t\r\n']) {
      writeFileSync(join(dir, `${night}.jsonl`), text);
      expect(readNight(dir, night)).toEqual({
        night,
        rows: [],
        badLines: 0,
        counts: { ok: 0, retry: 0, fail: 0 },
      });
    }
  });

  it('counts malformed JSON and invalid shapes, but ignores blank lines', () => {
    const invalid = [
      null,
      [],
      42,
      {},
      run({ at: 'yesterday' }),
      run({ at: '2026-02-30T12:00:00Z' }),
      run({ at: '2026-10-28T24:00:00Z' }),
      run({ at: '2026-10-28T12:00:00' }),
      run({ at: '2026-10-28T12:00:00+25:00' }),
      run({ job: '  ' }),
      run({ job: 42 }),
      run({ status: 'pending' }),
      run({ owner: undefined }),
      run({ owner: 42 }),
      run({ error: { message: 'broken' } }),
      run({ error: null }),
    ];
    const dir = tempDir();
    writeFileSync(
      join(dir, `${night}.jsonl`),
      [
        ' ',
        '{broken',
        ...invalid.map((value) => JSON.stringify(value)),
        '',
        JSON.stringify(run({ owner: null })),
        '\t',
      ].join('\r\n'),
    );

    const digest = readNight(dir, night);
    expect(digest?.badLines).toBe(invalid.length + 1);
    expect(digest?.counts).toEqual({ ok: 1, retry: 0, fail: 0 });
    expect(digest?.rows).toHaveLength(1);
    expect(digest?.rows[0].owner).toBeNull();
  });

  it('uses chronological instants, preserves offsets, and breaks ties by file order', () => {
    const digest = readLines([
      run({
        at: '2026-10-28T11:00:00Z',
        status: 'retry',
        error: 'latest error',
        owner: 'later',
      }),
      run({
        at: '2026-10-28T12:00:00+02:00',
        status: 'fail',
        error: 'earlier error',
        owner: 'earlier',
      }),
      run({
        at: '2026-10-28T06:00:00-05:00',
        owner: null,
      }),
    ]);

    expect(digest?.rows).toEqual([{
      job: 'lane/sync',
      owner: null,
      runs: 3,
      retries: 1,
      fails: 1,
      lastStatus: 'ok',
      lastError: 'latest error',
      firstAt: '2026-10-28T12:00:00+02:00',
      lastAt: '2026-10-28T06:00:00-05:00',
    }]);
    expect(digest?.counts).toEqual({ ok: 1, retry: 1, fail: 1 });
  });

  it('preserves file order for equal earliest timestamps too', () => {
    const digest = readLines([
      run({ at: '2026-10-28T12:00:00+02:00' }),
      run({ at: '2026-10-28T10:00:00Z', owner: null }),
    ]);

    expect(digest?.rows[0]).toMatchObject({
      firstAt: '2026-10-28T12:00:00+02:00',
      lastAt: '2026-10-28T10:00:00Z',
      owner: null,
    });
  });

  it('sorts job strings deterministically without locale-dependent ordering', () => {
    const digest = readLines(
      ['z', 'a', 'Z', 'A', '__proto__'].map((job) => run({ job })),
    );
    expect(digest?.rows.map((row) => row.job)).toEqual([
      'A', 'Z', '__proto__', 'a', 'z',
    ]);
  });

  it('retains recovered failures and accepts an explicitly supplied empty error', () => {
    const digest = readLines([
      run({ status: 'fail', error: 'failed' }),
      run({ status: 'retry', error: '' }),
      run(),
    ]);
    expect(digest?.rows[0]).toMatchObject({
      runs: 3,
      retries: 1,
      fails: 1,
      lastStatus: 'ok',
      lastError: '',
    });
  });

  it('rejects traversal and invalid nights before touching the filesystem', () => {
    for (const invalid of [
      '../2026-10-28',
      'nested/2026-10-28',
      '..\\2026-10-28',
      '/2026-10-28',
      '2026-10-28.jsonl',
      '2026-02-30',
      '2026-13-01',
      '2026-1-01',
      '2026-10-28\n',
      '',
    ]) {
      // A filesystem read using this directory would throw, not return ENOENT.
      expect(readNight('\0', invalid)).toBeNull();
    }
    expect(() => readNight('\0', night)).toThrow();
  });

  it('does not swallow filesystem errors other than ENOENT', () => {
    const file = join(tempDir(), 'not-a-directory');
    writeFileSync(file, '');
    expect(() => readNight(file, night)).toThrowError(
      expect.objectContaining({ code: 'ENOTDIR' }),
    );
  });
});
