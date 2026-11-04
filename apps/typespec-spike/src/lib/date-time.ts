import { Temporal } from '@js-temporal/polyfill';

export function formatStartedAt(value: string): string {
  return Temporal.Instant.from(value).toZonedDateTimeISO('Asia/Tokyo').toLocaleString('ja-JP', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
}
