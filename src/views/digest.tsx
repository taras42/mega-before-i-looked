import type { NightDigest } from '../digest/types.js';

export function DigestPage({ digest }: { digest: NightDigest }) {
  return (
    <>
      <h1>digest · {digest.night}</h1>
      <p>
        ok: {digest.counts.ok} · retry: {digest.counts.retry} · fail: {digest.counts.fail}
      </p>
      <p class={digest.badLines > 0 ? 'warn' : 'mute'}>
        bad lines: {digest.badLines}
      </p>
      {digest.rows.length === 0 ? (
        <p class="mute">nothing ran</p>
      ) : (
        <table>
          <caption>Jobs for {digest.night}</caption>
          <thead>
            <tr>
              <th scope="col">job</th>
              <th scope="col">owner</th>
              <th scope="col">runs</th>
              <th scope="col">retries</th>
              <th scope="col">fails</th>
              <th scope="col">last status</th>
              <th scope="col">last error</th>
              <th scope="col">first at</th>
              <th scope="col">last at</th>
            </tr>
          </thead>
          <tbody>
            {digest.rows.map((row) => (
              <tr>
                <th scope="row">{row.job}</th>
                <td>{row.owner ?? '—'}</td>
                <td>{row.runs}</td>
                <td class={row.retries >= 3 ? 'warn' : undefined}>
                  {row.retries >= 3 ? `${row.retries} (3 or more)` : row.retries}
                </td>
                <td class={row.fails > 0 ? 'warn' : undefined}>
                  {row.fails > 0
                    ? `${row.fails} ${row.fails === 1 ? 'failure' : 'failures'}`
                    : row.fails}
                </td>
                <td class={row.lastStatus === 'fail' ? 'warn' : undefined}>
                  {row.lastStatus}
                </td>
                <td>{row.lastError ?? '—'}</td>
                <td>{row.firstAt}</td>
                <td>{row.lastAt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
