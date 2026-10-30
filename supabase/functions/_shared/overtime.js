import { HttpError } from './attendance.js';
import { pairShifts } from './shifts.js';
import { addDays, hhmmToMinutes } from './time.js';

/** Duración de la jornada programada en minutos (admite turnos que cruzan la medianoche). */
export function scheduledMinutes(profile) {
  const d = hhmmToMinutes(profile.schedule_end) - hhmmToMinutes(profile.schedule_start);
  return d > 0 ? d : d + 1440;
}

/** Minutos extra de una jornada cerrada; por debajo de `minOvertime` no se consideran horas extras. */
export function overtimeMinutes(shift, profile, config) {
  if (shift.minutes == null) return 0;
  const extra = shift.minutes - scheduledMinutes(profile);
  return extra >= config.minOvertime ? extra : 0;
}

export async function loadDecisions(sql, inIds) {
  if (inIds.length === 0) return new Map();
  const rows = await sql`select d.*, coalesce(p.name, 'Usuario eliminado') as decided_by_name from asiste.overtime_decisions d
    left join asiste.profiles p on p.id = d.decided_by where d.in_record_id = any(${inIds}::int[])`;
  return new Map(rows.map((r) => [r.in_record_id, r]));
}

export function decisionView(d) {
  if (!d) return { status: 'pending', approvedMinutes: 0, notes: null, decidedBy: null, decidedAt: null };
  return {
    status: d.status, approvedMinutes: d.approved_min, notes: d.notes,
    decidedBy: d.decided_by_name, decidedAt: new Date(d.decided_at).toISOString(),
  };
}

/** Agrega a cada jornada sus horas extras y la decisión del administrador. */
export async function withOvertime(sql, config, shifts, profilesById) {
  const decisions = await loadDecisions(sql, shifts.map((s) => s.inId));
  return shifts.map((s) => {
    const profile = profilesById.get(s.userId);
    const overtime = profile ? overtimeMinutes(s, profile, config) : 0;
    return {
      ...s,
      scheduledMinutes: profile ? scheduledMinutes(profile) : null,
      overtimeMinutes: overtime,
      overtime: overtime > 0 ? decisionView(decisions.get(s.inId)) : null,
    };
  });
}

/** Jornadas con horas extras en el rango [from, to] de fechas locales. */
export async function listOvertime(sql, config, { companyId, from, to, userId, status }) {
  const records = await sql`select r.*, l.name as location_name from asiste.records r
    left join asiste.locations l on l.id = r.location_id
    where r.company_id = ${companyId} and r.status = 'valid' and r.local_date between ${addDays(from, -1)} and ${addDays(to, 1)}
      ${userId ? sql`and r.user_id = ${userId}` : sql``}
    order by r.user_id, r.ts, r.id`;
  const profiles = await sql`select * from asiste.profiles where company_id = ${companyId}`;
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const shifts = pairShifts(records, config.maxShiftHours).filter((s) => s.date >= from && s.date <= to);
  const items = (await withOvertime(sql, config, shifts, byId))
    .filter((s) => s.overtimeMinutes > 0 && (!status || status === 'all' || s.overtime.status === status))
    .map((s) => ({ ...s, name: byId.get(s.userId).name, department: byId.get(s.userId).department }));
  items.sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name));
  return items;
}

/** Autoriza o rechaza las horas extras de una jornada. Solo debe llamarse para administradores. */
export async function decideOvertime(sql, config, admin, companyId, inRecordId, body) {
  const status = body?.status;
  const notes = String(body?.notes ?? '').trim();
  if (status !== 'approved' && status !== 'rejected') throw new HttpError(400, 'Indica si se autoriza o se rechaza');
  if (notes.length < 5) throw new HttpError(400, 'Escribe en observaciones el motivo (mínimo 5 caracteres)');
  if (notes.length > 1000) throw new HttpError(400, 'Las observaciones no pueden exceder 1000 caracteres');

  const [inRecord] = await sql`select * from asiste.records where id = ${inRecordId} and company_id = ${companyId}
    and type = 'in' and status = 'valid'`;
  if (!inRecord) throw new HttpError(404, 'Jornada no encontrada');
  const records = await sql`select * from asiste.records where user_id = ${inRecord.user_id} and status = 'valid'
    and ts >= ${inRecord.ts} order by ts, id limit 2`;
  const [shift] = pairShifts(records, config.maxShiftHours);
  const [profile] = await sql`select * from asiste.profiles where id = ${inRecord.user_id}`;
  const overtime = shift ? overtimeMinutes(shift, profile, config) : 0;
  if (!shift || shift.inId !== inRecord.id || shift.minutes == null) throw new HttpError(409, 'La jornada aún no tiene salida registrada');
  if (overtime <= 0) throw new HttpError(409, 'Esta jornada no tiene horas extras');

  let approved = 0;
  if (status === 'approved') {
    approved = body.approved_minutes === undefined ? overtime : Number(body.approved_minutes);
    if (!Number.isInteger(approved) || approved < 1 || approved > overtime) {
      throw new HttpError(400, `Los minutos autorizados deben estar entre 1 y ${overtime}`);
    }
  }

  await sql`insert into asiste.overtime_decisions
      (in_record_id, user_id, work_date, overtime_min, approved_min, status, notes, decided_by)
    values (${inRecord.id}, ${inRecord.user_id}, ${shift.date}, ${overtime}, ${approved}, ${status}, ${notes}, ${admin.id})
    on conflict (in_record_id) do update set overtime_min = excluded.overtime_min, approved_min = excluded.approved_min,
      status = excluded.status, notes = excluded.notes, decided_by = excluded.decided_by, decided_at = now()`;
  const [result] = await withOvertime(sql, config, [shift], new Map([[profile.id, profile]]));
  return { ...result, name: profile.name, department: profile.department };
}
