// Notificaciones: campana dentro de la app (tabla asiste.notifications, en tiempo real) y Web Push al celular.
import { HttpError, recordView } from './attendance.js';

/**
 * Guarda una notificación para cada destinatario y la envía por push a sus dispositivos.
 * `push` (opcional) → { send(subscription, payload) } devuelve el código HTTP del servicio push.
 */
export async function notify(sql, push, userIds, { companyId = null, kind, title, body = '', link = null }) {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return;
  await sql`insert into asiste.notifications ${sql(ids.map((id) => ({
    user_id: id, company_id: companyId, kind, title, body, link,
  })))}`;
  if (!push) return;
  const subs = await sql`select * from asiste.push_subscriptions where user_id = any(${ids}::uuid[])`;
  const payload = JSON.stringify({ title, body, link, tag: kind });
  await Promise.allSettled(subs.map(async (s) => {
    const code = await push.send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
    // 404/410: el dispositivo canceló la suscripción.
    if (code === 404 || code === 410) await sql`delete from asiste.push_subscriptions where endpoint = ${s.endpoint}`;
  }));
}

/** Administradores activos de la empresa (incluido el superadministrador si pertenece a ella). */
export async function companyAdmins(sql, companyId) {
  const rows = await sql`select id from asiste.profiles where company_id = ${companyId} and active
    and role in ('admin', 'superadmin')`;
  return rows.map((r) => r.id);
}

export async function listNotifications(sql, userId) {
  const items = await sql`select id, kind, title, body, link, read_at, created_at from asiste.notifications
    where user_id = ${userId} order by created_at desc, id desc limit 40`;
  const [{ count }] = await sql`select count(*)::int as count from asiste.notifications where user_id = ${userId} and read_at is null`;
  return { items, unread: count };
}

export function savePushSubscription(sql, userId, body, userAgent) {
  const endpoint = String(body?.endpoint ?? '');
  const p256dh = String(body?.keys?.p256dh ?? '');
  const auth = String(body?.keys?.auth ?? '');
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000 || !p256dh || !auth || p256dh.length > 200 || auth.length > 100) {
    throw new HttpError(400, 'Suscripción push no válida');
  }
  return sql`insert into asiste.push_subscriptions (endpoint, user_id, p256dh, auth, user_agent)
    values (${endpoint}, ${userId}, ${p256dh}, ${auth}, ${String(userAgent).slice(0, 300)})
    on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
      user_agent = excluded.user_agent`;
}

// ---------------- Solicitudes de entrada tardía ----------------

const LATE_COLUMNS = (sql) => sql`q.id, q.user_id, q.record_id, q.local_date, q.minutes_late, q.status, q.notes, q.decided_at,
  q.created_at, p.name, p.department, p.schedule_start, p.sat_start, r.local_time, r.timezone, l.name as location_name,
  (r.snapshot_path is not null) as has_snapshot, coalesce(d.name, case when q.decided_by is null and q.decided_at is not null
    then 'Usuario eliminado' end) as decided_by_name`;

export function listLateRequests(sql, companyId, status) {
  return sql`select ${LATE_COLUMNS(sql)} from asiste.late_requests q
    join asiste.profiles p on p.id = q.user_id join asiste.records r on r.id = q.record_id
    left join asiste.locations l on l.id = r.location_id left join asiste.profiles d on d.id = q.decided_by
    where q.company_id = ${companyId} ${status === 'all' ? sql`` : sql`and q.status = ${status}`}
    order by q.created_at desc limit 200`;
}

/** Autoriza o rechaza una entrada tardía. Al autorizarla, el registro de entrada pasa a válido con su hora original. */
export async function decideLateRequest(sql, admin, companyId, id, body) {
  const status = body?.status;
  const notes = String(body?.notes ?? '').trim();
  if (status !== 'approved' && status !== 'rejected') throw new HttpError(400, 'Indica si se autoriza o se rechaza');
  if (status === 'rejected' && notes.length < 5) throw new HttpError(400, 'Escribe el motivo del rechazo (mínimo 5 caracteres)');
  if (notes.length > 1000) throw new HttpError(400, 'Las observaciones no pueden exceder 1000 caracteres');

  return sql.begin(async (tx) => {
    const [q] = await tx`select * from asiste.late_requests where id = ${id} and company_id = ${companyId} for update`;
    if (!q) throw new HttpError(404, 'Solicitud no encontrada');
    if (q.status !== 'pending') throw new HttpError(409, 'La solicitud ya fue resuelta');
    if (status === 'approved') {
      // Si mientras tanto el empleado ya tiene una entrada válida posterior, no se puede abrir otra jornada.
      const [later] = await tx`select 1 from asiste.records where user_id = ${q.user_id} and status = 'valid'
        and ts > (select ts from asiste.records where id = ${q.record_id}) limit 1`;
      if (later) throw new HttpError(409, 'El empleado ya tiene registros posteriores; no se puede autorizar esta entrada');
    }
    await tx`update asiste.late_requests set status = ${status}, notes = ${notes || null}, decided_by = ${admin.id},
      decided_at = now() where id = ${id}`;
    await tx`update asiste.records set status = ${status === 'approved' ? 'valid' : 'rejected'},
      reason = ${status === 'approved' ? `Entrada tardía autorizada por ${admin.name}${notes ? `: ${notes}` : ''}`
        : `Entrada tardía no autorizada: ${notes}`}
      where id = ${q.record_id}`;
    return { ...q, status, notes: notes || null, record: await recordView(tx, q.record_id) };
  });
}
