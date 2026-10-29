import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import type { NightDigest } from '../src/digest/types.js';

const night = '2026-10-28';
const firstAt = '2026-10-28T22:00:00+05:30';
const lastAt = '2026-10-28T23:00:00+05:30';

function run(job: string, extra: Record<string, unknown> = {}) {
  return { at: firstAt, job, status: 'ok', owner: 'team', ...extra };
}

function tableRows(html: string): string[] {
  const body = /<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i.exec(html);
  expect(body).not.toBeNull();
  return Array.from(
    body![1].matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi),
    ([row]) => row,
  );
}

function cells(row: string): string[] {
  return Array.from(
    row.matchAll(/<(td|th)\b[^>]*>([^<]*)<\/\1>/gi),
    ([, , text]) => text,
  );
}

function hasWarning(row: string): boolean {
  return /\bclass="[^"]*\bwarn\b[^"]*"/.test(row);
}

describe('digest routes', () => {
  let runsDir: string;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    runsDir = mkdtempSync(join(tmpdir(), 'rig-digest-routes-'));
    vi.stubEnv('LANE_MARKER', 'DIGEST-TEST-MARKER');
    app = createApp({
      adapter: 'shim',
      installed: '2026-10-29T14:06:00+01:00',
      beatEverySeconds: 60,
      runsDir,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(runsDir, { recursive: true, force: true });
  });

  function writeNight(lines: unknown[], name = night) {
    writeFileSync(
      join(runsDir, `${name}.jsonl`),
      lines.map((line) =>
        typeof line === 'string' ? line : JSON.stringify(line),
      ).join('\n'),
    );
  }

  async function getDigest(name = night) {
    const [page, api] = await Promise.all([
      app.request(`/digest/${name}`),
      app.request(`/api/digest/${name}`),
    ]);
    return { page, api };
  }

  it('renders the same sorted jobs as JSON and marks retries and recovered failures', async () => {
    writeNight([
      run('zulu', { status: 'fail' }),
      run('bravo', { status: 'retry' }),
      run('alpha', { status: 'retry', owner: null }),
      run('bravo', { status: 'retry' }),
      run('alpha', { status: 'retry', owner: null }),
      run('zulu', { at: lastAt }),
      run('alpha', { status: 'retry', owner: null, at: lastAt }),
      run('bravo', { at: lastAt }),
    ]);

    const { page, api } = await getDigest();
    expect(page.status).toBe(200);
    expect(api.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(api.headers.get('content-type')).toContain('application/json');

    const digest = await api.json() as NightDigest;
    expect(digest.night).toBe(night);
    expect(digest.badLines).toBe(0);
    expect(digest.counts).toEqual({ ok: 2, retry: 5, fail: 1 });
    expect(digest.rows.map((row) => row.job))
      .toEqual(['alpha', 'bravo', 'zulu']);
    expect(digest.rows[0]).toMatchObject({
      owner: null, runs: 3, retries: 3, firstAt, lastAt,
    });
    expect(digest.rows[2]).toMatchObject({
      fails: 1, lastStatus: 'ok',
    });

    const html = await page.text();
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('DIGEST-TEST-MARKER');
    expect(html).toMatch(/<style\b/i);
    expect(html).not.toMatch(/<script\b/i);

    const rows = tableRows(html);
    expect(rows.map((row) => cells(row)[0]))
      .toEqual(digest.rows.map((row) => row.job));
    expect(cells(rows[0]).filter((cell) => cell === '—')).toHaveLength(2);
    expect(rows.map(hasWarning)).toEqual([true, false, true]);
    expect(html).toContain(firstAt);
    expect(html).toContain(lastAt);
  });

  it('returns 404 for a missing night', async () => {
    const { page, api } = await getDigest();
    expect(page.status).toBe(404);
    expect(api.status).toBe(404);
    expect(await api.json()).toEqual({ error: 'night not found' });
  });

  it('renders an empty night', async () => {
    writeNight([]);
    const { page, api } = await getDigest();
    expect(page.status).toBe(200);
    expect(api.status).toBe(200);
    expect(await page.text()).toContain('nothing ran');
    expect(await api.json()).toEqual({
      night, rows: [], badLines: 0,
      counts: { ok: 0, retry: 0, fail: 0 },
    });
  });

  it('keeps valid records and reports bad lines', async () => {
    writeNight([run('kept'), '{broken']);
    const { page, api } = await getDigest();
    expect(page.status).toBe(200);
    expect(api.status).toBe(200);
    expect(await api.json()).toMatchObject({
      badLines: 1,
      counts: { ok: 1, retry: 0, fail: 0 },
      rows: [{ job: 'kept' }],
    });
    const html = await page.text();
    expect(tableRows(html).map((row) => cells(row)[0])).toEqual(['kept']);
    expect(html).toContain('bad lines: 1');
  });

  it.each([
    'not-a-night', '2026-10-28.jsonl', '..%2F2026-10-28', '2026-02-30',
  ])('rejects invalid or unsafe night %s', async (name) => {
    writeNight([run('unexpected')], 'not-a-night');
    writeNight([run('unexpected')], '2026-10-28.jsonl');
    const { page, api } = await getDigest(name);
    expect(page.status).toBe(404);
    expect(api.status).toBe(404);
    expect(await api.json()).toEqual({ error: 'night not found' });
  });

  it('escapes log values in HTML without altering JSON', async () => {
    const job = '<script>alert(1)</script>';
    const owner = '<img src=x onerror=alert(2)>';
    const error = '<svg onload=alert(3)>';
    writeNight([run(job, { status: 'fail', owner, error })]);
    const { page, api } = await getDigest();
    expect(page.status).toBe(200);
    expect(api.status).toBe(200);
    expect(await api.json()).toMatchObject({
      rows: [{ job, owner, lastError: error }],
    });
    const html = await page.text();
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(2)&gt;');
    expect(html).toContain('&lt;svg onload=alert(3)&gt;');
    expect(html).not.toMatch(/<(?:script|img|svg)\b/i);
  });

  it('links both fixture nights from the board with record counts', async () => {
    for (const name of ['2026-10-27', night]) {
      copyFileSync(
        new URL(`../runs/${name}.jsonl`, import.meta.url),
        join(runsDir, `${name}.jsonl`),
      );
    }
    const board = await app.request('/');
    expect(board.status).toBe(200);
    const html = await board.text();
    expect(html).toContain('ok 7 / retry 0 / fail 0');
    expect(html).toContain('ok 10 / retry 4 / fail 1');
    for (const name of ['2026-10-27', night]) {
      expect(html).toContain(`href="/digest/${name}"`);
      expect((await app.request(`/digest/${name}`)).status).toBe(200);
    }
  });
});
