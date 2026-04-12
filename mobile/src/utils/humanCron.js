// Convert a cron expression to a human-readable string.
// Handles common patterns without requiring an external library.

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function formatHour(h, m = 0) {
  const hour = h % 12 || 12;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const min = String(m).padStart(2, '0');
  return `${hour}:${min} ${ampm}`;
}

function dayName(d) {
  return DAYS[d] || d;
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export default function humanCron(expression) {
  if (!expression || typeof expression !== 'string') return '';

  const parts = expression.trim().split(/\s+/);
  if (parts.length < 5) return expression;

  const [minute, hour, dom, month, dow] = parts;

  // Every minute: * * * * *
  if (minute === '*' && hour === '*' && dom === '*' && dow === '*') {
    return 'Every minute';
  }

  // Every N minutes: */N * * * *
  if (minute.startsWith('*/') && hour === '*' && dom === '*') {
    const n = parseInt(minute.slice(2));
    return n === 1 ? 'Every minute' : `Every ${n} minutes`;
  }

  // Specific minutes list: 0,30 * * * * → "Every hour at :00 and :30"
  if (minute.includes(',') && hour === '*' && dom === '*' && dow === '*') {
    const mins = minute.split(',').map((m) => `:${String(parseInt(m)).padStart(2, '0')}`);
    return `Every hour at ${mins.join(' and ')}`;
  }

  // Every hour: 0 * * * *
  if (/^\d+$/.test(minute) && hour === '*' && dom === '*' && dow === '*') {
    const m = parseInt(minute);
    return m === 0 ? 'Every hour' : `Every hour at :${String(m).padStart(2, '0')}`;
  }

  // Every N hours: 0 */N * * *
  if (/^\d+$/.test(minute) && hour.startsWith('*/') && dom === '*') {
    const n = parseInt(hour.slice(2));
    return n === 1 ? 'Every hour' : `Every ${n} hours`;
  }

  // Specific hour(s), every day or specific days
  if (/^\d+$/.test(minute) && dom === '*' && month === '*') {
    const m = parseInt(minute);

    // Multiple hours: 0 9,17 * * *
    if (hour.includes(',')) {
      const hours = hour.split(',').map((h) => formatHour(parseInt(h), m));
      const timeStr = hours.join(', ');
      if (dow === '*') return `Daily at ${timeStr}`;
      return `${describeDow(dow)} at ${timeStr}`;
    }

    // Single hour
    if (/^\d+$/.test(hour)) {
      const h = parseInt(hour);
      const timeStr = formatHour(h, m);

      if (dow === '*') return `Daily at ${timeStr}`;
      return `${describeDow(dow)} at ${timeStr}`;
    }

    // Hour range with step: 0 9-17/2 * * * → "Every 2 hours 9:00 AM - 5:00 PM"
    if (hour.includes('-') && hour.includes('/')) {
      const [range, step] = hour.split('/');
      const [start, end] = range.split('-').map(Number);
      const n = parseInt(step);
      const timeRange = `${formatHour(start, m)} - ${formatHour(end, m)}`;
      if (dow === '*') return `Every ${n} hours ${timeRange}`;
      return `${describeDow(dow)} every ${n} hours ${timeRange}`;
    }

    // Hour range: 0 9-17 * * *
    if (hour.includes('-') && !hour.includes('/')) {
      const [start, end] = hour.split('-').map(Number);
      const timeRange = `${formatHour(start, m)} - ${formatHour(end, m)}`;
      if (dow === '*') return `Hourly ${timeRange}`;
      return `${describeDow(dow)} hourly ${timeRange}`;
    }
  }

  // Monthly on specific day: 0 9 1 * *
  if (
    /^\d+$/.test(minute) &&
    /^\d+$/.test(hour) &&
    /^\d+$/.test(dom) &&
    month === '*' &&
    dow === '*'
  ) {
    return `${ordinal(parseInt(dom))} of every month at ${formatHour(parseInt(hour), parseInt(minute))}`;
  }

  // Yearly / specific month: 0 9 1 6 *
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && /^\d+$/.test(dom) && /^\d+$/.test(month) && dow === '*') {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monthName = months[parseInt(month) - 1] || month;
    return `${monthName} ${ordinal(parseInt(dom))} at ${formatHour(parseInt(hour), parseInt(minute))}`;
  }

  // Fallback — return the raw expression
  return expression;
}

function describeDow(dow) {
  if (dow === '*') return 'Daily';
  if (dow === '1-5' || dow === 'MON-FRI') return 'Weekdays';
  if (dow === '0,6' || dow === 'SAT,SUN' || dow === '6,0') return 'Weekends';

  // Day range: 1-3 → "Mon - Wed"
  if (/^\d-\d$/.test(dow)) {
    const [start, end] = dow.split('-').map(Number);
    return `${dayName(start)} - ${dayName(end)}`;
  }

  // Single day
  if (/^\d$/.test(dow)) return `${dayName(parseInt(dow))}s`;

  // Comma-separated days
  if (dow.includes(',')) {
    const days = dow.split(',').map((d) => {
      const n = parseInt(d);
      return isNaN(n) ? d : dayName(n);
    });
    return days.join(', ');
  }

  // Named days (MON, TUE, etc.)
  if (/^[A-Z]{3}$/.test(dow)) return dow.charAt(0) + dow.slice(1).toLowerCase() + 's';

  return dow;
}
