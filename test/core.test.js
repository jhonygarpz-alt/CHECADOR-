import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, periodRange, zonedParts } from '../supabase/functions/_shared/time.js';
import { distanceMeters } from '../supabase/functions/_shared/geo.js';
import { averageDescriptor, euclideanDistance, isValidDescriptor } from '../supabase/functions/_shared/face.js';
import { pairShifts } from '../supabase/functions/_shared/shifts.js';
import { overtimeMinutes, scheduledMinutes } from '../supabase/functions/_shared/overtime.js';

test('zonedParts usa la zona horaria real de cada ubicación', () => {
  const instant = new Date('2025-03-24T14:42:00Z');
  assert.equal(zonedParts(instant, 'America/Mexico_City').time, '08:42:00'); // UTC-6, sin horario de verano
  assert.equal(zonedParts(instant, 'America/Tijuana').time, '07:42:00'); // UTC-7 por horario de verano
  assert.equal(zonedParts(instant, 'Europe/Madrid').time, '15:42:00');
  // Cerca de medianoche UTC la fecha local cambia según la zona
  const late = new Date('2025-03-25T03:30:00Z');
  assert.equal(zonedParts(late, 'America/Mexico_City').date, '2025-03-24');
  assert.equal(zonedParts(late, 'Asia/Tokyo').date, '2025-03-25');
  assert.equal(zonedParts(instant, 'America/Mexico_City').weekday, 1); // lunes
});

test('periodRange calcula días, semanas (lunes-domingo) y meses', () => {
  assert.deepEqual(periodRange('daily', '2025-03-24'), { start: '2025-03-24', end: '2025-03-24' });
  assert.deepEqual(periodRange('weekly', '2025-03-27'), { start: '2025-03-24', end: '2025-03-30' });
  assert.deepEqual(periodRange('weekly', '2025-03-30'), { start: '2025-03-24', end: '2025-03-30' });
  assert.deepEqual(periodRange('monthly', '2024-02-10'), { start: '2024-02-01', end: '2024-02-29' });
  assert.equal(addDays('2025-12-31', 1), '2026-01-01');
});

test('distanceMeters (Haversine)', () => {
  assert.equal(Math.round(distanceMeters(19.4326, -99.1332, 19.4326, -99.1332)), 0);
  const d = distanceMeters(19.4326, -99.1332, 19.4336, -99.1332); // ~0.001° de latitud
  assert.ok(d > 105 && d < 117, `distancia ${d}`);
});

test('descriptores faciales', () => {
  const a = new Array(128).fill(0.1);
  const b = new Array(128).fill(0.1).map((x, i) => (i === 0 ? 0.4 : x));
  assert.ok(isValidDescriptor(a));
  assert.ok(!isValidDescriptor(a.slice(1)));
  assert.ok(!isValidDescriptor([...a.slice(1), NaN]));
  assert.ok(Math.abs(euclideanDistance(a, b) - 0.3) < 1e-9);
  assert.ok(Math.abs(averageDescriptor([a, b])[0] - 0.25) < 1e-9);
});

test('pairShifts empareja entradas y salidas, incluidas jornadas nocturnas', () => {
  const r = (user_id, type, ts, local_date, local_time) => ({ user_id, type, ts, local_date, local_time, timezone: 'UTC', late: 0 });
  const shifts = pairShifts([
    r(1, 'in', '2025-03-24T22:00:00Z', '2025-03-24', '22:00:00'),
    r(1, 'out', '2025-03-25T06:00:00Z', '2025-03-25', '06:00:00'),
    r(1, 'in', '2025-03-26T08:00:00Z', '2025-03-26', '08:00:00'),
    r(2, 'in', '2025-03-26T09:00:00Z', '2025-03-26', '09:00:00'),
    r(2, 'out', '2025-03-26T17:30:00Z', '2025-03-26', '17:30:00'),
  ]);
  assert.equal(shifts.length, 3);
  assert.deepEqual([shifts[0].date, shifts[0].minutes], ['2025-03-24', 480]);
  assert.equal(shifts[1].outTs, null); // entrada sin salida
  assert.deepEqual([shifts[2].userId, shifts[2].minutes], [2, 510]);
});

test('horas extras: tiempo trabajado por encima de la jornada programada', () => {
  const config = { minOvertime: 15 };
  const office = { schedule_start: '09:00', schedule_end: '18:00' };
  const night = { schedule_start: '22:00', schedule_end: '06:00' };
  assert.equal(scheduledMinutes(office), 540);
  assert.equal(scheduledMinutes(night), 480);
  assert.equal(overtimeMinutes({ minutes: 540 + 95 }, office, config), 95);
  assert.equal(overtimeMinutes({ minutes: 540 + 10 }, office, config), 0, 'menos del mínimo no cuenta');
  assert.equal(overtimeMinutes({ minutes: 500 }, office, config), 0);
  assert.equal(overtimeMinutes({ minutes: null }, office, config), 0, 'jornada sin salida');
});
