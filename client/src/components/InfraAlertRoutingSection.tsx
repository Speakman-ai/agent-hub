import { useEffect, useRef, useState } from 'react';
import { BellRing, Loader2 } from 'lucide-react';
import { api } from '../utils/api';

const SEVERITIES = ['critical', 'warning', 'info'] as const;
const CHANNELS = [
  ['in_app', 'In-app'],
  ['push', 'Mobile push'],
  ['email', 'Email'],
] as const;

export default function InfraAlertRoutingSection({
  projectId,
  showToast,
}: {
  projectId?: string | null;
  showToast?: (message: string, type?: string) => void;
}) {
  const [routing, setRouting] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestGeneration = useRef(0);

  useEffect(() => {
    const generation = ++requestGeneration.current;
    setRouting([]);
    setError(null);
    setSaving(null);
    if (!projectId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .getInfraAlertRouting(projectId)
      .then((response: any) => {
        if (!cancelled && requestGeneration.current === generation) {
          setRouting(response.routing || []);
        }
      })
      .catch((err: any) => {
        if (!cancelled && requestGeneration.current === generation) {
          setRouting([]);
          setError(err?.message || 'Infrastructure alert routing is unavailable.');
        }
      })
      .finally(() => {
        if (!cancelled && requestGeneration.current === generation) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const valueFor = (severity: string, channel: string): boolean =>
    routing.find((entry) => entry.severity === severity)?.channels?.[channel] ?? false;

  const toggle = async (severity: string, channel: string) => {
    if (!projectId || saving) return;
    const key = `${severity}:${channel}`;
    const generation = requestGeneration.current;
    setSaving(key);
    try {
      const response = await api.updateInfraAlertRouting(projectId, {
        severity,
        channel,
        enabled: !valueFor(severity, channel),
      });
      if (requestGeneration.current === generation) {
        setRouting(response.routing || []);
        showToast?.('Infrastructure alert routing saved', 'success');
      }
    } catch (err: any) {
      if (requestGeneration.current === generation) {
        setError(err?.message || 'Failed to save alert routing.');
      }
    } finally {
      if (requestGeneration.current === generation) setSaving(null);
    }
  };

  if (!projectId) return null;
  return (
    <section
      className="rounded-xl border border-gray-800 bg-gray-900/40 p-4"
      data-testid="infra-alert-routing"
    >
      <div className="flex items-center gap-2 mb-1">
        <BellRing size={15} className="text-amber-400" />
        <h3 className="text-sm font-medium text-gray-200">Infrastructure alert delivery</h3>
      </div>
      <p className="text-xs text-gray-500 mb-3">
        Choose where each severity goes. Missing overrides use the safe project defaults.
      </p>
      {error && <p className="text-xs text-red-400 mb-2">{error}</p>}
      {loading ? (
        <Loader2 size={15} className="animate-spin text-gray-500" />
      ) : (
        <div className="space-y-2">
          {SEVERITIES.map((severity) => (
            <div key={severity} className="grid grid-cols-[80px_1fr] items-center gap-2">
              <span className="text-xs capitalize text-gray-400">{severity}</span>
              <div className="flex flex-wrap gap-2">
                {CHANNELS.map(([channel, label]) => {
                  const key = `${severity}:${channel}`;
                  const enabled = valueFor(severity, channel);
                  return (
                    <button
                      key={channel}
                      type="button"
                      disabled={saving !== null}
                      onClick={() => void toggle(severity, channel)}
                      className={`rounded border px-2 py-1 text-[11px] transition-colors ${
                        enabled
                          ? 'border-emerald-700 bg-emerald-900/30 text-emerald-300'
                          : 'border-gray-700 text-gray-500'
                      } disabled:opacity-50`}
                      aria-pressed={enabled}
                    >
                      {saving === key ? (
                        <Loader2 size={11} className="inline animate-spin" />
                      ) : (
                        label
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
