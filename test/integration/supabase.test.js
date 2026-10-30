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

async function api(token, method, path, body, headers = {}) {
  const res = await fetch(`${API_URL}/functions/v1/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }), ...headers },
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
  assert.ok(['admin', 'superadmin'].includes(me.body.user.role));

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

test('horas extras: solo administradores autorizan, con observaciones obligatorias', { skip: skip || !process.env.DB_URL }, async () => {
  const { default: postgres } = await import('postgres');
  const db = postgres(process.env.DB_URL, { max: 1 });
  try {
    const admin = await signIn(ADMIN);
    const [loc] = await db`select id from asiste.locations order by id limit 1`;
    const email = `extra.${stamp}@empresa.com`;
    const created = await api(admin.token, 'POST', '/admin/users', {
      name: 'Pedro Extra', email, password: 'secreta123', location_id: loc.id, schedule_start: '09:00', schedule_end: '18:00',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const userId = created.body.user.id;

    // Jornada de 10 h 30 min (09:00–19:30 en CDMX) hace dos días: 90 min de horas extras.
    const day = new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10);
    const [{ company_id: companyId }] = await db`select company_id from asiste.profiles where id = ${userId}`;
    const [{ id: inId }] = await db`insert into asiste.records (user_id, company_id, type, ts, local_date, local_time, timezone, location_id, status)
      values (${userId}, ${companyId}, 'in', ${`${day}T15:00:00Z`}, ${day}, '09:00:00', 'America/Mexico_City', ${loc.id}, 'valid') returning id`;
    await db`insert into asiste.records (user_id, company_id, type, ts, local_date, local_time, timezone, location_id, status)
      values (${userId}, ${companyId}, 'out', ${`${day}T01:30:00Z`}::timestamptz + interval '1 day', ${day}, '19:30:00', 'America/Mexico_City', ${loc.id}, 'valid')`;

    let r = await api(admin.token, 'GET', `/admin/overtime?from=${day}&to=${day}&userId=${userId}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.items.length, 1);
    assert.equal(r.body.items[0].overtimeMinutes, 90);
    assert.equal(r.body.items[0].overtime.status, 'pending');

    const pedro = await signIn({ email, password: 'secreta123' });
    r = await api(pedro.token, 'POST', `/admin/overtime/${inId}`, { status: 'approved', notes: 'Me autorizo solo' });
    assert.equal(r.status, 403, 'un empleado no puede autorizar');

    r = await api(admin.token, 'POST', `/admin/overtime/${inId}`, { status: 'approved', notes: '' });
    assert.equal(r.status, 400, 'las observaciones son obligatorias');
    r = await api(admin.token, 'POST', `/admin/overtime/${inId}`, { status: 'approved', approved_minutes: 120, notes: 'Cierre de mes' });
    assert.equal(r.status, 400, 'no se pueden autorizar más minutos de los trabajados');

    r = await api(admin.token, 'POST', `/admin/overtime/${inId}`, { status: 'approved', approved_minutes: 60, notes: 'Cierre de mes autorizado por gerencia' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.item.overtime.status, 'approved');
    assert.equal(r.body.item.overtime.approvedMinutes, 60);
    assert.equal(r.body.item.overtime.decidedBy, 'Administrador');

    const mine = await api(pedro.token, 'GET', `/me/records?month=${day.slice(0, 7)}`);
    const shift = mine.body.shifts.find((s) => s.inId === inId);
    assert.equal(shift.overtime.notes, 'Cierre de mes autorizado por gerencia');

    const rep = await api(admin.token, 'GET', `/admin/reports?period=custom&start=${day}&end=${day}&userId=${userId}`);
    assert.equal(rep.body.summary[0].overtimeMinutes, 90);
    assert.equal(rep.body.summary[0].approvedOvertimeMinutes, 60);
    const csv = await api(admin.token, 'GET', `/admin/reports?period=custom&start=${day}&end=${day}&userId=${userId}&format=csv`);
    assert.match(csv.body, /Autorizada/);
    assert.match(csv.body, /Cierre de mes autorizado por gerencia/);

    r = await api(admin.token, 'POST', `/admin/overtime/${inId}`, { status: 'rejected', notes: 'No fue solicitado por el jefe' });
    assert.equal(r.body.item.overtime.status, 'rejected');
    assert.equal(r.body.item.overtime.approvedMinutes, 0);
    r = await api(admin.token, 'GET', `/admin/overtime?from=${day}&to=${day}&userId=${userId}&status=pending`);
    assert.equal(r.body.items.length, 0);
  } finally {
    await db.end();
  }
});

test('varias empresas: datos aislados, superadministrador y borrado de registros', { skip: skip || !process.env.DB_URL }, async () => {
  const { default: postgres } = await import('postgres');
  const db = postgres(process.env.DB_URL, { max: 1 });
  try {
    await db`update asiste.profiles set role = 'superadmin' where email = ${ADMIN.email}`;
    const sup = await signIn(ADMIN);
    const me = await api(sup.token, 'GET', '/me');
    const companyA = me.body.user.company_id;

    // Alta de empresa con su administrador
    const bad = await api(sup.token, 'POST', '/super/companies', { name: 'X', admin_name: 'A', admin_email: 'no', admin_password: '1' });
    assert.equal(bad.status, 400);
    const emailB = `admin.b.${stamp}@empresa.com`;
    const created = await api(sup.token, 'POST', '/super/companies', {
      name: `Empresa B ${stamp}`, admin_name: 'Admin B', admin_email: emailB, admin_password: 'secretaB123',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const companyB = created.body.company.id;
    const dup = await api(sup.token, 'POST', '/super/companies', {
      name: `empresa b ${stamp}`, admin_name: 'Otro', admin_email: `otro.${stamp}@empresa.com`, admin_password: 'secretaB123',
    });
    assert.equal(dup.status, 409, 'nombre de empresa duplicado');

    const adminB = await signIn({ email: emailB, password: 'secretaB123' });
    const meB = await api(adminB.token, 'GET', '/me');
    assert.equal(meB.body.user.company_id, companyB);
    assert.equal(meB.body.user.role, 'admin');

    // El administrador de B no ve nada de A
    let r = await api(adminB.token, 'GET', '/admin/users');
    assert.deepEqual(r.body.users.map((u) => u.email), [emailB]);
    r = await api(adminB.token, 'GET', '/admin/locations');
    assert.equal(r.body.locations.length, 0);
    const today = new Date().toISOString().slice(0, 10);
    r = await api(adminB.token, 'GET', `/admin/records?from=2000-01-01&to=${today}`);
    assert.equal(r.body.records.length, 0);
    r = await api(adminB.token, 'GET', '/super/companies');
    assert.equal(r.status, 403, 'un administrador no gestiona empresas');
    // Pedir otra empresa por cabecera no tiene efecto para un administrador normal
    r = await api(adminB.token, 'GET', '/admin/users', undefined, { 'X-Company-Id': String(companyA) });
    assert.deepEqual(r.body.users.map((u) => u.email), [emailB]);
    const usersA = await api(sup.token, 'GET', '/admin/users');
    const someoneA = usersA.body.users.find((u) => u.role === 'employee');
    if (someoneA) {
      r = await api(adminB.token, 'PUT', `/admin/users/${someoneA.id}`, { name: 'Hackeado' });
      assert.equal(r.status, 404, 'no puede editar personal de otra empresa');
    }

    // B da de alta su ubicación y su empleado
    const loc = await api(adminB.token, 'POST', '/admin/locations', { name: 'Planta B', lat: 25.6866, lng: -100.3161, radius_m: 200, timezone: 'America/Monterrey' });
    assert.equal(loc.status, 201, JSON.stringify(loc.body));
    const emp = await api(adminB.token, 'POST', '/admin/users', { name: 'Empleado B', email: `emp.b.${stamp}@empresa.com`, password: 'secreta123', location_id: loc.body.location.id });
    assert.equal(emp.status, 201, JSON.stringify(emp.body));
    const ubicacionAjena = await api(adminB.token, 'POST', '/admin/users', { name: 'X', email: `x.${stamp}@empresa.com`, password: 'secreta123', location_id: 1 });
    assert.equal(ubicacionAjena.status, 400, 'no puede usar ubicaciones de otra empresa');

    // El superadministrador entra a la empresa B con la cabecera
    r = await api(sup.token, 'GET', '/admin/users', undefined, { 'X-Company-Id': String(companyB) });
    assert.equal(r.body.users.length, 2);

    // Registros de B y borrado aislado
    const day = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
    for (const [type, ts] of [['in', `${day}T15:00:00Z`], ['out', `${day}T23:00:00Z`]]) {
      await db`insert into asiste.records (user_id, company_id, type, ts, local_date, local_time, timezone, location_id, status)
        values (${emp.body.user.id}, ${companyB}, ${type}, ${ts}, ${day}, '09:00:00', 'America/Monterrey', ${loc.body.location.id}, 'valid')`;
    }
    const [{ n: countA }] = await db`select count(*)::int as n from asiste.records where company_id = ${companyA}`;
    r = await api(adminB.token, 'POST', '/admin/records/delete', { confirm: 'borrar' });
    assert.equal(r.status, 400, 'requiere escribir ELIMINAR');
    r = await api(adminB.token, 'POST', '/admin/records/delete', { confirm: 'ELIMINAR' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.deleted, 2);
    const [{ n: countAAfter }] = await db`select count(*)::int as n from asiste.records where company_id = ${companyA}`;
    assert.equal(countAAfter, countA, 'los registros de la otra empresa no se tocan');

    // Desactivar la empresa bloquea a su personal
    r = await api(sup.token, 'PUT', `/super/companies/${companyB}`, { active: false });
    assert.equal(r.status, 200);
    assert.equal((await api(adminB.token, 'GET', '/me')).status, 403);
    r = await api(sup.token, 'PUT', `/super/companies/${companyA}`, { active: false });
    assert.equal(r.status, 400, 'no puede desactivar su propia empresa');
  } finally {
    await db.end();
  }
});

test('usuarios: desactivar, eliminar y protecciones', { skip: skip || !process.env.DB_URL }, async () => {
  const { default: postgres } = await import('postgres');
  const db = postgres(process.env.DB_URL, { max: 1 });
  try {
    const admin = await signIn(ADMIN);
    const me = (await api(admin.token, 'GET', '/me')).body.user;
    const email = `borrar.${stamp}@empresa.com`;
    const created = await api(admin.token, 'POST', '/admin/users', { name: 'Para Borrar', email, password: 'secreta123' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.user.id;
    await db`insert into asiste.records (user_id, company_id, type, ts, local_date, local_time, timezone, status)
      values (${id}, ${me.company_id}, 'in', now(), '2026-01-05', '09:00:00', 'UTC', 'valid')`;

    let r = await api(admin.token, 'PUT', `/admin/users/${id}`, { active: false });
    assert.equal(r.status, 200);
    assert.equal(r.body.user.active, false);
    await assert.rejects(signIn({ email, password: 'secreta123' }), 'un usuario desactivado no puede entrar');
    r = await api(admin.token, 'PUT', `/admin/users/${id}`, { active: true });
    assert.equal(r.body.user.active, true);

    assert.equal((await api(admin.token, 'DELETE', `/admin/users/${me.id}`)).status, 400, 'no puede eliminarse a sí mismo');
    r = await api(admin.token, 'DELETE', `/admin/users/${id}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await db`select count(*)::int as n from asiste.profiles where id = ${id}`)[0].n, 0);
    assert.equal((await db`select count(*)::int as n from asiste.records where user_id = ${id}`)[0].n, 0);
    assert.equal((await db`select count(*)::int as n from auth.users where id = ${id}`)[0].n, 0);
    assert.equal((await api(admin.token, 'DELETE', `/admin/users/${id}`)).status, 404);
  } finally {
    await db.end();
  }
});
