import { useMemo } from 'react';
import { AlertCircle, ChevronLeft, ChevronRight, Loader2, RefreshCw } from 'lucide-react';
import {
  buildMonthGrid,
  eventChipTime,
  monthLabel,
  WEEKDAY_LABELS,
  type CalendarEventLike,
} from '@shared/utils/calendarEvents';

const MAX_CHIPS = 3;

export default function CalendarMonthView<T extends CalendarEventLike>({
  month,
  events,
  loading,
  error,
  onRetry,
  onPrev,
  onNext,
  onToday,
  onSelectEvent,
}: {
  month: Date;
  events: T[];
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  onSelectEvent: (event: T) => void;
}) {
  const days = useMemo(() => buildMonthGrid(month, events), [month, events]);

  return (
    <section className="mt-6" aria-label="Month view">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h3 className="text-lg font-semibold text-white">{monthLabel(month)}</h3>
          {loading && <Loader2 size={14} className="animate-spin text-gray-500" />}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onPrev}
            aria-label="Previous month"
            className="rounded border border-gray-700 p-1.5 text-gray-300 hover:bg-gray-800"
          >
            <ChevronLeft size={14} />
          </button>
          <button
            type="button"
            onClick={onToday}
            className="rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:bg-gray-800"
          >
            Today
          </button>
          <button
            type="button"
            onClick={onNext}
            aria-label="Next month"
            className="rounded border border-gray-700 p-1.5 text-gray-300 hover:bg-gray-800"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>
      {error && (
        <div
          role="alert"
          className="mb-3 flex items-center justify-between gap-3 rounded border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200"
        >
          <div className="flex items-start gap-2">
            <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
            <span>
              Couldn&apos;t load events for {monthLabel(month)}: {error}
            </span>
          </div>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              disabled={loading}
              className="inline-flex flex-shrink-0 items-center gap-1 rounded border border-red-400/40 px-2 py-1 text-xs text-red-100 hover:bg-red-500/20 disabled:opacity-50"
            >
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
              Retry
            </button>
          )}
        </div>
      )}
      <div className="overflow-hidden rounded-lg border border-gray-800 bg-gray-900">
        <div className="grid grid-cols-7 border-b border-gray-800">
          {WEEKDAY_LABELS.map((label) => (
            <div
              key={label}
              className="px-2 py-1.5 text-center text-[11px] font-medium uppercase tracking-wide text-gray-500"
            >
              {label}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {days.map((day, index) => {
            const hidden = day.events.length - MAX_CHIPS;
            return (
              <div
                key={day.key}
                data-testid={`calendar-day-${day.key}`}
                className={`min-h-24 border-gray-800 p-1.5 ${index % 7 !== 6 ? 'border-r' : ''} ${
                  index < 35 ? 'border-b' : ''
                } ${day.inMonth ? '' : 'bg-gray-950/60'}`}
              >
                <div
                  className={`mb-1 flex h-6 w-6 items-center justify-center rounded-full text-xs ${
                    day.isToday
                      ? 'bg-blue-600 font-semibold text-white'
                      : day.inMonth
                        ? 'text-gray-300'
                        : 'text-gray-600'
                  }`}
                >
                  {day.dayOfMonth}
                </div>
                <div className="space-y-0.5">
                  {day.events.slice(0, MAX_CHIPS).map((event, i) => {
                    const time = eventChipTime(event);
                    const allDay = !!event.start?.date;
                    return (
                      <button
                        type="button"
                        key={`${event.id || event.summary || 'event'}-${i}`}
                        onClick={() => onSelectEvent(event)}
                        title={event.summary || '(no title)'}
                        className={`block w-full truncate rounded px-1 py-0.5 text-left text-[11px] ${
                          allDay
                            ? 'bg-blue-600/30 text-blue-100 hover:bg-blue-600/40'
                            : 'text-gray-200 hover:bg-gray-800'
                        }`}
                      >
                        {time && <span className="mr-1 text-gray-500">{time}</span>}
                        {event.summary || '(no title)'}
                      </button>
                    );
                  })}
                  {hidden > 0 && (
                    <div className="px-1 text-[11px] text-gray-500">+{hidden} more</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
