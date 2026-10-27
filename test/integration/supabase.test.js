// Prueba de punta a punta contra un Supabase local (supabase start + supabase functions serve).
// Uso: eval "$(npx supabase status -o env)" && npm run test:integration
// La función debe tener ADMIN_EMAILS=admin@empresa.com (ver supabase/functions/.env.example).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';

const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = process.env;
const skip = !API_URL || !ANON_KEY || !SERVICE_ROLE_KEY ? 'Supabase local no configurado' : false;

const FACE = Array.from({ length: 128 }, (_, i) => Math.sin(i) / 10);
const OTHER_FACE = FACE.map((x) => x + 0.08);
const OFFICE = { lat: 19.4326, lng: -99.1332 };
const ADMIN = { email: 'admin@empresa.com', password: 'admin-secreto-123' };
const stamp = Date.now();

let service;
const clients = [];

async function signIn({ email, password }) {
  const client = createClient(API_URL, ANON_KEY, { auth: { persistSession: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  clients.push(client);
  return { client, token: data.session.access_token };
}

async function api(token, method, path, body) {
  const res = await fetch(`${API_URL}/functions/v1/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, body: type.includes('json') ? await res.json() : await res.text() };
}

before(async () => {
  if (skip) return;
  service = createClient(API_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data } = await service.auth.admin.listUsers();
  if (!data.users.some((u) => u.email === ADMIN.email)) {
    const { error } = await service.auth.admin.createUser({ ...ADMIN, email_confirm: true });
    if (error) throw error;
  }
});

after(async () => {
  for (const c of clients) await c.removeAllChannels();
});

test('flujo completo en Supabase: alta, rostro, entrada, salida, tiempo real y reportes', { skip }, async () => {
  const admin = await signIn(ADMIN);
  const me = await api(admin.token, 'GET', '/me');
  assert.equal(me.status, 200, JSON.stringify(me.body));
  assert.equal(me.body.user.role, 'admin');

  const loc = await api(admin.token, 'POST', '/admin/locations', {
    name: `Oficina ${stamp}`, address: 'Av. Insurgentes 123, CDMX', ...OFFICE, radius_m: 150, timezone: 'America/Mexico_City',
  });
  assert.equal(loc.status, 201, JSON.stringify(loc.body));

  const email = `ana.${stamp}@empresa.com`;
  const created = await api(admin.token, 'POST', '/admin/users', {
    name: 'Ana García', email, password: 'secreta123', department: 'Finanzas', location_id: loc.body.location.id,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const dup = await api(admin.token, 'POST', '/admin/users', { name: 'Otra', email, password: 'secreta123' });
  assert.equal(dup.status, 409);

  const ana = await signIn({ email, password: 'secreta123' });
  assert.equal((await api(ana.token, 'GET', '/admin/dashboard')).status, 403);

  // Tiempo real: el administrador ve todos los registros; el empleado, solo los suyos (RLS).
  const adminEvents = [];
  await new Promise((resolve, reject) => {
    admin.client.realtime.setAuth(admin.token);
    admin.client.channel('admin-records')
      .on('postgres_changes', { event: 'INSERT', schema: 'asiste', table: 'records' }, (p) => adminEvents.push(p.new))
      .subscribe((status) => (status === 'SUBSCRIBED' ? resolve() : status === 'CHANNEL_ERROR' && reject(new Error(status))));
  });

  let r = await api(ana.token, 'POST', '/attendance', { type: 'in', ...OFFICE, accuracy: 10, descriptor: FACE });
  assert.equal(r.status, 409, 'sin rostro registrado');

  r = await api(ana.token, 'POST', '/me/face', { descriptors: [FACE, FACE, FACE] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.user.face_enrolled, true);

  r = await api(ana.token, 'POST', '/attendance', { type: 'in', ...OFFICE, accuracy: 10, descriptor: OTHER_FACE });
  assert.equal(r.status, 422);
  assert.equal(r.body.checks.face.ok, false);

  r = await api(ana.token, 'POST', '/attendance', { type: 'in', lat: OFFICE.lat + 0.01, lng: OFFICE.lng, accuracy: 10, descriptor: FACE });
  assert.equal(r.status, 422);
  assert.equal(r.body.checks.location.ok, false);

  const pixel = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
  r = await api(ana.token, 'POST', '/attendance', { type: 'in', lat: OFFICE.lat + 0.0005, lng: OFFICE.lng, accuracy: 15, descriptor: FACE, snapshot: pixel });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.record.timezone, 'America/Mexico_City');
  assert.equal(r.body.record.has_snapshot, true);
  const inId = r.body.record.id;

  r = await api(ana.token, 'POST', '/attendance', { type: 'in', ...OFFICE, accuracy: 10, descriptor: FACE });
  assert.equal(r.status, 409, 'no se permiten dos entradas seguidas');

  r = await api(ana.token, 'POST', '/attendance', { type: 'out', ...OFFICE, accuracy: 10, descriptor: FACE });
  assert.equal(r.status, 201);
  assert.equal(typeof r.body.workedMinutes, 'number');

  const status = await api(ana.token, 'GET', '/me/status');
  assert.equal(status.body.open, null);
  assert.ok(status.body.shift.outTime);

  const month = await api(ana.token, 'GET', `/me/records?month=${status.body.today.slice(0, 7)}`);
  assert.equal(month.body.shifts.length, 1);

  const photo = await api(admin.token, 'GET', `/admin/records/${inId}/snapshot`);
  assert.equal(photo.status, 200, JSON.stringify(photo.body));
  // En local la URL firmada usa el host interno de Docker (kong:8000); en la nube es la URL pública.
  assert.equal((await fetch(photo.body.url.replace('http://kong:8000', API_URL))).status, 200);

  const dash = await api(admin.token, 'GET', '/admin/dashboard');
  assert.ok(dash.body.people.find((p) => p.name === 'Ana García' && p.present));

  const rep = await api(admin.token, 'GET', `/admin/reports?period=weekly&date=${status.body.today}&userId=${created.body.user.id}`);
  assert.equal(rep.status, 200);
  assert.equal(rep.body.summary[0].daysWorked, 1);
  const csv = await api(admin.token, 'GET', `/admin/reports?period=daily&date=${status.body.today}&format=csv`);
  assert.match(csv.body, /Ana García/);

  // Desactivar al empleado bloquea su acceso.
  r = await api(admin.token, 'PUT', `/admin/users/${created.body.user.id}`, { active: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok([401, 403].includes((await api(ana.token, 'GET', '/me')).status));

  await new Promise((res) => setTimeout(res, 1500));
  assert.ok(adminEvents.length >= 4, `eventos en tiempo real: ${adminEvents.length}`);
  assert.ok(adminEvents.some((e) => e.id === inId));
});
