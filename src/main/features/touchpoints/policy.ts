import { TouchpointContractError } from './errors';
import type {
  TouchpointPolicyConfig,
  TouchpointPolicyDecision,
  TouchpointPriority,
  TouchpointQuietHours,
} from './types';

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function parseClock(value: string, field: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(typeof value === 'string' ? value : '');
  if (!match) throw new TouchpointContractError('invalid_policy', `Touchpoint ${field} must use HH:mm.`, field);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new TouchpointContractError('invalid_policy', `Touchpoint ${field} is outside the valid clock range.`, field);
  }
  return hour * 60 + minute;
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  try {
    const value = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    value.format(new Date(0));
    return value;
  } catch {
    throw new TouchpointContractError('invalid_policy', 'Touchpoint quiet-hours timezone is invalid.', 'quietHours.timeZone');
  }
}

function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = formatter(timeZone).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const result: ZonedParts = {
    year: Number(values.get('year')),
    month: Number(values.get('month')),
    day: Number(values.get('day')),
    hour: Number(values.get('hour')),
    minute: Number(values.get('minute')),
    second: Number(values.get('second')),
  };
  if (Object.values(result).some((value) => !Number.isInteger(value))) {
    throw new TouchpointContractError('invalid_policy', 'Touchpoint timezone conversion failed.', 'quietHours.timeZone');
  }
  return result;
}

function addCalendarDays(parts: ZonedParts, days: number): ZonedParts {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, parts.hour, parts.minute, parts.second));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
  };
}

function zonedLocalToUtc(parts: ZonedParts, timeZone: string): Date {
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, 0);
  let guess = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const represented = zonedParts(new Date(guess), timeZone);
    const representedUtc = Date.UTC(
      represented.year,
      represented.month - 1,
      represented.day,
      represented.hour,
      represented.minute,
      represented.second,
      0,
    );
    const correction = target - representedUtc;
    if (correction === 0) return new Date(guess);
    guess += correction;
  }
  const resolved = new Date(guess);
  if (!Number.isFinite(resolved.getTime())) {
    throw new TouchpointContractError('invalid_policy', 'Touchpoint quiet-hours end could not be resolved.', 'quietHours');
  }
  return resolved;
}

function quietHoursEnd(now: Date, quietHours: TouchpointQuietHours): Date | null {
  const startMinutes = parseClock(quietHours.start, 'quietHours.start');
  const endMinutes = parseClock(quietHours.end, 'quietHours.end');
  if (startMinutes === endMinutes) {
    throw new TouchpointContractError('invalid_policy', 'Touchpoint quiet-hours start and end must differ.', 'quietHours');
  }
  const current = zonedParts(now, quietHours.timeZone);
  const currentMinutes = current.hour * 60 + current.minute;
  const crossesMidnight = startMinutes > endMinutes;
  const inQuietHours = crossesMidnight
    ? currentMinutes >= startMinutes || currentMinutes < endMinutes
    : currentMinutes >= startMinutes && currentMinutes < endMinutes;
  if (!inQuietHours) return null;

  const endHour = Math.floor(endMinutes / 60);
  const endMinute = endMinutes % 60;
  const endDayOffset = crossesMidnight && currentMinutes >= startMinutes ? 1 : 0;
  const localEnd = addCalendarDays({ ...current, hour: endHour, minute: endMinute, second: 0 }, endDayOffset);
  return zonedLocalToUtc(localEnd, quietHours.timeZone);
}

export function evaluateTouchpointPolicy(
  priority: TouchpointPriority,
  policy: TouchpointPolicyConfig,
  now = new Date(),
): TouchpointPolicyDecision {
  if (!Number.isFinite(now.getTime())) {
    throw new TouchpointContractError('invalid_policy', 'Touchpoint policy evaluation time is invalid.', 'now');
  }
  if (!policy || typeof policy !== 'object' || typeof policy.enabled !== 'boolean') {
    throw new TouchpointContractError('invalid_policy', 'Touchpoint policy is invalid.', 'policy');
  }
  if (!policy.enabled) return { decision: 'suppress', reason: 'touchpoint_disabled' };
  if (!policy.quietHours || priority === 'urgent') return { decision: 'deliver' };
  const availableFrom = quietHoursEnd(now, policy.quietHours);
  if (!availableFrom) return { decision: 'deliver' };
  return { decision: 'delay', reason: 'quiet_hours', availableFrom: availableFrom.toISOString() };
}
