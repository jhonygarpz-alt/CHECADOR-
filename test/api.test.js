import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { createApp } from '../server/index.js';
import { registerAttendance } from '../server/attendance.js';
import { buildDashboard, buildReport } from '../server/reports.js';

process.env.NODE_ENV = 'test';

const FACE = Array.from({ length: 128 }, (_, i) => Math.sin(i) / 10);
const OTHER_FACE = FACE.map((x) => x + 0.08); // distancia ≈ 0.9
const OFFICE = { lat: 19.4326, lng: -99.1332 };

let db, server, base, adminToken;

async function api(method, url, body, token = adminToken) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
}

before(async () => {
  db = openDb(':memory:');
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await api('POST', '/api/auth/login', { email: 'admin@empresa.com', password: 'admin123' }, null);
  assert.equal(login.status, 200);
  adminToken = login.body.token;
});

after(() => server.close());

test('flujo completo: alta, enrolamiento facial, entrada, salida y reporte', async () => {
  const created = await api('POST', '/api/admin/users', {
    name: 'Ana García', email: 'ana@empresa.com', password: 'secreta123', department: 'Finanzas',
    location_id: 1, schedule_start: '09:00', tolerance_min: 10,
  });
  assert.equal(created.status, 201);

  const { body: { token } } = await api('POST', '/api/auth/login', { email: 'ana@empresa.com', password: 'secreta123' }, null);

  // Sin rostro registrado no se puede checar
  let r = await api('POST', '/api/attendance', { type: 'in', ...OFFICE, accuracy: 10, descriptor: FACE }, token);
  assert.equal(r.status, 409);

  r = await api('POST', '/api/me/face', { descriptors: [FACE, FACE, FACE] }, token);
  assert.equal(r.status, 200);
  assert.equal(r.body.user.face_enrolled, true);

  // Rostro distinto → rechazado y auditado
  r = await api('POST', '/api/attendance', { type: 'in', ...OFFICE, accuracy: 10, descriptor: OTHER_FACE }, token);
  assert.equal(r.status, 422);
  assert.equal(r.body.checks.face.ok, false);

  // Fuera de la geocerca (~1.1 km) → rechazado
  r = await api('POST', '/api/attendance', { type: 'in', lat: OFFICE.lat + 0.01, lng: OFFICE.lng, accuracy: 10, descriptor: FACE }, token);
  assert.equal(r.status, 422);
  assert.equal(r.body.checks.location.ok, false);

  // Salida sin entrada
  r = await api('POST', '/api/attendance', { type: 'out', ...OFFICE, accuracy: 10, descriptor: FACE }, token);
  assert.equal(r.status, 409);

  r = await api('POST', '/api/attendance', { type: 'in', lat: OFFICE.lat + 0.0005, lng: OFFICE.lng, accuracy: 15, descriptor: FACE }, token);
  assert.equal(r.status, 201);
  assert.equal(r.body.record.status, 'valid');
  assert.equal(r.body.record.timezone, 'America/Mexico_City');

  r = await api('POST', '/api/attendance', { type: 'in', ...OFFICE, accuracy: 10, descriptor: FACE }, token);
  assert.equal(r.status, 409, 'no se permiten dos entradas seguidas');

  r = await api('POST', '/api/attendance', { type: 'out', ...OFFICE, accuracy: 10, descriptor: FACE }, token);
  assert.equal(r.status, 201);
  assert.equal(typeof r.body.workedMinutes, 'number');

  const status = await api('GET', '/api/me/status', null, token);
  assert.equal(status.body.open, null);
  assert.ok(status.body.shift.outTime);

  const dash = await api('GET', '/api/admin/dashboard');
  assert.equal(dash.body.totals.present, 1);
  assert.equal(dash.body.totals.inside, 0);
  assert.equal(dash.body.latest.filter((x) => x.status === 'rejected').length, 2);

  const today = status.body.today;
  const rep = await api('GET', `/api/admin/reports?period=weekly&date=${today}`);
  assert.equal(rep.status, 200);
  assert.equal(rep.body.rows.length, 1);
  assert.equal(rep.body.summary[0].daysWorked, 1);

  const csv = await api('GET', `/api/admin/reports?period=daily&date=${today}&format=csv`);
  assert.match(csv.body, /Ana García/);

  // Un empleado no accede a la administración
  r = await api('GET', '/api/admin/dashboard', null, token);
  assert.equal(r.status, 403);
});

test('reportes: retardos, faltas y horas en la zona horaria del empleado', () => {
  const loc = db.prepare(`INSERT INTO locations (name, lat, lng, radius_m, timezone) VALUES ('Tijuana', 32.5149, -117.0382, 200, 'America/Tijuana')`).run();
  const u = db.prepare(`INSERT INTO users (name, email, password_hash, department, location_id, schedule_start, tolerance_min, face_descriptor, created_at)
    VALUES ('Luis', 'luis@empresa.com', 'x:y', 'Compras', ?, '08:00', 5, ?, '2025-03-01T00:00:00Z')`).run(loc.lastInsertRowid, JSON.stringify(FACE));
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(u.lastInsertRowid);
  const at = { lat: 32.5149, lng: -117.0382, accuracy: 5, descriptor: FACE };

  // Lunes 24/03/2025: 08:03 local (15:03 UTC, UTC-7) → puntual; salida 17:00
  registerAttendance(db, user, { type: 'in', ...at }, { now: new Date('2025-03-24T15:03:00Z') });
  registerAttendance(db, user, { type: 'out', ...at }, { now: new Date('2025-03-25T00:00:00Z') });
  // Martes: 08:20 local → retardo
  const late = registerAttendance(db, user, { type: 'in', ...at }, { now: new Date('2025-03-25T15:20:00Z') });
  assert.equal(late.record.late, 1);
  assert.equal(late.record.local_time, '08:20:00');
  registerAttendance(db, user, { type: 'out', ...at }, { now: new Date('2025-03-25T23:50:00Z') });

  const rep = buildReport(db, { start: '2025-03-24', end: '2025-03-30', userId: user.id, now: new Date('2025-04-10T00:00:00Z') });
  const s = rep.summary[0];
  assert.equal(s.timezone, 'America/Tijuana');
  assert.equal(s.daysWorked, 2);
  assert.equal(s.lateCount, 1);
  assert.equal(s.expectedDays, 5);
  assert.equal(s.absences, 3); // miércoles a viernes
  assert.equal(s.totalMinutes, 537 + 510);
  assert.equal(rep.series.find((d) => d.date === '2025-03-24').present, 1);

  const dash = buildDashboard(db, new Date('2025-03-25T16:00:00Z'));
  const luis = dash.people.find((p) => p.id === user.id);
  assert.equal(luis.present, true);
  assert.equal(luis.late, true);
});
