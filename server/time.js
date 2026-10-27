// Utilidades de fecha y hora con zonas horarias IANA reales (America/Mexico_City, America/Tijuana, ...).
// Los instantes se guardan siempre en UTC; la fecha/hora "local" se calcula con la zona de cada ubicación,
// por lo que el horario de verano y los cambios de huso se resuelven con la base de datos tz del sistema.

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const formatters = new Map();
function formatterFor(timeZone) {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(timeZone, fmt);
  }
  return fmt;
}

/** Descompone un instante en fecha, hora y día de la semana dentro de `timeZone`. */
export function zonedParts(date, timeZone) {
  const p = Object.fromEntries(formatterFor(timeZone).formatToParts(date).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour}:${p.minute}:${p.second}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
    weekday: WEEKDAYS.indexOf(p.weekday), // 0 = domingo
  };
}

export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const isDateString = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
  && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const weekdayOf = (dateStr) => new Date(`${dateStr}T00:00:00Z`).getUTCDay();

export function eachDay(start, end) {
  const days = [];
  for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
  return days;
}

/** Rango [start, end] (fechas inclusivas) de un periodo diario, semanal (lunes a domingo) o mensual. */
export function periodRange(period, dateStr) {
  switch (period) {
    case 'daily':
      return { start: dateStr, end: dateStr };
    case 'weekly': {
      const start = addDays(dateStr, -((weekdayOf(dateStr) + 6) % 7));
      return { start, end: addDays(start, 6) };
    }
    case 'monthly': {
      const [y, m] = dateStr.split('-').map(Number);
      const start = `${dateStr.slice(0, 7)}-01`;
      const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
      return { start, end };
    }
    default:
      throw new Error(`Periodo no válido: ${period}`);
  }
}

export function hhmmToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export const isHHMM = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

export function minutesToHHMM(min) {
  const m = Math.round(min);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
