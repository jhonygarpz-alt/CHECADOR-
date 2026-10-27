// Genera empleados y ~6 semanas de registros de ejemplo para probar el panel y los reportes.
// Uso: npm run seed:demo   (contraseña de todos los empleados demo: demo1234)
import { openDb } from '../server/db.js';
import { hashPassword } from '../server/auth.js';
import { addDays, weekdayOf, zonedParts } from '../server/time.js';

const db = openDb();
const office = db.prepare('SELECT * FROM locations ORDER BY id LIMIT 1').get();
let north = db.prepare("SELECT * FROM locations WHERE name = 'Sucursal Tijuana'").get();
if (!north) {
  const r = db.prepare(`INSERT INTO locations (name, address, lat, lng, radius_m, timezone)
    VALUES ('Sucursal Tijuana', 'Blvd. Agua Caliente 456, Tijuana', 32.5149, -117.0382, 200, 'America/Tijuana')`).run();
  north = db.prepare('SELECT * FROM locations WHERE id = ?').get(r.lastInsertRowid);
}

const people = [
  ['Ana García', 'Finanzas', office, '09:00'],
  ['Luis Ramírez', 'Recursos Humanos', office, '09:00'],
  ['María López', 'Contabilidad', office, '08:30'],
  ['Carlos Díaz', 'Compras', office, '09:00'],
  ['Sofía Hernández', 'Finanzas', north, '08:00'],
  ['Jorge Martínez', 'Ventas', north, '08:00'],
];

const hash = hashPassword('demo1234');
const insertRecord = db.prepare(`INSERT INTO records (user_id, type, ts, local_date, local_time, timezone, location_id,
  lat, lng, accuracy_m, distance_m, face_distance, status, late) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'valid', ?)`);

// Convierte una fecha + minutos locales en un instante UTC dentro de la zona horaria indicada.
function zonedInstant(date, minutes, tz) {
  const guess = new Date(`${date}T00:00:00Z`).getTime() + minutes * 60_000;
  const p = zonedParts(new Date(guess), tz);
  const offset = (new Date(`${p.date}T${p.time}Z`).getTime() - guess);
  return new Date(guess - offset);
}

const rand = (a, b) => a + Math.random() * (b - a);
const now = new Date();

for (const [name, department, loc, start] of people) {
  const email = `${name.split(' ')[0].normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()}@empresa.com`;
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) continue;
  const [h, m] = start.split(':').map(Number);
  const startMin = h * 60 + m;
  const created = addDays(zonedParts(now, loc.timezone).date, -45);
  const u = db.prepare(`INSERT INTO users (name, email, password_hash, department, location_id, schedule_start, schedule_end, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(name, email, hash, department, loc.id, start,
    `${String(h + 9).padStart(2, '0')}:${String(m).padStart(2, '0')}`, `${created}T06:00:00.000Z`);

  const today = zonedParts(now, loc.timezone).date;
  for (let d = created; d < today; d = addDays(d, 1)) {
    const wd = weekdayOf(d);
    if (wd === 0 || wd === 6 || Math.random() < 0.06) continue; // fines de semana y alguna falta
    const inMin = startMin + Math.round(rand(-15, Math.random() < 0.15 ? 35 : 9));
    const outMin = inMin + Math.round(rand(8.5 * 60, 9.4 * 60));
    for (const [type, mins] of [['in', inMin], ['out', outMin]]) {
      const ts = zonedInstant(d, mins, loc.timezone);
      const local = zonedParts(ts, loc.timezone);
      insertRecord.run(u.lastInsertRowid, type, ts.toISOString(), local.date, local.time, loc.timezone, loc.id,
        loc.lat + rand(-0.0004, 0.0004), loc.lng + rand(-0.0004, 0.0004), rand(5, 30), rand(5, 60), rand(0.2, 0.42),
        type === 'in' && inMin > startMin + 10 ? 1 : 0);
    }
  }
  console.log(`Empleado demo: ${email} / demo1234`);
}
console.log('Datos de demostración listos.');
