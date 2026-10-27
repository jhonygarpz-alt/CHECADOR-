import { DEFAULT_TZ, MAX_SHIFT_HOURS } from './attendance.js';
import { addDays, eachDay, hhmmToMinutes, minutesToHHMM, weekdayOf, zonedParts } from './time.js';

/**
 * Empareja entradas y salidas válidas (ordenadas por usuario y hora) en jornadas.
 * Una jornada pertenece a la fecha local de su entrada, aunque la salida caiga en el día siguiente.
 */
export function pairShifts(records) {
  const shifts = [];
  let open = null;
  const close = () => { if (open) shifts.push(open); open = null; };

  for (const r of records) {
    if (open && open.userId !== r.user_id) close();
    if (r.type === 'in') {
      close();
      open = {
        userId: r.user_id, date: r.local_date, timezone: r.timezone, location: r.location_name ?? null,
        inTs: r.ts, inTime: r.local_time.slice(0, 5), late: !!r.late, outTs: null, outTime: null, minutes: null,
      };
    } else if (open && new Date(r.ts) - new Date(open.inTs) <= MAX_SHIFT_HOURS * 3600_000) {
      open.outTs = r.ts;
      open.outTime = r.local_time.slice(0, 5);
      open.minutes = Math.round((new Date(r.ts) - new Date(open.inTs)) / 60_000);
      close();
    }
  }
  close();
  return shifts;
}

function employees(db, { userId, department, locationId } = {}) {
  let sql = `SELECT u.*, COALESCE(l.timezone, ?) AS tz FROM users u LEFT JOIN locations l ON l.id = u.location_id
    WHERE u.active = 1 AND u.role = 'employee'`;
  const params = [DEFAULT_TZ];
  if (userId) { sql += ' AND u.id = ?'; params.push(Number(userId)); }
  if (department) { sql += ' AND u.department = ?'; params.push(department); }
  if (locationId) { sql += ' AND u.location_id = ?'; params.push(Number(locationId)); }
  return db.prepare(`${sql} ORDER BY u.name`).all(...params);
}

function validRecords(db, userIds, fromDate, toDate) {
  if (userIds.length === 0) return [];
  return db.prepare(`SELECT r.*, l.name AS location_name FROM records r LEFT JOIN locations l ON l.id = r.location_id
    WHERE r.status = 'valid' AND r.local_date BETWEEN ? AND ?
      AND r.user_id IN (${userIds.map(() => '?').join(',')})
    ORDER BY r.user_id, r.ts, r.id`).all(fromDate, toDate, ...userIds);
}

/** Reporte de asistencia para el rango de fechas locales [start, end]. */
export function buildReport(db, { start, end, userId, department, locationId, now = new Date() }) {
  const staff = employees(db, { userId, department, locationId });
  const records = validRecords(db, staff.map((u) => u.id), addDays(start, -1), addDays(end, 1));
  const shifts = pairShifts(records).filter((s) => s.date >= start && s.date <= end);
  const days = eachDay(start, end);

  const byUser = new Map(staff.map((u) => [u.id, []]));
  for (const s of shifts) byUser.get(s.userId)?.push(s);

  const rows = [];
  const summary = staff.map((u) => {
    const own = byUser.get(u.id);
    const today = zonedParts(now, u.tz).date;
    const hired = zonedParts(new Date(u.created_at), u.tz).date;
    const workDays = new Set(u.work_days.split(',').map(Number));
    const worked = new Set(own.map((s) => s.date));
    const expected = days.filter((d) => d <= today && d >= hired && workDays.has(weekdayOf(d)));
    const absences = expected.filter((d) => !worked.has(d));
    const totalMinutes = own.reduce((acc, s) => acc + (s.minutes ?? 0), 0);
    const avgIn = own.length ? own.reduce((acc, s) => acc + hhmmToMinutes(s.inTime), 0) / own.length : null;

    for (const s of own) {
      rows.push({ ...s, name: u.name, email: u.email, department: u.department });
    }
    return {
      userId: u.id, name: u.name, email: u.email, department: u.department, timezone: u.tz,
      schedule: `${u.schedule_start}-${u.schedule_end}`,
      daysWorked: worked.size, expectedDays: expected.length, absences: absences.length, absenceDates: absences,
      lateCount: own.filter((s) => s.late).length, incomplete: own.filter((s) => s.outTs === null).length,
      totalMinutes, averageIn: avgIn === null ? null : minutesToHHMM(avgIn),
    };
  });

  const series = days.map((d) => ({
    date: d,
    present: new Set(shifts.filter((s) => s.date === d).map((s) => s.userId)).size,
  }));

  const expectedTotal = summary.reduce((a, s) => a + s.expectedDays, 0);
  const attended = summary.reduce((a, s) => a + Math.min(s.daysWorked, s.expectedDays), 0);
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));

  return {
    range: { start, end },
    totals: {
      employees: staff.length,
      shifts: shifts.length,
      totalMinutes: summary.reduce((a, s) => a + s.totalMinutes, 0),
      lateCount: summary.reduce((a, s) => a + s.lateCount, 0),
      absences: summary.reduce((a, s) => a + s.absences, 0),
      attendanceRate: expectedTotal ? Math.round((attended / expectedTotal) * 1000) / 10 : null,
    },
    series,
    summary,
    rows,
  };
}

/** Panel en tiempo real: estado del día de cada empleado en su propia zona horaria. */
export function buildDashboard(db, now = new Date()) {
  const staff = employees(db);
  const since = addDays(new Date(now.getTime() - 86400_000).toISOString().slice(0, 10), -1);
  const records = validRecords(db, staff.map((u) => u.id), since, '9999-12-31');
  const byUser = new Map(staff.map((u) => [u.id, []]));
  for (const r of records) byUser.get(r.user_id)?.push(r);

  const people = staff.map((u) => {
    const today = zonedParts(now, u.tz).date;
    const own = byUser.get(u.id);
    const todays = own.filter((r) => r.local_date === today);
    const firstIn = todays.find((r) => r.type === 'in');
    const lastOut = todays.findLast((r) => r.type === 'out');
    const last = own.at(-1);
    const inside = last?.type === 'in' && now - new Date(last.ts) <= MAX_SHIFT_HOURS * 3600_000;
    const workday = u.work_days.split(',').map(Number).includes(weekdayOf(today));
    return {
      id: u.id, name: u.name, department: u.department, timezone: u.tz, today, workday,
      present: !!firstIn, inside, late: !!firstIn?.late,
      firstIn: firstIn?.local_time.slice(0, 5) ?? null, lastOut: lastOut?.local_time.slice(0, 5) ?? null,
      faceEnrolled: !!u.face_descriptor,
    };
  });

  const latest = db.prepare(`SELECT r.id, r.user_id, u.name AS user_name, r.type, r.ts, r.local_date, r.local_time,
      r.timezone, l.name AS location_name, r.status, r.reason, r.late, (r.snapshot IS NOT NULL) AS has_snapshot
    FROM records r JOIN users u ON u.id = r.user_id LEFT JOIN locations l ON l.id = r.location_id
    ORDER BY r.ts DESC, r.id DESC LIMIT 15`).all();

  const present = people.filter((p) => p.present).length;
  const expected = people.filter((p) => p.workday || p.present).length;
  return {
    now: now.toISOString(),
    totals: {
      active: people.length,
      present,
      absent: Math.max(expected - present, 0),
      inside: people.filter((p) => p.inside).length,
      late: people.filter((p) => p.late).length,
      expected,
    },
    people,
    latest,
  };
}

// ---------- Exportación CSV (compatible con Excel: UTF-8 con BOM) ----------

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  // Evita inyección de fórmulas al abrir el archivo en hojas de cálculo.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n;]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};
const toCsv = (rows) => `﻿${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
const hours = (min) => (min === null ? '' : (min / 60).toFixed(2));

export function reportToCsv(report, kind = 'detail') {
  if (kind === 'summary') {
    return toCsv([
      ['Empleado', 'Correo', 'Departamento', 'Horario', 'Zona horaria', 'Días trabajados', 'Días esperados',
        'Faltas', 'Retardos', 'Jornadas sin salida', 'Horas totales', 'Entrada promedio'],
      ...report.summary.map((s) => [s.name, s.email, s.department, s.schedule, s.timezone, s.daysWorked,
        s.expectedDays, s.absences, s.lateCount, s.incomplete, hours(s.totalMinutes), s.averageIn ?? '']),
    ]);
  }
  return toCsv([
    ['Fecha', 'Empleado', 'Correo', 'Departamento', 'Entrada', 'Salida', 'Horas', 'Retardo', 'Ubicación', 'Zona horaria'],
    ...report.rows.map((r) => [r.date, r.name, r.email, r.department, r.inTime, r.outTime ?? 'Sin salida',
      hours(r.minutes), r.late ? 'Sí' : 'No', r.location ?? '', r.timezone]),
  ]);
}
