import { getOwnerPool } from "@/backend/db/pools";
import { LOG_LEVELS, TIME_RANGES, searchLogs, type LogLevel, type TimeRange } from "@/backend/logs/explore";
import { requireDashboardSession } from "@/lib/session";
import { formatNumber } from "@/components/format";

export const metadata = { title: "Logs · Claude SRE" };
export const dynamic = "force-dynamic";

const LIMITS = [100, 250, 500, 1000] as const;
const LEVEL_CLASS: Record<LogLevel, string> = { fatal: "sev-critical", error: "sev-high", warn: "sev-medium", info: "sev-low" };

type Params = { source?: string | string[]; level?: string | string[]; range?: string; q?: string; limit?: string };
const many = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? [v] : []);

export default async function LogsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const { org, query } = await requireDashboardSession();
  const params = await searchParams;

  // RLS: only this organization's sources come back, so any id not in this list is ignored.
  const sources = await query<{ id: string; source_name: string; service_name: string | null; environment: string | null; region: string | null }>(
    `select s.id, s.source_name, s.service_name, s.environment, c.region
       from public.log_sources s join public.log_connectors c on c.id = s.connector_id
      where s.organization_id = $1 and c.provider = 'cloudwatch'
      order by s.source_name`,
    [org.id],
  );
  const known = new Set(sources.map((s) => s.id));
  const selectedSources = many(params.source).filter((id) => known.has(id));
  const levelsParam = many(params.level).filter((l): l is LogLevel => (LOG_LEVELS as readonly string[]).includes(l));
  const submitted = params.range !== undefined;
  const selectedLevels: LogLevel[] = submitted ? levelsParam : ["fatal", "error", "warn"];
  const range: TimeRange = params.range && params.range in TIME_RANGES ? (params.range as TimeRange) : "1h";
  const text = (params.q ?? "").slice(0, 200);
  const limit = LIMITS.find((l) => String(l) === params.limit) ?? 250;

  const result = selectedSources.length
    ? await searchLogs(getOwnerPool(), { sourceIds: selectedSources, levels: selectedLevels, range, text, limit })
    : undefined;
  const failed = result?.sources.filter((s) => s.error) ?? [];
  const truncated = result?.sources.filter((s) => s.truncated) ?? [];

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Logs</h1>
          <p className="muted">Search CloudWatch live across several log groups. Lines are redacted; nothing is stored.</p>
        </div>
      </div>

      {sources.length === 0 ? (
        <div className="card empty">No CloudWatch log sources yet. Add one under Log Sources.</div>
      ) : (
        <form action="/logs" className="card stack" style={{ marginBottom: 16 }}>
          <fieldset className="filter-group">
            <legend>Log sources</legend>
            <div className="check-grid">
              {sources.map((s) => (
                <label key={s.id} className="check">
                  <input type="checkbox" name="source" value={s.id}
                         defaultChecked={submitted ? selectedSources.includes(s.id) : sources.length <= 5} />
                  <span className="mono">{s.source_name}</span>
                  <span className="muted">{[s.service_name, s.environment, s.region].filter(Boolean).join(" · ")}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="filter-group">
            <legend>Levels</legend>
            <div className="row">
              {LOG_LEVELS.map((l) => (
                <label key={l} className="check inline">
                  <input type="checkbox" name="level" value={l} defaultChecked={selectedLevels.includes(l)} />
                  <span className={`badge ${LEVEL_CLASS[l]}`}>{l}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="row" style={{ alignItems: "flex-end" }}>
            <label className="field" style={{ flex: "2 1 240px" }}>
              <span>Contains text</span>
              <input name="q" defaultValue={text} placeholder='e.g. TypeError or req-123 (exact, case-sensitive)' />
            </label>
            <label className="field" style={{ flex: "1 1 120px" }}>
              <span>Time range</span>
              <select name="range" defaultValue={range}>
                {Object.keys(TIME_RANGES).map((r) => <option key={r} value={r}>Last {r}</option>)}
              </select>
            </label>
            <label className="field" style={{ flex: "1 1 100px" }}>
              <span>Max lines</span>
              <select name="limit" defaultValue={String(limit)}>
                {LIMITS.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            </label>
            <button type="submit" className="btn primary">Search</button>
          </div>
        </form>
      )}

      {result && (
        <>
          <p className="muted" style={{ margin: "0 0 8px" }}>
            {formatNumber(result.lines.length)} line(s) shown ·{" "}
            {result.sources.map((s) => `${s.logGroup}: ${formatNumber(s.matched)} of ${formatNumber(s.scanned)} scanned`).join(" · ")}
          </p>
          {truncated.length > 0 && (
            <p className="muted" style={{ margin: "0 0 8px" }}>
              Scan stopped early for {truncated.map((s) => s.logGroup).join(", ")}. Narrow the time range or add text to see older lines.
            </p>
          )}
          {failed.map((s) => <p key={s.id} className="error" style={{ marginBottom: 8 }}>{s.logGroup}: {s.error}</p>)}

          <div className="table-wrap">
            {result.lines.length === 0 ? (
              <div className="empty">No matching lines.</div>
            ) : (
              <table>
                <thead>
                  <tr><th>Time</th><th>Level</th><th>Source</th><th>Message</th></tr>
                </thead>
                <tbody>
                  {result.lines.map((l, i) => (
                    <tr key={`${l.sourceId}-${l.time}-${i}`}>
                      <td className="mono" style={{ whiteSpace: "nowrap" }}>{new Date(l.time).toLocaleString()}</td>
                      <td><span className={`badge ${LEVEL_CLASS[l.level]}`}>{l.level}</span></td>
                      <td>
                        <div className="mono">{l.logGroup}</div>
                        {l.service && <div className="muted">{l.service}</div>}
                      </td>
                      <td>
                        <pre className="log-line">{l.message}</pre>
                        {(l.requestId || l.traceId || l.stream) && (
                          <div className="muted mono">
                            {[l.stream && `stream ${l.stream}`, l.requestId && `req ${l.requestId}`, l.traceId && `trace ${l.traceId}`].filter(Boolean).join(" · ")}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
      {!result && sources.length > 0 && <p className="muted">Pick one or more log sources and press Search.</p>}
    </>
  );
}
