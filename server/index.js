import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createSession, hashPassword, loginLimiter, requireAdmin, requireAuth, verifyPassword } from './auth.js';
import { HttpError, openShift, recordView, registerAttendance, userTimezone } from './attendance.js';
import { averageDescriptor, isValidDescriptor } from './face.js';
import { isLatitude, isLongitude } from './geo.js';
import { buildDashboard, buildReport, pairShifts, reportToCsv } from './reports.js';
import { Realtime } from './realtime.js';
import { addDays, isDateString, isHHMM, isValidTimeZone, periodRange, zonedParts } from './time.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function createApp(db = openDb(), realtime = new Realtime()) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(self), geolocation=(self)',
    });
    next();
  });

  const auth = requireAuth(db);
  const limiter = loginLimiter();
  const wrap = (fn) => (req, res, next) => {
    try {
      const out = fn(req, res, next);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (err) {
      next(err);
    }
  };

  // ---------------- Público ----------------

  app.get('/api/time', (req, res) => res.json({ now: new Date().toISOString() }));

  app.post('/api/auth/login', wrap((req) => {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const password = String(req.body?.password ?? '');
    const key = `${req.ip}|${email}`;
    if (limiter.blocked(key)) throw new HttpError(429, 'Demasiados intentos. Espera unos minutos.');

    const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email);
    if (!user || !verifyPassword(password, user.password_hash)) {
      limiter.fail(key);
      throw new HttpError(401, 'Correo o contraseña incorrectos');
    }
    limiter.reset(key);
    return { ...createSession(db, user.id), user: publicUser(db, user) };
  }));

  // ---------------- Sesión del usuario ----------------

  app.post('/api/auth/logout', auth, wrap((req) => {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
    return { ok: true };
  }));

  app.get('/api/me', auth, wrap((req) => ({ user: publicUser(db, req.user) })));

  app.put('/api/me/password', auth, wrap((req) => {
    const { current, next } = req.body ?? {};
    if (!verifyPassword(String(current ?? ''), req.user.password_hash)) throw new HttpError(400, 'La contraseña actual no es correcta');
    if (typeof next !== 'string' || next.length < 8) throw new HttpError(400, 'La nueva contraseña debe tener al menos 8 caracteres');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), req.user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').run(req.user.id, req.token);
    return { ok: true };
  }));

  // Enrolamiento facial: el empleado lo hace una sola vez; para repetirlo un administrador debe restablecerlo.
  app.post('/api/me/face', auth, wrap((req) => {
    const descriptors = req.body?.descriptors;
    if (req.user.face_descriptor) throw new HttpError(409, 'Tu rostro ya está registrado. Pide a un administrador que lo restablezca.');
    if (!Array.isArray(descriptors) || descriptors.length < 3 || descriptors.length > 10 || !descriptors.every(isValidDescriptor)) {
      throw new HttpError(400, 'Se requieren entre 3 y 10 capturas faciales válidas');
    }
    db.prepare('UPDATE users SET face_descriptor = ?, face_enrolled_at = ? WHERE id = ?')
      .run(JSON.stringify(averageDescriptor(descriptors)), new Date().toISOString(), req.user.id);
    realtime.publish('user', { id: req.user.id }, { userId: req.user.id });
    return { user: publicUser(db, db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) };
  }));

  app.get('/api/me/status', auth, wrap((req) => {
    const now = new Date();
    const tz = userTimezone(db, req.user);
    const today = zonedParts(now, tz).date;
    const todays = db.prepare(`SELECT * FROM records WHERE user_id = ? AND status = 'valid' AND local_date >= ?
      ORDER BY ts, id`).all(req.user.id, addDays(today, -1));
    const shift = pairShifts(todays.map((r) => ({ ...r, location_name: null }))).filter((s) => s.date === today).at(-1) ?? null;
    const open = openShift(db, req.user.id, now);
    return { now: now.toISOString(), timezone: tz, today, open: open ? { ts: open.ts } : null, shift };
  }));

  app.get('/api/me/records', auth, wrap((req) => {
    const month = String(req.query.month ?? '');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpError(400, 'Mes no válido (AAAA-MM)');
    const { start, end } = periodRange('monthly', `${month}-01`);
    const records = db.prepare(`SELECT r.*, l.name AS location_name FROM records r LEFT JOIN locations l ON l.id = r.location_id
      WHERE r.user_id = ? AND r.status = 'valid' AND r.local_date BETWEEN ? AND ? ORDER BY r.ts, r.id`)
      .all(req.user.id, start, addDays(end, 1));
    return { month, shifts: pairShifts(records).filter((s) => s.date <= end).reverse() };
  }));

  app.post('/api/attendance', auth, wrap((req, res) => {
    try {
      const result = registerAttendance(db, req.user, req.body, { userAgent: req.get('user-agent') });
      realtime.publish('record', result.record, { userId: req.user.id });
      res.status(201).json(result);
    } catch (err) {
      if (err instanceof HttpError && err.extra.record) realtime.publish('record', err.extra.record, { userId: req.user.id });
      throw err;
    }
  }));

  app.get('/api/stream', auth, (req, res) => realtime.connect(req, res, req.user));

  // ---------------- Administración ----------------

  const admin = express.Router();
  admin.use(auth, requireAdmin);

  admin.get('/dashboard', wrap(() => buildDashboard(db)));

  admin.get('/users', wrap(() => ({
    users: db.prepare(`SELECT u.*, l.name AS location_name FROM users u LEFT JOIN locations l ON l.id = u.location_id
      ORDER BY u.active DESC, u.name`).all().map((u) => publicUser(db, u)),
  })));

  admin.post('/users', wrap((req, res) => {
    const data = validateUser(db, req.body, { requirePassword: true });
    try {
      const r = db.prepare(`INSERT INTO users (name, email, password_hash, role, position, department, location_id,
          schedule_start, schedule_end, tolerance_min, work_days, active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(data.name, data.email, hashPassword(data.password), data.role,
        data.position, data.department, data.location_id, data.schedule_start, data.schedule_end, data.tolerance_min,
        data.work_days, data.active);
      res.status(201).json({ user: publicUser(db, db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid)) });
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) throw new HttpError(409, 'Ya existe un usuario con ese correo');
      throw err;
    }
  }));

  admin.put('/users/:id', wrap((req) => {
    const id = Number(req.params.id);
    const current = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!current) throw new HttpError(404, 'Usuario no encontrado');
    const data = validateUser(db, { ...publicUser(db, current), ...req.body }, { requirePassword: false });
    if (id === req.user.id && (data.role !== 'admin' || !data.active)) {
      throw new HttpError(400, 'No puedes quitarte el rol de administrador ni desactivarte');
    }
    try {
      db.prepare(`UPDATE users SET name = ?, email = ?, role = ?, position = ?, department = ?, location_id = ?,
          schedule_start = ?, schedule_end = ?, tolerance_min = ?, work_days = ?, active = ? WHERE id = ?`)
        .run(data.name, data.email, data.role, data.position, data.department, data.location_id, data.schedule_start,
          data.schedule_end, data.tolerance_min, data.work_days, data.active, id);
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) throw new HttpError(409, 'Ya existe un usuario con ese correo');
      throw err;
    }
    if (data.password) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(data.password), id);
    if (!data.active || data.password) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    return { user: publicUser(db, db.prepare('SELECT * FROM users WHERE id = ?').get(id)) };
  }));

  admin.post('/users/:id/reset-face', wrap((req) => {
    const r = db.prepare('UPDATE users SET face_descriptor = NULL, face_enrolled_at = NULL WHERE id = ?').run(Number(req.params.id));
    if (!r.changes) throw new HttpError(404, 'Usuario no encontrado');
    return { ok: true };
  }));

  admin.get('/locations', wrap(() => ({ locations: db.prepare('SELECT * FROM locations ORDER BY active DESC, name').all() })));

  admin.post('/locations', wrap((req, res) => {
    const d = validateLocation(req.body);
    const r = db.prepare(`INSERT INTO locations (name, address, lat, lng, radius_m, timezone, active)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(d.name, d.address, d.lat, d.lng, d.radius_m, d.timezone, d.active);
    res.status(201).json({ location: db.prepare('SELECT * FROM locations WHERE id = ?').get(r.lastInsertRowid) });
  }));

  admin.put('/locations/:id', wrap((req) => {
    const id = Number(req.params.id);
    const current = db.prepare('SELECT * FROM locations WHERE id = ?').get(id);
    if (!current) throw new HttpError(404, 'Ubicación no encontrada');
    const d = validateLocation({ ...current, ...req.body });
    db.prepare(`UPDATE locations SET name = ?, address = ?, lat = ?, lng = ?, radius_m = ?, timezone = ?, active = ?
      WHERE id = ?`).run(d.name, d.address, d.lat, d.lng, d.radius_m, d.timezone, d.active, id);
    return { location: db.prepare('SELECT * FROM locations WHERE id = ?').get(id) };
  }));

  admin.get('/records', wrap((req) => {
    const { from, to, userId, status } = req.query;
    if (!isDateString(from) || !isDateString(to)) throw new HttpError(400, 'Rango de fechas no válido');
    let sql = `SELECT r.id FROM records r JOIN users u ON u.id = r.user_id WHERE r.local_date BETWEEN ? AND ?`;
    const params = [from, to];
    if (userId) { sql += ' AND r.user_id = ?'; params.push(Number(userId)); }
    if (status === 'valid' || status === 'rejected') { sql += ' AND r.status = ?'; params.push(status); }
    const ids = db.prepare(`${sql} ORDER BY r.ts DESC, r.id DESC LIMIT 1000`).all(...params);
    return { records: ids.map(({ id }) => recordView(db, id)) };
  }));

  admin.get('/records/:id/snapshot', (req, res) => {
    const row = db.prepare('SELECT snapshot FROM records WHERE id = ?').get(Number(req.params.id));
    if (!row?.snapshot) return res.status(404).end();
    const [, mime, b64] = row.snapshot.match(/^data:([^;]+);base64,(.*)$/);
    res.type(mime).set('Cache-Control', 'private, max-age=86400').send(Buffer.from(b64, 'base64'));
  });

  admin.get('/departments', wrap(() => ({
    departments: db.prepare('SELECT DISTINCT department FROM users ORDER BY department').all().map((r) => r.department),
  })));

  admin.get('/reports', wrap((req, res) => {
    const { period = 'monthly', date, start, end, userId, department, locationId, format, kind } = req.query;
    let range;
    if (period === 'custom') {
      if (!isDateString(start) || !isDateString(end) || start > end) throw new HttpError(400, 'Rango de fechas no válido');
      if ((Date.parse(end) - Date.parse(start)) / 86400_000 > 366) throw new HttpError(400, 'El rango máximo es de un año');
      range = { start, end };
    } else {
      if (!['daily', 'weekly', 'monthly'].includes(period)) throw new HttpError(400, 'Periodo no válido');
      if (!isDateString(date)) throw new HttpError(400, 'Fecha no válida');
      range = periodRange(period, date);
    }
    const report = buildReport(db, { ...range, userId, department, locationId });
    if (format === 'csv') {
      const name = `asistencia_${kind === 'summary' ? 'resumen' : 'detalle'}_${range.start}_${range.end}.csv`;
      res.type('text/csv; charset=utf-8').attachment(name).send(reportToCsv(report, kind));
      return undefined;
    }
    return { period, ...report };
  }));

  app.use('/api/admin', admin);
  app.use('/api', (req, res) => res.status(404).json({ error: 'No encontrado' }));

  // ---------------- Frontend ----------------
  app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));

  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON no válido' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Solicitud demasiado grande' });
    console.error(err);
    res.status(500).json({ error: 'Error interno del servidor' });
  });

  return app;
}

function publicUser(db, u) {
  const location = u.location_id ? db.prepare('SELECT * FROM locations WHERE id = ?').get(u.location_id) : null;
  return {
    id: u.id, name: u.name, email: u.email, role: u.role, position: u.position, department: u.department,
    location_id: u.location_id, location_name: location?.name ?? null, location,
    timezone: userTimezone(db, u),
    schedule_start: u.schedule_start, schedule_end: u.schedule_end, tolerance_min: u.tolerance_min,
    work_days: u.work_days, active: !!u.active,
    face_enrolled: !!u.face_descriptor, face_enrolled_at: u.face_enrolled_at,
  };
}

function validateUser(db, b, { requirePassword }) {
  const s = (v) => (typeof v === 'string' ? v.trim() : '');
  const d = {
    name: s(b.name), email: s(b.email).toLowerCase(), password: b.password ? String(b.password) : '',
    role: b.role === 'admin' ? 'admin' : 'employee',
    position: s(b.position) || 'Personal Administrativo', department: s(b.department) || 'General',
    location_id: b.location_id ? Number(b.location_id) : null,
    schedule_start: s(b.schedule_start) || '09:00', schedule_end: s(b.schedule_end) || '18:00',
    tolerance_min: Number(b.tolerance_min ?? 10),
    work_days: Array.isArray(b.work_days) ? b.work_days.join(',') : s(b.work_days) || '1,2,3,4,5',
    active: b.active === false || b.active === 0 ? 0 : 1,
  };
  if (!d.name) throw new HttpError(400, 'El nombre es obligatorio');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) throw new HttpError(400, 'Correo no válido');
  if ((requirePassword || d.password) && d.password.length < 8) throw new HttpError(400, 'La contraseña debe tener al menos 8 caracteres');
  if (!isHHMM(d.schedule_start) || !isHHMM(d.schedule_end)) throw new HttpError(400, 'Horario no válido (HH:MM)');
  if (!Number.isInteger(d.tolerance_min) || d.tolerance_min < 0 || d.tolerance_min > 240) throw new HttpError(400, 'Tolerancia no válida');
  if (!/^[0-6](,[0-6])*$/.test(d.work_days)) throw new HttpError(400, 'Días laborales no válidos');
  if (d.location_id && !db.prepare('SELECT 1 FROM locations WHERE id = ?').get(d.location_id)) throw new HttpError(400, 'Ubicación no válida');
  return d;
}

function validateLocation(b) {
  const d = {
    name: String(b.name ?? '').trim(), address: String(b.address ?? '').trim(),
    lat: Number(b.lat), lng: Number(b.lng), radius_m: Number(b.radius_m ?? 150),
    timezone: String(b.timezone ?? ''), active: b.active === false || b.active === 0 ? 0 : 1,
  };
  if (!d.name) throw new HttpError(400, 'El nombre es obligatorio');
  if (!isLatitude(d.lat) || !isLongitude(d.lng)) throw new HttpError(400, 'Coordenadas no válidas');
  if (!Number.isInteger(d.radius_m) || d.radius_m < 20 || d.radius_m > 5000) throw new HttpError(400, 'El radio debe estar entre 20 y 5000 m');
  if (!isValidTimeZone(d.timezone)) throw new HttpError(400, 'Zona horaria no válida');
  return d;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  createApp().listen(port, () => console.log(`AsisteApp escuchando en http://localhost:${port}`));
}
