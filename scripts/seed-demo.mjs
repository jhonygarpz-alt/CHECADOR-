// Genera ubicaciones, empleados y ~6 semanas de registros de ejemplo para probar el panel y los reportes.
// Requiere: API_URL, SERVICE_ROLE_KEY y DB_URL (local: eval "$(npx supabase status -o env)").
// Uso: npm run seed:demo   (contraseña de todos los empleados demo: demo1234)
import postgres from 'postgres';
import { createClient } from '@supabase/supabase-js';
import { addDays, weekdayOf, zonedParts } from '../supabase/functions/_shared/time.js';

const { API_URL, SERVICE_ROLE_KEY, DB_URL } = process.env;
if (!API_URL || !SERVICE_ROLE_KEY || !DB_URL) {
  console.error('Define API_URL, SERVICE_ROLE_KEY y DB_URL (local: eval "$(npx supabase status -o env)")');
  process.exit(1);
}
const sql = postgres(DB_URL, { prepare: false, max: 1 });
const admin = createClient(API_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function location(name, address, lat, lng, radius, timezone) {
  const [found] = await sql`select * from asiste.locations where name = ${name}`;
  if (found) return found;
  const [created] = await sql`insert into asiste.locations (name, address, lat, lng, radius_m, timezone)
    values (${name}, ${address}, ${lat}, ${lng}, ${radius}, ${timezone}) returning *`;
  return created;
}

// Convierte una fecha + minutos locales en un instante UTC dentro de la zona horaria indicada.
function zonedInstant(date, minutes, tz) {
  const guess = new Date(`${date}T00:00:00Z`).getTime() + minutes * 60_000;
  const p = zonedParts(new Date(guess), tz);
  return new Date(guess - (new Date(`${p.date}T${p.time}Z`).getTime() - guess));
}

const rand = (a, b) => a + Math.random() * (b - a);
const now = new Date();
const office = await location('Oficina Central', 'Av. Insurgentes 123, CDMX', 19.4326, -99.1332, 150, 'America/Mexico_City');
const north = await location('Sucursal Tijuana', 'Blvd. Agua Caliente 456, Tijuana', 32.5149, -117.0382, 200, 'America/Tijuana');

const people = [
  ['Ana García', 'Finanzas', office, '09:00'],
  ['Luis Ramírez', 'Recursos Humanos', office, '09:00'],
  ['María López', 'Contabilidad', office, '08:30'],
  ['Carlos Díaz', 'Compras', office, '09:00'],
  ['Sofía Hernández', 'Finanzas', north, '08:00'],
  ['Jorge Martínez', 'Ventas', north, '08:00'],
];

for (const [name, department, loc, start] of people) {
  const email = `${name.split(' ')[0].normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()}@empresa.com`;
  if ((await sql`select 1 from asiste.profiles where email = ${email}`).length) continue;
  const { data, error } = await admin.auth.admin.createUser({ email, password: 'demo1234', email_confirm: true });
  if (error) throw error;
  const [h, m] = start.split(':').map(Number);
  const startMin = h * 60 + m;
  const today = zonedParts(now, loc.timezone).date;
  const hired = addDays(today, -45);
  await sql`insert into asiste.profiles (id, name, email, department, location_id, schedule_start, schedule_end, created_at)
    values (${data.user.id}, ${name}, ${email}, ${department}, ${loc.id}, ${start},
      ${`${String(h + 9).padStart(2, '0')}:${String(m).padStart(2, '0')}`}, ${`${hired}T06:00:00Z`})`;

  const rows = [];
  for (let d = hired; d < today; d = addDays(d, 1)) {
    const wd = weekdayOf(d);
    if (wd === 0 || wd === 6 || Math.random() < 0.06) continue; // fines de semana y alguna falta
    const inMin = startMin + Math.round(rand(-15, Math.random() < 0.15 ? 35 : 9));
    const outMin = inMin + Math.round(rand(8.5 * 60, 9.4 * 60));
    for (const [type, mins] of [['in', inMin], ['out', outMin]]) {
      const ts = zonedInstant(d, mins, loc.timezone);
      const local = zonedParts(ts, loc.timezone);
      rows.push({
        user_id: data.user.id, type, ts, local_date: local.date, local_time: local.time, timezone: loc.timezone,
        location_id: loc.id, lat: loc.lat + rand(-0.0004, 0.0004), lng: loc.lng + rand(-0.0004, 0.0004),
        accuracy_m: rand(5, 30), distance_m: rand(5, 60), face_distance: rand(0.2, 0.42), status: 'valid',
        late: type === 'in' && inMin > startMin + 10,
      });
    }
  }
  await sql`insert into asiste.records ${sql(rows)}`;
  console.log(`Empleado demo: ${email} / demo1234 (${rows.length} registros)`);
}
await sql.end();
console.log('Datos de demostración listos.');
