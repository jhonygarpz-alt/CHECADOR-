import { test } from 'node:test';
import assert from 'node:assert/strict';
import { incidenciasData, isoWeek, payrollWeek } from '../public/js/incidencias.js';

test('semana de nómina de jueves a miércoles y número de semana del archivo', () => {
  assert.deepEqual(payrollWeek('2026-10-24'), { start: '2026-10-22', end: '2026-10-28' });
  assert.deepEqual(payrollWeek('2026-10-22'), { start: '2026-10-22', end: '2026-10-28' });
  assert.deepEqual(payrollWeek('2026-10-28'), { start: '2026-10-22', end: '2026-10-28' });
  assert.equal(isoWeek('2026-10-28'), 44); // INCIDENCIAS_DE_NOMINA_SEM_44
});

test('incidencias: A, F, D, R, horas adicionales y observaciones', () => {
  const report = {
    range: { start: '2026-10-22', end: '2026-10-28' },
    summary: [{ userId: 'u1', name: 'Ana García', absenceDates: ['2026-10-23'], approvedOvertimeMinutes: 90 }],
    rows: [
      { userId: 'u1', date: '2026-10-22', outTs: 'x', overtimeMinutes: 90,
        overtime: { status: 'approved', approvedMinutes: 90, notes: 'Cierre de mes' } },
      { userId: 'u1', date: '2026-10-26', outTs: null, overtimeMinutes: 0, overtime: null },
      { userId: 'u1', date: '2026-10-27', outTs: 'x', overtimeMinutes: 60,
        overtime: { status: 'rejected', approvedMinutes: 0, notes: 'Sin permiso' } },
    ],
  };
  const users = [{ id: 'u1', position: 'Analista', work_days: '1,2,3,4,5', active: true }];
  const [p] = incidenciasData(report, users, '2026-10-27');
  assert.equal(p.name, 'ANA GARCÍA');
  assert.equal(p.position, 'ANALISTA');
  assert.deepEqual(p.days.map((d) => d.code), ['A', 'F', 'D', 'D', 'R', 'A', '']); // 28 aún no llega
  assert.deepEqual(p.days.map((d) => d.hours), [1.5, null, null, null, null, null, null]);
  assert.equal(p.attendances, 3);
  assert.equal(p.absences, 1);
  assert.equal(p.reviews, 1);
  assert.equal(p.extraHours, 1.5);
  assert.match(p.notes, /22-10 1.5 HRS AUTORIZADAS: CIERRE DE MES/);
  assert.match(p.notes, /27-10 NO PAGAR 1 HRS: SIN PERMISO/);
});
