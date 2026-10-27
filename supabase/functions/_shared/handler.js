// API de AsisteApp independiente del entorno: recibe un Request estándar y devuelve un Response.
// En producción la ejecuta la Edge Function `api` (Deno); en las pruebas, Node.
//
// Dependencias inyectadas:
//   sql      → cliente postgres.js conectado a la base de datos
//   auth     → { getUser(token), createUser({ email, password }), updateUser(id, { email?, password?, banned? }) }
//   storage  → { upload(path, bytes, contentType), signedUrl(path, seconds) }
//   config   → ver loadConfig()

import { HttpError, listRecords, openShift, recordView, registerAttendance, userTimezone } from './attendance.js';
import { averageDescriptor, isValidDescriptor } from './face.js';
import { isLatitude, isLongitude } from './geo.js';
import { buildDashboard, buildReport, pairShifts, reportToCsv } from './reports.js';
import { addDays, isDateString, isHHMM, isValidTimeZone, periodRange, zonedParts } from './time.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Expose-Headers': 'content-disposition',
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
});

export function createHandler({ sql, auth, storage, config }) {
  const routes = [];
  const route = (method, pattern, opts, fn) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
    routes.push({ method, re, keys, fn, ...opts });
  };
  const PUBLIC = { public: true };
  const USER = {};
  const ADMIN = { admin: true };

  async function loadProfile(id) {
    const [p] = await sql`select p.*, l.name as location_name, (f.user_id is not null) as face_enrolled, f.enrolled_at as face_enrolled_at
      from asiste.profiles p left join asiste.locations l on l.id = p.location_id
      left join asiste.face_templates f on f.user_id = p.id where p.id = ${id}`;
    return p ?? null;
  }

  async function publicUser(p) {
    const location = p.location_id ? (await sql`select * from asiste.locations where id = ${p.location_id}`)[0] : null;
    return {
      id: p.id, name: p.name, email: p.email, role: p.role, position: p.position, department: p.department,
      location_id: p.location_id, location_name: location?.name ?? null, location,
      timezone: location?.timezone ?? config.defaultTz,
      schedule_start: p.schedule_start, schedule_end: p.schedule_end, tolerance_min: p.tolerance_min,
      work_days: p.work_days, active: p.active, face_enrolled: !!p.face_enrolled, face_enrolled_at: p.face_enrolled_at,
    };
  }

  /** Obtiene el perfil del usuario autenticado; crea el del administrador inicial (ADMIN_EMAILS). */
  async function currentUser(req) {
    const header = req.headers.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const authUser = token ? await auth.getUser(token) : null;
    if (!authUser) throw new HttpError(401, 'Sesión no válida o expirada');
    let profile = await loadProfile(authUser.id);
    if (!profile && config.adminEmails.includes(String(authUser.email).toLowerCase())) {
      await sql`insert into asiste.profiles (id, name, email, role, position, department)
        values (${authUser.id}, 'Administrador', ${authUser.email}, 'admin', 'Administrador', 'Recursos Humanos')
        on conflict (id) do nothing`;
      profile = await loadProfile(authUser.id);
    }
    if (!profile) throw new HttpError(403, 'Tu cuenta no está dada de alta en AsisteApp. Contacta a Recursos Humanos.');
    if (!profile.active) throw new HttpError(403, 'Tu cuenta está desactivada');
    return profile;
  }

  // ---------------- Público ----------------

  route('GET', '/time', PUBLIC, () => json({ now: new Date().toISOString() }));

  // ---------------- Usuario ----------------

  route('GET', '/me', USER, async ({ user }) => json({ user: await publicUser(user) }));

  // Enrolamiento facial: una sola vez; para repetirlo un administrador debe restablecerlo.
  route('POST', '/me/face', USER, async ({ user, body }) => {
    if (user.face_enrolled) throw new HttpError(409, 'Tu rostro ya está registrado. Pide a un administrador que lo restablezca.');
    const d = body?.descriptors;
    if (!Array.isArray(d) || d.length < 3 || d.length > 10 || !d.every(isValidDescriptor)) {
      throw new HttpError(400, 'Se requieren entre 3 y 10 capturas faciales válidas');
    }
    await sql`insert into asiste.face_templates (user_id, descriptor) values (${user.id}, ${averageDescriptor(d)})
      on conflict (user_id) do nothing`;
    return json({ user: await publicUser(await loadProfile(user.id)) });
  });

  route('GET', '/me/status', USER, async ({ user }) => {
    const now = new Date();
    const tz = await userTimezone(sql, user, config);
    const today = zonedParts(now, tz).date;
    const recent = await sql`select * from asiste.records where user_id = ${user.id} and status = 'valid'
      and local_date >= ${addDays(today, -1)} order by ts, id`;
    const shift = pairShifts(recent, config.maxShiftHours).filter((s) => s.date === today).at(-1) ?? null;
    const open = await openShift(sql, user.id, config, now);
    return json({ now: now.toISOString(), timezone: tz, today, open: open ? { ts: open.ts } : null, shift });
  });

  route('GET', '/me/records', USER, async ({ user, query }) => {
    const month = String(query.get('month') ?? '');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpError(400, 'Mes no válido (AAAA-MM)');
    const { start, end } = periodRange('monthly', `${month}-01`);
    const records = await sql`select r.*, l.name as location_name from asiste.records r
      left join asiste.locations l on l.id = r.location_id
      where r.user_id = ${user.id} and r.status = 'valid' and r.local_date between ${start} and ${addDays(end, 1)}
      order by r.ts, r.id`;
    return json({ month, shifts: pairShifts(records, config.maxShiftHours).filter((s) => s.date <= end).reverse() });
  });

  route('POST', '/attendance', USER, async ({ user, body, req }) => {
    const result = await registerAttendance(sql, user, body, { config, storage, userAgent: req.headers.get('user-agent') ?? '' });
    return json(result, 201);
  });

  // ---------------- Administración ----------------

  route('GET', '/admin/dashboard', ADMIN, async () => json(await buildDashboard(sql, config)));

  route('GET', '/admin/users', ADMIN, async () => {
    const rows = await sql`select p.*, (f.user_id is not null) as face_enrolled, f.enrolled_at as face_enrolled_at
      from asiste.profiles p left join asiste.face_templates f on f.user_id = p.id order by p.active desc, p.name`;
    return json({ users: await Promise.all(rows.map(publicUser)) });
  });

  route('POST', '/admin/users', ADMIN, async ({ body }) => {
    const d = await validateUser(body, { requirePassword: true });
    if ((await sql`select 1 from asiste.profiles where lower(email) = ${d.email}`).length) {
      throw new HttpError(409, 'Ya existe un usuario con ese correo');
    }
    const { id } = await auth.createUser({ email: d.email, password: d.password });
    await sql`insert into asiste.profiles (id, name, email, role, position, department, location_id, schedule_start,
        schedule_end, tolerance_min, work_days, active)
      values (${id}, ${d.name}, ${d.email}, ${d.role}, ${d.position}, ${d.department}, ${d.location_id},
        ${d.schedule_start}, ${d.schedule_end}, ${d.tolerance_min}, ${d.work_days}, ${d.active})`;
    if (!d.active) await auth.updateUser(id, { banned: true });
    return json({ user: await publicUser(await loadProfile(id)) }, 201);
  });

  route('PUT', '/admin/users/:id', ADMIN, async ({ user, params, body }) => {
    const current = UUID.test(params.id) ? await loadProfile(params.id) : null;
    if (!current) throw new HttpError(404, 'Usuario no encontrado');
    const d = await validateUser({ ...(await publicUser(current)), ...body }, { requirePassword: false });
    if (current.id === user.id && (d.role !== 'admin' || !d.active)) {
      throw new HttpError(400, 'No puedes quitarte el rol de administrador ni desactivarte');
    }
    if (d.email !== current.email.toLowerCase()
      && (await sql`select 1 from asiste.profiles where lower(email) = ${d.email} and id <> ${current.id}`).length) {
      throw new HttpError(409, 'Ya existe un usuario con ese correo');
    }
    await auth.updateUser(current.id, {
      ...(d.email !== current.email.toLowerCase() && { email: d.email }),
      ...(d.password && { password: d.password }),
      ...(d.active !== current.active && { banned: !d.active }),
    });
    await sql`update asiste.profiles set name = ${d.name}, email = ${d.email}, role = ${d.role}, position = ${d.position},
        department = ${d.department}, location_id = ${d.location_id}, schedule_start = ${d.schedule_start},
        schedule_end = ${d.schedule_end}, tolerance_min = ${d.tolerance_min}, work_days = ${d.work_days}, active = ${d.active}
      where id = ${current.id}`;
    return json({ user: await publicUser(await loadProfile(current.id)) });
  });

  route('POST', '/admin/users/:id/reset-face', ADMIN, async ({ params }) => {
    if (!UUID.test(params.id) || !(await loadProfile(params.id))) throw new HttpError(404, 'Usuario no encontrado');
    await sql`delete from asiste.face_templates where user_id = ${params.id}`;
    return json({ ok: true });
  });

  route('GET', '/admin/locations', ADMIN, async () => json({
    locations: await sql`select * from asiste.locations order by active desc, name`,
  }));

  route('POST', '/admin/locations', ADMIN, async ({ body }) => {
    const d = validateLocation(body);
    const [location] = await sql`insert into asiste.locations ${sql(d)} returning *`;
    return json({ location }, 201);
  });

  route('PUT', '/admin/locations/:id', ADMIN, async ({ params, body }) => {
    const [current] = await sql`select * from asiste.locations where id = ${Number(params.id) || 0}`;
    if (!current) throw new HttpError(404, 'Ubicación no encontrada');
    const d = validateLocation({ ...current, ...body });
    const [location] = await sql`update asiste.locations set ${sql(d)} where id = ${current.id} returning *`;
    return json({ location });
  });

  route('GET', '/admin/records', ADMIN, async ({ query }) => {
    const from = query.get('from');
    const to = query.get('to');
    const userId = query.get('userId');
    const status = query.get('status');
    if (!isDateString(from) || !isDateString(to)) throw new HttpError(400, 'Rango de fechas no válido');
    if (userId && !UUID.test(userId)) throw new HttpError(400, 'Empleado no válido');
    return json({
      records: await listRecords(sql, { from, to, userId, status: ['valid', 'rejected'].includes(status) ? status : null }),
    });
  });

  route('GET', '/admin/records/:id/snapshot', ADMIN, async ({ params }) => {
    const [row] = await sql`select snapshot_path from asiste.records where id = ${Number(params.id) || 0}`;
    if (!row?.snapshot_path) throw new HttpError(404, 'Sin foto');
    return json({ url: await storage.signedUrl(row.snapshot_path, 300) });
  });

  route('GET', '/admin/departments', ADMIN, async () => json({
    departments: (await sql`select distinct department from asiste.profiles order by department`).map((r) => r.department),
  }));

  route('GET', '/admin/reports', ADMIN, async ({ query }) => {
    const q = Object.fromEntries(query);
    const { period = 'monthly', date, start, end, userId, department, locationId, format, kind } = q;
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
    if (userId && !UUID.test(userId)) throw new HttpError(400, 'Empleado no válido');
    const report = await buildReport(sql, config, { ...range, userId, department, locationId });
    if (format === 'csv') {
      const name = `asistencia_${kind === 'summary' ? 'resumen' : 'detalle'}_${range.start}_${range.end}.csv`;
      return new Response(reportToCsv(report, kind), {
        headers: { ...CORS, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` },
      });
    }
    return json({ period, ...report });
  });

  // ---------------- Validaciones ----------------

  async function validateUser(b, { requirePassword }) {
    const s = (v) => (typeof v === 'string' ? v.trim() : '');
    const d = {
      name: s(b.name), email: s(b.email).toLowerCase(), password: b.password ? String(b.password) : '',
      role: b.role === 'admin' ? 'admin' : 'employee',
      position: s(b.position) || 'Personal Administrativo', department: s(b.department) || 'General',
      location_id: b.location_id ? Number(b.location_id) : null,
      schedule_start: s(b.schedule_start) || '09:00', schedule_end: s(b.schedule_end) || '18:00',
      tolerance_min: Number(b.tolerance_min ?? 10),
      work_days: Array.isArray(b.work_days) ? b.work_days.join(',') : s(b.work_days) || '1,2,3,4,5',
      active: !(b.active === false || b.active === 0),
    };
    if (!d.name) throw new HttpError(400, 'El nombre es obligatorio');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) throw new HttpError(400, 'Correo no válido');
    if ((requirePassword || d.password) && d.password.length < 8) throw new HttpError(400, 'La contraseña debe tener al menos 8 caracteres');
    if (!isHHMM(d.schedule_start) || !isHHMM(d.schedule_end)) throw new HttpError(400, 'Horario no válido (HH:MM)');
    if (!Number.isInteger(d.tolerance_min) || d.tolerance_min < 0 || d.tolerance_min > 240) throw new HttpError(400, 'Tolerancia no válida');
    if (!/^[0-6](,[0-6])*$/.test(d.work_days)) throw new HttpError(400, 'Días laborales no válidos');
    if (d.location_id && !(await sql`select 1 from asiste.locations where id = ${d.location_id}`).length) {
      throw new HttpError(400, 'Ubicación no válida');
    }
    return d;
  }

  function validateLocation(b) {
    const d = {
      name: String(b.name ?? '').trim(), address: String(b.address ?? '').trim(),
      lat: Number(b.lat), lng: Number(b.lng), radius_m: Number(b.radius_m ?? 150),
      timezone: String(b.timezone ?? ''), active: !(b.active === false || b.active === 0),
    };
    if (!d.name) throw new HttpError(400, 'El nombre es obligatorio');
    if (!isLatitude(d.lat) || !isLongitude(d.lng)) throw new HttpError(400, 'Coordenadas no válidas');
    if (!Number.isInteger(d.radius_m) || d.radius_m < 20 || d.radius_m > 5000) throw new HttpError(400, 'El radio debe estar entre 20 y 5000 m');
    if (!isValidTimeZone(d.timezone)) throw new HttpError(400, 'Zona horaria no válida');
    return d;
  }

  // ---------------- Despacho ----------------

  return async function handle(req) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    // La función se publica como /functions/v1/api/...; dentro llega como /api/...
    const path = url.pathname.replace(/^.*?\/api(?=\/|$)/, '') || '/';
    try {
      const r = routes.find((x) => x.method === req.method && x.re.test(path));
      if (!r) throw new HttpError(404, 'No encontrado');
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(path.match(r.re)[i + 1])]));
      const ctx = { req, params, query: url.searchParams };
      if (!r.public) {
        ctx.user = await currentUser(req);
        if (r.admin && ctx.user.role !== 'admin') throw new HttpError(403, 'Solo administradores');
      }
      if (req.method === 'POST' || req.method === 'PUT') {
        const text = await req.text();
        if (text.length > 1_000_000) throw new HttpError(413, 'Solicitud demasiado grande');
        try {
          ctx.body = text ? JSON.parse(text) : {};
        } catch {
          throw new HttpError(400, 'JSON no válido');
        }
      }
      return await r.fn(ctx);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message, ...err.extra }, err.status);
      console.error(err);
      return json({ error: 'Error interno del servidor' }, 500);
    }
  };
}
