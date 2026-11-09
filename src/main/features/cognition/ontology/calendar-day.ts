/** Calendar-day helper shared by automatic context and host tools. Using the
 * host's local day matches when users say "today"; UTC would shift the query
 * date for part of the day in east-of-UTC time zones. */
export function localCalendarDay(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
