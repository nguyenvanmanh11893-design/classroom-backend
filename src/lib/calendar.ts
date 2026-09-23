import { z } from 'zod';

export const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
});

export function bangkokRange(from?: string, to?: string) {
  const endDay = to ?? new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
  const end = new Date(`${endDay}T00:00:00+07:00`);
  const start = from ? new Date(`${from}T00:00:00+07:00`) : new Date(end.getTime() - 29 * 86400000);
  return { from: start, to: new Date(end.getTime() + 86400000) };
}
