import { useState, useEffect, useCallback } from 'react';
import { Tag, ExternalLink, RefreshCw, Sparkles } from 'lucide-react';
import { getServerBase, getAuthHeaders } from '../utils/connection';

function formatReleaseDate(iso: any) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return null;
  }
}

export default function ReleasesView({ initialVersion }: any) {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [pickedVersion, setPickedVersion] = useState(initialVersion ?? null);

  const load = useCallback(
    async (refresh: any = false) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (pickedVersion) params.set('version', pickedVersion);
        if (refresh) params.set('refresh', '1');
        const qs = params.toString();
        const res = await fetch(`${getServerBase()}/api/releases${qs ? `?${qs}` : ''}`, {
          headers: getAuthHeaders(),
        });
        if (!res.ok) {
          let detail = `HTTP ${res.status}`;
          try {
            const body = await res.json();
            if (body.error) detail = body.error;
          } catch {
            /* ignore */
          }
          throw new Error(detail);
        }
        const json = await res.json();
        setData(json);
      } catch (err: any) {
        // Keep the previously-rendered release list on screen so a failed
        // Refresh click (network blip, GitHub 5xx) only surfaces the error
        // banner — it doesn't wipe what the user was looking at.
        setError(err.message || String(err));
      } finally {
        setLoading(false);
      }
    },
    [pickedVersion],
  );

  useEffect(() => {
    load(false);
  }, [load]);

  const selected = data?.selected ?? null;
  const list = data?.releases ?? [];

  return (
    <div className="flex flex-col h-full bg-gray-950 text-gray-100">
      <header className="flex items-center justify-between gap-3 px-6 py-4 border-b border-gray-800 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Sparkles size={20} className="text-emerald-400 shrink-0" />
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-white truncate">What&apos;s new</h1>
            <p className="text-xs text-gray-500 truncate">
              Agent Hub release notes
              {data?.currentVersion ? (
                <>
                  {' '}
                  · you&apos;re on{' '}
                  <span className="font-mono text-gray-400">v{data.currentVersion}</span>
                </>
              ) : null}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => load(true)}
          disabled={loading}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-gray-700 text-gray-300 hover:bg-gray-800 disabled:opacity-50"
          title="Refresh release list"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </header>

      {error && (
        <div className="mx-6 mt-4 px-4 py-3 rounded-lg bg-red-950/50 border border-red-800 text-sm text-red-200">
          {error}
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        <aside className="w-56 shrink-0 border-r border-gray-800 overflow-y-auto">
          {loading && list.length === 0 ? (
            <p className="px-4 py-6 text-xs text-gray-500">Loading releases…</p>
          ) : list.length === 0 ? (
            <p className="px-4 py-6 text-xs text-gray-500">No releases found.</p>
          ) : (
            <ul className="py-2">
              {list.map((r: any) => {
                const active = selected?.version === r.version;
                const isCurrent = data?.currentVersion === r.version;
                return (
                  <li key={r.tag}>
                    <button
                      type="button"
                      onClick={() => setPickedVersion(r.version)}
                      className={`w-full text-left px-4 py-2.5 text-sm transition-colors ${
                        active
                          ? 'bg-gray-800 text-white'
                          : 'text-gray-400 hover:bg-gray-900 hover:text-gray-200'
                      }`}
                    >
                      <div className="flex items-center gap-1.5">
                        <Tag size={12} className="shrink-0 opacity-60" />
                        <span className="font-mono">v{r.version}</span>
                        {isCurrent && (
                          <span className="text-[10px] px-1 py-0.5 rounded bg-emerald-900/50 text-emerald-300">
                            current
                          </span>
                        )}
                      </div>
                      {r.summary && (
                        <p className="mt-0.5 text-[11px] text-gray-500 line-clamp-2 pl-[18px]">
                          {r.summary}
                        </p>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        <main className="flex-1 overflow-y-auto px-6 py-6">
          {!selected && !loading ? (
            <p className="text-sm text-gray-500">Select a version to see what changed.</p>
          ) : selected ? (
            <article className="max-w-2xl">
              <div className="flex flex-wrap items-center gap-2 mb-1">
                <h2 className="text-2xl font-semibold text-white font-mono">v{selected.version}</h2>
                {data?.currentVersion === selected.version && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-900/40 text-emerald-300 border border-emerald-800/50">
                    Your version
                  </span>
                )}
              </div>
              {formatReleaseDate(selected.publishedAt) && (
                <p className="text-xs text-gray-500 mb-4">
                  Released {formatReleaseDate(selected.publishedAt)}
                </p>
              )}
              <p className="text-sm text-gray-300 mb-6">{selected.summary}</p>

              {selected.sections.length === 0 ? (
                <p className="text-sm text-gray-500">
                  No user-facing highlights were recorded for this release.
                </p>
              ) : (
                <div className="space-y-6">
                  {selected.sections.map((section: any) => (
                    <section key={section.title}>
                      <h3 className="text-sm font-semibold text-gray-200 mb-2">{section.title}</h3>
                      <ul className="space-y-2">
                        {section.items.map((item: any, idx: any) => (
                          <li
                            key={`${section.title}-${idx}`}
                            className="text-sm text-gray-300 flex gap-2 leading-relaxed"
                          >
                            <span className="text-emerald-500 shrink-0 mt-0.5">•</span>
                            <span>{item.text}</span>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))}
                </div>
              )}

              {selected.url && (
                <a
                  href={selected.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 mt-8 text-sm text-emerald-400 hover:text-emerald-300"
                >
                  View on GitHub
                  <ExternalLink size={14} />
                </a>
              )}
            </article>
          ) : (
            <p className="text-sm text-gray-500">Loading…</p>
          )}
        </main>
      </div>
    </div>
  );
}
