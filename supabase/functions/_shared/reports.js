import { addDays, eachDay, hhmmToMinutes, minutesToHHMM, weekdayOf, zonedParts } from './time.js';

/**
 * Empareja entradas y salidas válidas (ordenadas por usuario y hora) en jornadas.
 * Una jornada pertenece a la fecha local de su entrada, aunque la salida caiga en el día siguiente.
 */
export function pairShifts(records, maxShiftHours = 16) {
  const shifts = [];
  let open = null;
  const close = () => { if (open) shifts.push(open); open = null; };

  for (const r of records) {
    if (open && open.userId !== r.user_id) close();
    if (r.type === 'in') {
      close();
      open = {
        userId: r.user_id, date: r.local_date, timezone: r.timezone, location: r.location_name ?? null,
        inTs: new Date(r.ts).toISOString(), inTime: r.local_time.slice(0, 5), late: !!r.late, outTs: null, outTime: null, minutes: null,
      };
    } else if (open && new Date(r.ts) - new Date(open.inTs) <= maxShiftHours * 3600_000) {
      open.outTs = new Date(r.ts).toISOString();
      open.outTime = r.local_time.slice(0, 5);
      open.minutes = Math.round((new Date(r.ts) - new Date(open.inTs)) / 60_000);
      close();
    }
  }
  close();
  return shifts;
}

function employees(sql, config, { userId, department, locationId } = {}) {
  return sql`select u.*, coalesce(l.timezone, ${config.defaultTz}) as tz, (f.user_id is not null) as face_enrolled
    from asiste.profiles u
    left join asiste.locations l on l.id = u.location_id
    left join asiste.face_templates f on f.user_id = u.id
    where u.active and u.role = 'employee'
      ${userId ? sql`and u.id = ${userId}` : sql``}
      ${department ? sql`and u.department = ${department}` : sql``}
      ${locationId ? sql`and u.location_id = ${Number(locationId)}` : sql``}
    order by u.name`;
}

function validRecords(sql, userIds, fromDate, toDate) {
  if (userIds.length === 0) return [];
  return sql`select r.*, l.name as location_name from asiste.records r left join asiste.locations l on l.id = r.location_id
    where r.status = 'valid' and r.local_date between ${fromDate} and ${toDate} and r.user_id = any(${userIds}::uuid[])
    order by r.user_id, r.ts, r.id`;
}

/** Reporte de asistencia para el rango de fechas locales [start, end]. */
export async function buildReport(sql, config, { start, end, userId, department, locationId, now = new Date() }) {
  const staff = await employees(sql, config, { userId, department, locationId });
  const records = await validRecords(sql, staff.map((u) => u.id), addDays(start, -1), addDays(end, 1));
  const shifts = pairShifts(records, config.maxShiftHours).filter((s) => s.date >= start && s.date <= end);
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
export async function buildDashboard(sql, config, now = new Date()) {
  const staff = await employees(sql, config);
  const since = addDays(new Date(now.getTime() - 86400_000).toISOString().slice(0, 10), -1);
  const records = await validRecords(sql, staff.map((u) => u.id), since, '9999-12-31');
  const byUser = new Map(staff.map((u) => [u.id, []]));
  for (const r of records) byUser.get(r.user_id)?.push(r);

  const people = staff.map((u) => {
    const today = zonedParts(now, u.tz).date;
    const own = byUser.get(u.id);
    const todays = own.filter((r) => r.local_date === today);
    const firstIn = todays.find((r) => r.type === 'in');
    const lastOut = todays.findLast((r) => r.type === 'out');
    const last = own.at(-1);
    const inside = last?.type === 'in' && now - new Date(last.ts) <= config.maxShiftHours * 3600_000;
    const workday = u.work_days.split(',').map(Number).includes(weekdayOf(today));
    return {
      id: u.id, name: u.name, department: u.department, timezone: u.tz, today, workday,
      present: !!firstIn, inside, late: !!firstIn?.late,
      firstIn: firstIn?.local_time.slice(0, 5) ?? null, lastOut: lastOut?.local_time.slice(0, 5) ?? null,
      faceEnrolled: u.face_enrolled,
    };
  });

  const latest = await sql`select r.id, r.user_id, p.name as user_name, r.type, r.ts, r.local_date, r.local_time,
      r.timezone, l.name as location_name, r.status, r.reason, r.late, (r.snapshot_path is not null) as has_snapshot
    from asiste.records r join asiste.profiles p on p.id = r.user_id left join asiste.locations l on l.id = r.location_id
    order by r.ts desc, r.id desc limit 15`;

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
const toCsv = (rows) => `\uFEFF${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
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
