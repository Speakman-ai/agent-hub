import { useState, useEffect, useCallback } from 'react';
import { Activity, AlertTriangle, Clock, ShieldAlert, RefreshCw, ServerCrash } from 'lucide-react';
import { api } from '../utils/api.js';

/**
 * Container-pool observability dashboard (W4).
 *
 * Renders the active alerts banner and a row of inline-SVG sparklines for
 * the four pool_metrics series (pool_util, queue_depth, evictions, reaps)
 * plus the cert-days-remaining big-number tile. Pulls every 60 s from
 * `/api/pool/metrics?windowHours=24` and `/api/pool/alerts?status=active`.
 *
 * Inline SVG keeps us free of a charting dependency — these sparklines
 * are diagnostic, not analytical, and a dozen lines of path math is far
 * less weight than a chart library on the bundle. Empty datasets render
 * a neutral placeholder rather than a 1-px line at zero.
 */
export default function PoolSection() {
  const [windowHours, setWindowHours] = useState(24);
  const [samples, setSamples] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const [metricsRes, alertsRes] = await Promise.all([
        api.getPoolMetrics(windowHours),
        api.getPoolAlerts('active'),
      ]);
      setSamples(Array.isArray(metricsRes?.samples) ? metricsRes.samples : []);
      setAlerts(Array.isArray(alertsRes?.alerts) ? alertsRes.alerts : []);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err.message || 'Failed to load pool metrics');
    } finally {
      setLoading(false);
    }
  }, [windowHours]);

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load]);

  const latest = samples.length > 0 ? samples[samples.length - 1] : null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-lg font-semibold text-white flex items-center gap-2">
            <Activity size={18} className="text-blue-400" />
            Container Pool
          </h3>
          <p className="text-xs text-gray-400 mt-0.5">
            PR-env / scaffold pool utilization, queue depth, and cert expiry — last {windowHours}h.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={windowHours}
            onChange={(e) => setWindowHours(Number(e.target.value))}
            className="bg-gray-800 border border-gray-700 text-white text-xs rounded-lg px-2 py-1.5"
            aria-label="Time window"
          >
            <option value={1}>1h</option>
            <option value={6}>6h</option>
            <option value={24}>24h</option>
            <option value={72}>3d</option>
            <option value={168}>7d</option>
          </select>
          <button
            onClick={load}
            disabled={loading}
            className="flex items-center gap-1.5 bg-gray-800 hover:bg-gray-700 text-white text-xs px-3 py-1.5 rounded-lg disabled:opacity-50"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 text-sm text-red-300"
        >
          {error}
        </div>
      )}

      {/* Active alerts */}
      <AlertsList alerts={alerts} />

      {/* Latest snapshot tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Tile
          label="Pool util"
          value={latest ? `${(latest.pool_util * 100).toFixed(0)}%` : '—'}
          tone={latest && latest.pool_util > 0.9 ? 'critical' : 'default'}
        />
        <Tile
          label="Queue depth"
          value={latest != null ? String(latest.queue_depth) : '—'}
          subtitle={
            latest
              ? `pr_env=${latest.queue_depth_pr_env ?? 0} · scaffold=${latest.queue_depth_scaffold ?? 0}`
              : ''
          }
          tone={latest && latest.queue_depth > 5 ? 'warn' : 'default'}
        />
        <Tile label="Evictions (last)" value={latest != null ? String(latest.evictions) : '—'} />
        <Tile
          label="Cert days left"
          value={
            latest && latest.cert_days_remaining != null
              ? latest.cert_days_remaining.toFixed(1)
              : '—'
          }
          tone={
            latest && latest.cert_days_remaining != null && latest.cert_days_remaining < 14
              ? 'critical'
              : 'default'
          }
        />
      </div>

      {/* Sparklines */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <SparklineCard
          title="Pool utilization"
          unit="%"
          values={samples.map((s) => s.pool_util * 100)}
          color="#60a5fa"
          warnAt={90}
        />
        <SparklineCard
          title="Queue depth"
          values={samples.map((s) => s.queue_depth)}
          color="#fbbf24"
          warnAt={5}
        />
        <SparklineCard
          title="Evictions / sample"
          values={samples.map((s) => s.evictions)}
          color="#f87171"
        />
        <SparklineCard
          title="Reaps / sample"
          values={samples.map((s) => s.reaps)}
          color="#a78bfa"
        />
      </div>

      <div className="text-xs text-gray-500 text-right">
        {samples.length} samples ·{' '}
        {lastUpdated ? `updated ${lastUpdated.toLocaleTimeString()}` : 'loading...'}
      </div>
    </div>
  );
}

function AlertsList({ alerts }) {
  if (!alerts || alerts.length === 0) {
    return (
      <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-xl p-3 text-sm text-emerald-300 flex items-center gap-2">
        <Activity size={14} />
        No active pool alerts.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {alerts.map((a) => (
        <AlertRow key={a.id} alert={a} />
      ))}
    </div>
  );
}

function AlertRow({ alert }) {
  const Icon = iconForAlert(alert.alert_type);
  const toneClass =
    alert.severity === 'critical'
      ? 'bg-red-500/10 border-red-500/30 text-red-200'
      : alert.severity === 'warn'
        ? 'bg-amber-500/10 border-amber-500/30 text-amber-200'
        : 'bg-gray-500/10 border-gray-500/30 text-gray-200';
  return (
    <div className={`border rounded-xl p-3 flex items-start gap-3 ${toneClass}`} role="alert">
      <Icon size={18} className="mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">{labelForAlert(alert.alert_type)}</div>
        <div className="text-xs opacity-90">{alert.message}</div>
        <div className="text-[11px] opacity-70 mt-1">
          fired {alert.fired_at} · severity={alert.severity}
        </div>
      </div>
    </div>
  );
}

function iconForAlert(type) {
  switch (type) {
    case 'pool_util_high':
      return ServerCrash;
    case 'queue_depth_high':
      return Clock;
    case 'cert_expiring':
      return ShieldAlert;
    default:
      return AlertTriangle;
  }
}

function labelForAlert(type) {
  switch (type) {
    case 'pool_util_high':
      return 'Pool utilization sustained > 90%';
    case 'queue_depth_high':
      return 'Queue depth exceeds threshold';
    case 'cert_expiring':
      return 'Wildcard cert expiring soon';
    default:
      return type;
  }
}

function Tile({ label, value, subtitle, tone = 'default' }) {
  const toneClass =
    tone === 'critical'
      ? 'border-red-500/40 bg-red-500/5'
      : tone === 'warn'
        ? 'border-amber-500/40 bg-amber-500/5'
        : 'border-gray-700 bg-gray-800/40';
  return (
    <div className={`border rounded-xl p-3 ${toneClass}`}>
      <div className="text-[11px] uppercase tracking-wide text-gray-400">{label}</div>
      <div className="text-2xl font-semibold text-white mt-1">{value}</div>
      {subtitle && <div className="text-[11px] text-gray-500 mt-1">{subtitle}</div>}
    </div>
  );
}

function SparklineCard({ title, values, color, unit, warnAt }) {
  return (
    <div className="border border-gray-700 bg-gray-800/40 rounded-xl p-3">
      <div className="flex items-baseline justify-between mb-2">
        <div className="text-xs text-gray-300 font-medium">{title}</div>
        <div className="text-xs text-gray-500">
          {values.length > 0
            ? `${values[values.length - 1].toFixed(unit === '%' ? 0 : 1)}${unit ?? ''}`
            : '—'}
        </div>
      </div>
      <Sparkline values={values} color={color} warnAt={warnAt} />
    </div>
  );
}

/**
 * Tiny inline-SVG sparkline. 100×24 viewBox so it scales cleanly to any
 * container width via preserveAspectRatio. Renders a flat baseline when
 * values are empty/all-zero so we never collapse to a single point.
 */
export function Sparkline({ values, color = '#60a5fa', warnAt }) {
  const w = 100;
  const h = 24;
  const padding = 2;

  if (!values || values.length === 0) {
    return (
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="w-full h-12 text-gray-600"
        preserveAspectRatio="none"
        role="img"
        aria-label="No data"
      >
        <line x1={0} y1={h / 2} x2={w} y2={h / 2} stroke="currentColor" strokeDasharray="2 2" />
      </svg>
    );
  }

  const max = Math.max(...values, warnAt ?? 0, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const stepX = values.length === 1 ? 0 : (w - padding * 2) / (values.length - 1);

  const points = values.map((v, i) => {
    const x = padding + i * stepX;
    const y = h - padding - ((v - min) / range) * (h - padding * 2);
    return [x, y];
  });

  const pathD = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(2)},${p[1].toFixed(2)}`)
    .join(' ');

  // Build a closed area for a subtle fill underneath.
  const areaD =
    `${pathD} L${points[points.length - 1][0].toFixed(2)},${h - padding} ` +
    `L${points[0][0].toFixed(2)},${h - padding} Z`;

  const warnY = warnAt != null ? h - padding - ((warnAt - min) / range) * (h - padding * 2) : null;

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="w-full h-12"
      preserveAspectRatio="none"
      role="img"
      aria-label={`Sparkline with ${values.length} samples`}
    >
      <path d={areaD} fill={color} fillOpacity="0.15" />
      <path d={pathD} stroke={color} strokeWidth="1.2" fill="none" />
      {warnY != null && warnY >= 0 && warnY <= h && (
        <line
          x1={0}
          y1={warnY}
          x2={w}
          y2={warnY}
          stroke="#f87171"
          strokeWidth="0.5"
          strokeDasharray="2 2"
          opacity="0.7"
        />
      )}
    </svg>
  );
}
