const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function formatHour(h: number, m = 0): string {
  const hour = h % 12 || 12;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const min = String(m).padStart(2, '0');
  return `${hour}:${min} ${ampm}`;
}

function dayName(d: number | string): string {
  return DAYS[Number(d)] || String(d);
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function describeDow(dow: string): string {
  if (dow === '*') return 'Daily';
  if (dow === '1-5' || dow === 'MON-FRI') return 'Weekdays';
  if (dow === '0,6' || dow === 'SAT,SUN' || dow === '6,0') return 'Weekends';

  if (/^\d-\d$/.test(dow)) {
    const [start, end] = dow.split('-').map(Number);
    return `${dayName(start)} - ${dayName(end)}`;
  }

  if (/^\d$/.test(dow)) return `${dayName(parseInt(dow))}s`;

  if (dow.includes(',')) {
    const days = dow.split(',').map((d) => {
      const n = parseInt(d);
      return isNaN(n) ? d : dayName(n);
    });
    return days.join(', ');
  }

  if (/^[A-Z]{3}$/.test(dow)) return dow.charAt(0) + dow.slice(1).toLowerCase() + 's';

  return dow;
}

export default function humanCron(expression: string): string {
  if (!expression || typeof expression !== 'string') return '';

  const parts = expression.trim().split(/\s+/);
  if (parts.length < 5) return expression;

  const [minute, hour, dom, month, dow] = parts;

  if (minute === '*' && hour === '*' && dom === '*' && dow === '*') {
    return 'Every minute';
  }

  if (minute.startsWith('*/') && hour === '*' && dom === '*') {
    const n = parseInt(minute.slice(2));
    return n === 1 ? 'Every minute' : `Every ${n} minutes`;
  }

  if (minute.includes(',') && hour === '*' && dom === '*' && dow === '*') {
    const mins = minute.split(',').map((m) => `:${String(parseInt(m)).padStart(2, '0')}`);
    return `Every hour at ${mins.join(' and ')}`;
  }

  if (/^\d+$/.test(minute) && hour === '*' && dom === '*' && dow === '*') {
    const m = parseInt(minute);
    return m === 0 ? 'Every hour' : `Every hour at :${String(m).padStart(2, '0')}`;
  }

  if (/^\d+$/.test(minute) && hour.startsWith('*/') && dom === '*') {
    const n = parseInt(hour.slice(2));
    return n === 1 ? 'Every hour' : `Every ${n} hours`;
  }

  if (/^\d+$/.test(minute) && dom === '*' && month === '*') {
    const m = parseInt(minute);

    if (hour.includes(',')) {
      const hours = hour.split(',').map((h) => formatHour(parseInt(h), m));
      const timeStr = hours.join(', ');
      if (dow === '*') return `Daily at ${timeStr}`;
      return `${describeDow(dow)} at ${timeStr}`;
    }

    if (/^\d+$/.test(hour)) {
      const h = parseInt(hour);
      const timeStr = formatHour(h, m);

      if (dow === '*') return `Daily at ${timeStr}`;
      return `${describeDow(dow)} at ${timeStr}`;
    }

    if (hour.includes('-') && hour.includes('/')) {
      const [range, step] = hour.split('/');
      const [start, end] = range.split('-').map(Number);
      const n = parseInt(step);
      const timeRange = `${formatHour(start, m)} - ${formatHour(end, m)}`;
      if (dow === '*') return `Every ${n} hours ${timeRange}`;
      return `${describeDow(dow)} every ${n} hours ${timeRange}`;
    }

    if (hour.includes('-') && !hour.includes('/')) {
      const [start, end] = hour.split('-').map(Number);
      const timeRange = `${formatHour(start, m)} - ${formatHour(end, m)}`;
      if (dow === '*') return `Hourly ${timeRange}`;
      return `${describeDow(dow)} hourly ${timeRange}`;
    }
  }

  if (
    /^\d+$/.test(minute) &&
    /^\d+$/.test(hour) &&
    /^\d+$/.test(dom) &&
    month === '*' &&
    dow === '*'
  ) {
    return `${ordinal(parseInt(dom))} of every month at ${formatHour(parseInt(hour), parseInt(minute))}`;
  }

  if (
    /^\d+$/.test(minute) &&
    /^\d+$/.test(hour) &&
    /^\d+$/.test(dom) &&
    /^\d+$/.test(month) &&
    dow === '*'
  ) {
    const months = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    const monthName = months[parseInt(month) - 1] || month;
    return `${monthName} ${ordinal(parseInt(dom))} at ${formatHour(parseInt(hour), parseInt(minute))}`;
  }

  return expression;
}
