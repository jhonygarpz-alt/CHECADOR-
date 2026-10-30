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
        inId: r.id, userId: r.user_id, date: r.local_date, timezone: r.timezone, location: r.location_name ?? null,
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
