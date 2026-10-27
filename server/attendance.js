import { isLatitude, isLongitude, nearestLocation } from './geo.js';
import { euclideanDistance, FACE_THRESHOLD, isValidDescriptor } from './face.js';
import { hhmmToMinutes, zonedParts } from './time.js';

export const DEFAULT_TZ = process.env.DEFAULT_TZ || 'America/Mexico_City';
export const MAX_GPS_ACCURACY_M = Number(process.env.MAX_GPS_ACCURACY_M || 100);
export const MAX_SHIFT_HOURS = Number(process.env.MAX_SHIFT_HOURS || 16);
const MAX_SNAPSHOT_CHARS = 250_000;

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export function userTimezone(db, user) {
  if (!user.location_id) return DEFAULT_TZ;
  return db.prepare('SELECT timezone FROM locations WHERE id = ?').get(user.location_id)?.timezone || DEFAULT_TZ;
}

export function lastValidRecord(db, userId) {
  return db.prepare(`SELECT * FROM records WHERE user_id = ? AND status = 'valid'
    ORDER BY ts DESC, id DESC LIMIT 1`).get(userId) ?? null;
}

/** Hay una entrada sin salida y aún dentro de la duración máxima de jornada. */
export function openShift(db, userId, now = new Date()) {
  const last = lastValidRecord(db, userId);
  if (last?.type !== 'in') return null;
  return now - new Date(last.ts) <= MAX_SHIFT_HOURS * 3600_000 ? last : null;
}

export function candidateLocations(db, user) {
  if (user.location_id) {
    return db.prepare('SELECT * FROM locations WHERE id = ? AND active = 1').all(user.location_id);
  }
  return db.prepare('SELECT * FROM locations WHERE active = 1').all();
}

/**
 * Registra una entrada o salida. La hora SIEMPRE es la del servidor (no se confía en el reloj del
 * dispositivo) y la fecha/hora local se calcula con la zona horaria de la ubicación validada.
 * Los intentos fallidos se guardan como `rejected` para auditoría.
 */
export function registerAttendance(db, user, input, { now = new Date(), userAgent = '' } = {}) {
  const { type, descriptor, snapshot } = input ?? {};
  const lat = Number(input?.lat);
  const lng = Number(input?.lng);
  const accuracy = Number(input?.accuracy ?? 0);

  if (type !== 'in' && type !== 'out') throw new HttpError(400, 'Tipo de registro no válido');
  if (!isLatitude(lat) || !isLongitude(lng) || !Number.isFinite(accuracy) || accuracy < 0) {
    throw new HttpError(400, 'Ubicación no válida');
  }
  if (!isValidDescriptor(descriptor)) throw new HttpError(400, 'Datos de reconocimiento facial no válidos');
  if (!user.face_descriptor) throw new HttpError(409, 'Primero registra tu rostro en el perfil');

  const open = openShift(db, user.id, now);
  if (type === 'in' && open) throw new HttpError(409, 'Ya tienes una entrada registrada; registra tu salida');
  if (type === 'out' && !open) throw new HttpError(409, 'No tienes una entrada abierta para registrar la salida');

  const locations = candidateLocations(db, user);
  if (locations.length === 0) throw new HttpError(409, 'No hay ubicaciones de trabajo configuradas');

  const nearest = nearestLocation(locations, lat, lng);
  const loc = nearest.location;
  const faceDistance = euclideanDistance(JSON.parse(user.face_descriptor), descriptor);

  const checks = {
    face: { ok: faceDistance <= FACE_THRESHOLD, distance: round(faceDistance, 3), threshold: FACE_THRESHOLD },
    location: {
      ok: nearest.distance <= loc.radius_m,
      distance: Math.round(nearest.distance),
      radius: loc.radius_m,
      name: loc.name,
      address: loc.address,
      lat: loc.lat,
      lng: loc.lng,
    },
    accuracy: { ok: accuracy <= MAX_GPS_ACCURACY_M, value: Math.round(accuracy), max: MAX_GPS_ACCURACY_M },
  };

  const reasons = [];
  if (!checks.face.ok) reasons.push('El rostro no coincide con el registrado');
  if (!checks.location.ok) reasons.push(`Fuera del área permitida (${checks.location.distance} m de ${loc.name})`);
  if (!checks.accuracy.ok) reasons.push(`Precisión GPS insuficiente (±${checks.accuracy.value} m)`);

  const local = zonedParts(now, loc.timezone);
  const late = type === 'in' && reasons.length === 0
    && local.minutes > hhmmToMinutes(user.schedule_start) + user.tolerance_min;

  const result = db.prepare(`INSERT INTO records
    (user_id, type, ts, local_date, local_time, timezone, location_id, lat, lng, accuracy_m, distance_m,
     face_distance, status, reason, late, snapshot, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    user.id, type, now.toISOString(), local.date, local.time, loc.timezone, loc.id, lat, lng, accuracy,
    nearest.distance, faceDistance, reasons.length ? 'rejected' : 'valid', reasons.join('; ') || null,
    late ? 1 : 0, sanitizeSnapshot(snapshot), String(userAgent).slice(0, 300),
  );

  const record = recordView(db, result.lastInsertRowid);
  if (reasons.length) throw new HttpError(422, reasons.join('. '), { checks, record });

  let workedMinutes = null;
  if (type === 'out') workedMinutes = Math.round((now - new Date(open.ts)) / 60_000);
  return { record, checks, workedMinutes };
}

/** Registro listo para la API (sin la foto, que se descarga aparte). */
export function recordView(db, id) {
  return db.prepare(`SELECT r.id, r.user_id, u.name AS user_name, u.department, r.type, r.ts, r.local_date,
      r.local_time, r.timezone, r.location_id, l.name AS location_name, r.lat, r.lng, r.accuracy_m,
      r.distance_m, r.face_distance, r.status, r.reason, r.late, (r.snapshot IS NOT NULL) AS has_snapshot
    FROM records r JOIN users u ON u.id = r.user_id LEFT JOIN locations l ON l.id = r.location_id
    WHERE r.id = ?`).get(id);
}

function sanitizeSnapshot(s) {
  if (typeof s !== 'string' || s.length > MAX_SNAPSHOT_CHARS) return null;
  return /^data:image\/(jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(s) ? s : null;
}

const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;

