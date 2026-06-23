import { useState, useEffect, useCallback } from 'react';
import humanCron from '@shared/utils/humanCron';

/**
 * Parse a cron expression into picker state.
 * Returns { mode, interval, unit, hour, minute } or null if not parseable into a simple mode.
 */
function parseCronToState(expr: any) {
  if (!expr || typeof expr !== 'string') return null;
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) return null;

  const [min, hr, dom, , dow] = parts;

  // Every N minutes: */N * * * *
  if (min.startsWith('*/') && hr === '*' && dom === '*' && dow === '*') {
    return { mode: 'every', interval: parseInt(min.slice(2)), unit: 'minutes' };
  }

  // Every minute: * * * * *
  if (min === '*' && hr === '*' && dom === '*' && dow === '*') {
    return { mode: 'every', interval: 1, unit: 'minutes' };
  }

  // Every N hours: M */N * * *
  if (/^\d+$/.test(min) && hr.startsWith('*/') && dom === '*' && dow === '*') {
    return { mode: 'every', interval: parseInt(hr.slice(2)), unit: 'hours' };
  }

  // Every hour: M * * * *
  if (/^\d+$/.test(min) && hr === '*' && dom === '*' && dow === '*') {
    return { mode: 'every', interval: 1, unit: 'hours' };
  }

  // Daily at H:M: M H * * *
  if (/^\d+$/.test(min) && /^\d+$/.test(hr) && dom === '*' && dow === '*') {
    return { mode: 'daily', hour: parseInt(hr), minute: parseInt(min) };
  }

  return null;
}

/** Build a cron expression from picker state */
function buildCron(state: any) {
  if (state.mode === 'every') {
    if (state.unit === 'minutes') {
      return state.interval === 1 ? '* * * * *' : `*/${state.interval} * * * *`;
    }
    if (state.unit === 'hours') {
      return state.interval === 1 ? '0 * * * *' : `0 */${state.interval} * * *`;
    }
  }
  if (state.mode === 'daily') {
    return `${state.minute} ${state.hour} * * *`;
  }
  return '';
}

const inputClass =
  'bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600';
const selectClass =
  'bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600 appearance-none cursor-pointer';

export default function CronSchedulePicker({ value, onChange }: any) {
  // Determine initial mode from existing value
  const parsed = parseCronToState(value);
  const initialMode = parsed ? parsed.mode : value ? 'cron' : 'every';

  const [mode, setMode] = useState(initialMode);
  const [freq, setFreq] = useState(parsed?.interval ?? 30);
  const [unit, setUnit] = useState(parsed?.unit ?? 'minutes');
  const [hour, setHour] = useState(parsed?.hour ?? 9);
  const [minute, setMinute] = useState(parsed?.minute ?? 0);
  const [rawCron, setRawCron] = useState(value || '');

  // Sync picker → parent onChange
  const emitChange = useCallback(
    (m: any, opts: any) => {
      let cron: any;
      if (m === 'cron') {
        cron = opts.raw || '';
      } else if (m === 'every') {
        cron = buildCron({ mode: 'every', interval: opts.interval, unit: opts.unit });
      } else if (m === 'daily') {
        cron = buildCron({ mode: 'daily', hour: opts.hour, minute: opts.minute });
      }
      onChange(cron);
    },
    [onChange],
  );

  // When mode changes, emit immediately
  const handleModeChange = (newMode: any) => {
    setMode(newMode);
    if (newMode === 'every') {
      emitChange('every', { interval: freq, unit });
    } else if (newMode === 'daily') {
      emitChange('daily', { hour, minute });
    } else if (newMode === 'cron') {
      emitChange('cron', { raw: rawCron });
    }
  };

  const handleIntervalChange = (val: any) => {
    const n = Math.max(1, parseInt(val) || 1);
    setFreq(n);
    emitChange('every', { interval: n, unit });
  };

  const handleUnitChange = (val: any) => {
    setUnit(val);
    emitChange('every', { interval: freq, unit: val });
  };

  const handleHourChange = (val: any) => {
    const h = parseInt(val);
    setHour(h);
    emitChange('daily', { hour: h, minute });
  };

  const handleMinuteChange = (val: any) => {
    const m = parseInt(val);
    setMinute(m);
    emitChange('daily', { hour, minute: m });
  };

  const handleRawChange = (val: any) => {
    setRawCron(val);
    emitChange('cron', { raw: val });
  };

  // Re-sync if external value changes (e.g. when editing a different cron)
  useEffect(() => {
    const p = parseCronToState(value);
    if (p) {
      setMode(p.mode);
      if (p.mode === 'every') {
        setFreq(p.interval ?? 1);
        setUnit(p.unit ?? 'hours');
      } else if (p.mode === 'daily') {
        setHour(p.hour ?? 0);
        setMinute(p.minute ?? 0);
      }
    } else if (value) {
      setMode('cron');
      setRawCron(value);
    }
  }, [value]);

  // Generate hour options
  const hours = Array.from({ length: 24 }, (_: any, i: any) => i);
  const minutes = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];

  const formatHour12 = (h: any) => {
    const hr12 = h % 12 || 12;
    const ampm = h >= 12 ? 'PM' : 'AM';
    return `${hr12} ${ampm}`;
  };

  return (
    <div className="space-y-2">
      {/* Mode selector */}
      <div className="flex gap-1">
        {[
          { key: 'every', label: 'Every' },
          { key: 'daily', label: 'Daily' },
          { key: 'cron', label: 'Cron' },
        ].map((opt: any) => (
          <button
            key={opt.key}
            type="button"
            onClick={() => handleModeChange(opt.key)}
            className={`text-xs px-3 py-1.5 rounded-lg transition-colors ${
              mode === opt.key
                ? 'bg-blue-600 text-white'
                : 'bg-gray-700 text-gray-400 hover:bg-gray-600 hover:text-gray-200'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Picker content */}
      {mode === 'every' && (
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-400">Every</span>
          <input
            type="number"
            min={1}
            max={unit === 'minutes' ? 59 : 23}
            value={freq}
            onChange={(e: any) => handleIntervalChange(e.target.value)}
            className={`${inputClass} w-16 text-center`}
          />
          <select
            value={unit}
            onChange={(e: any) => handleUnitChange(e.target.value)}
            className={selectClass}
          >
            <option value="minutes">minutes</option>
            <option value="hours">hours</option>
          </select>
        </div>
      )}

      {mode === 'daily' && (
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-400">Every day at</span>
          <select
            value={hour}
            onChange={(e: any) => handleHourChange(e.target.value)}
            className={selectClass}
          >
            {hours.map((h: any) => (
              <option key={h} value={h}>
                {formatHour12(h)}
              </option>
            ))}
          </select>
          <span className="text-gray-500">:</span>
          <select
            value={minute}
            onChange={(e: any) => handleMinuteChange(e.target.value)}
            className={selectClass}
          >
            {minutes.map((m: any) => (
              <option key={m} value={m}>
                {String(m).padStart(2, '0')}
              </option>
            ))}
          </select>
        </div>
      )}

      {mode === 'cron' && (
        <div>
          <input
            value={rawCron}
            onChange={(e: any) => handleRawChange(e.target.value)}
            placeholder="Cron expression (e.g. */30 * * * *)"
            className={`${inputClass} w-full`}
          />
          {rawCron && humanCron(rawCron) !== rawCron && (
            <p className="text-xs text-blue-400 mt-1 ml-1">↳ {humanCron(rawCron)}</p>
          )}
        </div>
      )}

      {/* Show human-readable preview for non-cron modes */}
      {mode !== 'cron' && value && <p className="text-xs text-gray-500 ml-1">{humanCron(value)}</p>}
    </div>
  );
}
