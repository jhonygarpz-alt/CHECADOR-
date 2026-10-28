import { isLatitude, isLongitude, nearestLocation } from './geo.js';
import { euclideanDistance, isValidDescriptor } from './face.js';
import { hhmmToMinutes, zonedParts } from './time.js';

export function loadConfig(env = {}) {
  return {
    defaultTz: env.DEFAULT_TZ || 'America/Mexico_City',
    faceThreshold: Number(env.FACE_THRESHOLD || 0.5),
    maxGpsAccuracy: Number(env.MAX_GPS_ACCURACY_M || 100),
    maxShiftHours: Number(env.MAX_SHIFT_HOURS || 16),
    minOvertime: Number(env.MIN_OVERTIME_MINUTES || 15),
    adminEmails: String(env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  };
}

const MAX_SNAPSHOT_CHARS = 250_000;

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export async function userTimezone(sql, user, config) {
  if (!user.location_id) return config.defaultTz;
  const [loc] = await sql`select timezone from asiste.locations where id = ${user.location_id}`;
  return loc?.timezone || config.defaultTz;
}

/** Hay una entrada sin salida y aún dentro de la duración máxima de jornada. */
export async function openShift(sql, userId, config, now = new Date()) {
  const [last] = await sql`select * from asiste.records where user_id = ${userId} and status = 'valid'
    order by ts desc, id desc limit 1`;
  if (last?.type !== 'in') return null;
  return now - new Date(last.ts) <= config.maxShiftHours * 3600_000 ? last : null;
}

function candidateLocations(sql, user) {
  return user.location_id
    ? sql`select * from asiste.locations where id = ${user.location_id} and active`
    : sql`select * from asiste.locations where active`;
}

/**
 * Registra una entrada o salida. La hora SIEMPRE es la del servidor (no se confía en el reloj del
 * dispositivo) y la fecha/hora local se calcula con la zona horaria de la ubicación validada.
 * Los intentos fallidos se guardan como `rejected` para auditoría.
 */
export async function registerAttendance(sql, user, input, { config, storage, now = new Date(), userAgent = '' }) {
  const { type, descriptor, snapshot } = input ?? {};
  const lat = Number(input?.lat);
  const lng = Number(input?.lng);
  const accuracy = Number(input?.accuracy ?? 0);

  if (type !== 'in' && type !== 'out') throw new HttpError(400, 'Tipo de registro no válido');
  if (!isLatitude(lat) || !isLongitude(lng) || !Number.isFinite(accuracy) || accuracy < 0) {
    throw new HttpError(400, 'Ubicación no válida');
  }
  if (!isValidDescriptor(descriptor)) throw new HttpError(400, 'Datos de reconocimiento facial no válidos');

  const snapshotPath = await saveSnapshot(storage, user.id, snapshot, now);

  const outcome = await sql.begin(async (tx) => {
    // Bloquea al usuario para que dos toques simultáneos no generen dos entradas.
    await tx`select id from asiste.profiles where id = ${user.id} for update`;

    const [template] = await tx`select descriptor from asiste.face_templates where user_id = ${user.id}`;
    if (!template) throw new HttpError(409, 'Primero registra tu rostro en el perfil');

    const open = await openShift(tx, user.id, config, now);
    if (type === 'in' && open) throw new HttpError(409, 'Ya tienes una entrada registrada; registra tu salida');
    if (type === 'out' && !open) throw new HttpError(409, 'No tienes una entrada abierta para registrar la salida');

    const locations = await candidateLocations(tx, user);
    if (locations.length === 0) throw new HttpError(409, 'No hay ubicaciones de trabajo configuradas');

    const nearest = nearestLocation(locations, lat, lng);
    const loc = nearest.location;
    const faceDistance = euclideanDistance(template.descriptor, descriptor);

    const checks = {
      face: { ok: faceDistance <= config.faceThreshold, distance: round(faceDistance, 3), threshold: config.faceThreshold },
      location: {
        ok: nearest.distance <= loc.radius_m,
        distance: Math.round(nearest.distance),
        radius: loc.radius_m,
        name: loc.name,
        address: loc.address,
        lat: loc.lat,
        lng: loc.lng,
      },
      accuracy: { ok: accuracy <= config.maxGpsAccuracy, value: Math.round(accuracy), max: config.maxGpsAccuracy },
    };

    const reasons = [];
    if (!checks.face.ok) reasons.push('El rostro no coincide con el registrado');
    if (!checks.location.ok) reasons.push(`Fuera del área permitida (${checks.location.distance} m de ${loc.name})`);
    if (!checks.accuracy.ok) reasons.push(`Precisión GPS insuficiente (±${checks.accuracy.value} m)`);

    const local = zonedParts(now, loc.timezone);
    const late = type === 'in' && reasons.length === 0
      && local.minutes > hhmmToMinutes(user.schedule_start) + user.tolerance_min;

    const [{ id }] = await tx`insert into asiste.records
      (user_id, type, ts, local_date, local_time, timezone, location_id, lat, lng, accuracy_m, distance_m,
       face_distance, status, reason, late, snapshot_path, user_agent)
      values (${user.id}, ${type}, ${now}, ${local.date}, ${local.time}, ${loc.timezone}, ${loc.id}, ${lat}, ${lng},
        ${accuracy}, ${nearest.distance}, ${faceDistance}, ${reasons.length ? 'rejected' : 'valid'},
        ${reasons.join('; ') || null}, ${late}, ${snapshotPath}, ${String(userAgent).slice(0, 300)})
      returning id`;

    const workedMinutes = type === 'out' ? Math.round((now - new Date(open.ts)) / 60_000) : null;
    return { id, checks, reasons, workedMinutes };
  });

  const record = await recordView(sql, outcome.id);
  if (outcome.reasons.length) throw new HttpError(422, outcome.reasons.join('. '), { checks: outcome.checks, record });
  return { record, checks: outcome.checks, workedMinutes: outcome.workedMinutes };
}

const RECORD_COLUMNS = (sql) => sql`r.id, r.user_id, p.name as user_name, p.department, r.type, r.ts, r.local_date,
  r.local_time, r.timezone, r.location_id, l.name as location_name, r.lat, r.lng, r.accuracy_m, r.distance_m,
  r.face_distance, r.status, r.reason, r.late, (r.snapshot_path is not null) as has_snapshot`;

/** Registro listo para la API (sin la foto, que se consulta aparte). */
export async function recordView(sql, id) {
  const [row] = await sql`select ${RECORD_COLUMNS(sql)}
    from asiste.records r join asiste.profiles p on p.id = r.user_id left join asiste.locations l on l.id = r.location_id
    where r.id = ${id}`;
  return row;
}

export function listRecords(sql, { from, to, userId, status }) {
  return sql`select ${RECORD_COLUMNS(sql)}
    from asiste.records r join asiste.profiles p on p.id = r.user_id left join asiste.locations l on l.id = r.location_id
    where r.local_date between ${from} and ${to}
      ${userId ? sql`and r.user_id = ${userId}` : sql``}
      ${status ? sql`and r.status = ${status}` : sql``}
    order by r.ts desc, r.id desc limit 1000`;
}

async function saveSnapshot(storage, userId, snapshot, now) {
  if (!storage || typeof snapshot !== 'string' || snapshot.length > MAX_SNAPSHOT_CHARS) return null;
  const m = snapshot.match(/^data:(image\/(?:jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return null;
  const path = `${userId}/${now.getTime()}.${m[1] === 'image/webp' ? 'webp' : 'jpg'}`;
  try {
    const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
    await storage.upload(path, bytes, m[1]);
    return path;
  } catch (err) {
    console.error('No se pudo guardar la foto del registro', err);
    return null;
  }
}

const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;
