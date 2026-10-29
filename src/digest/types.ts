export type DigestStatus = 'ok' | 'retry' | 'fail';

export type DigestCounts = {
  ok: number;
  retry: number;
  fail: number;
};

export type DigestRow = {
  job: string;
  owner: string | null;
  runs: number;
  retries: number;
  fails: number;
  lastStatus: DigestStatus;
  lastError: string | null;
  firstAt: string;
  lastAt: string;
};

export type NightDigest = {
  night: string;
  rows: DigestRow[];
  badLines: number;
  counts: DigestCounts;
};

// The reader implementation will export readNight with this signature.
// null means the file is missing; an empty file returns an empty digest.
export type ReadNight = (
  runsDir: string,
  night: string,
) => NightDigest | null;
