import { api, clock, download, live, session } from './api.js';

const activeCompany = () => session.companyId || session.user.company_id;
import {
  $, $$, avatar, confirmDialog, esc, fmtDuration, fmtShortDate, formData, icon, localDate, mapLink, modal, toast, tzLabel,
} from './ui.js';

const SECTIONS = [
  ['dashboard', 'grid', 'Dashboard'],
  ['personal', 'users', 'Personal'],
  ['registros', 'list', 'Registros'],
  ['horas-extras', 'clock', 'Horas extras'],
  ['reportes', 'report', 'Reportes'],
  ['ubicaciones', 'pin', 'Ubicaciones'],
];
const DAYS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

function layout(root, active, title, actions = '') {
  const user = session.user;
  const sections = user.role === 'superadmin' ? [...SECTIONS, ['empresas', 'building', 'Empresas']] : SECTIONS;
  root.innerHTML = `<div class="admin">
    <aside class="sidebar">
      <a class="side-brand" href="#/admin">${icon('clock')}<span>AsisteApp</span></a>
      ${user.role === 'superadmin'
        ? `<label class="company-switch">Empresa<select data-company><option>${esc(user.company_name ?? '')}</option></select></label>`
        : `<div class="company-name">${icon('building')}<span>${esc(user.company_name ?? '')}</span></div>`}
      <nav>${sections.map(([key, ic, label]) => `<a href="#/admin/${key}" class="${key === active ? 'active' : ''}">${icon(ic)}<span>${label}</span></a>`).join('')}
        <a href="#/" class="side-back">${icon('home')}<span>Vista empleado</span></a>
      </nav>
    </aside>
    <div class="admin-main">
      <header class="admin-head">
        <h1>${esc(title)}</h1>
        <div class="admin-actions">${actions}
          <span class="live-badge"><i></i><span>En vivo</span></span>
          <span class="admin-user">${esc(user.name)} ${avatar(user.name, 'avatar-sm')}</span>
        </div>
      </header>
      <div class="admin-body"></div>
    </div>
  </div>`;
  if (user.role === 'superadmin') fillCompanySwitch($('[data-company]', root));
  return $('.admin-body', root);
}

/** Selector de empresa del superadministrador: cambia la empresa que se está administrando. */
async function fillCompanySwitch(select) {
  try {
    const { companies } = await api('/api/super/companies');
    const current = activeCompany();
    if (!companies.some((c) => c.id === current)) session.setCompany(null);
    select.innerHTML = companies.map((c) => `<option value="${c.id}" ${c.id === activeCompany() ? 'selected' : ''}>${esc(c.name)}${c.active ? '' : ' (inactiva)'}</option>`).join('');
    select.onchange = () => {
      const id = Number(select.value);
      session.setCompany(id === session.user.company_id ? null : id);
      toast(`Administrando: ${select.selectedOptions[0].textContent}`, 'success');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    };
  } catch (err) {
    toast(err.message, 'error');
  }
}

const typeBadge = (r) => `<span class="badge ${r.type === 'in' ? 'badge-in' : 'badge-out'}">${icon(r.type === 'in' ? 'login' : 'logout')}${r.type === 'in' ? 'Entrada' : 'Salida'}</span>`;
const statusBadge = (r) => r.status === 'valid'
  ? `<span class="badge badge-ok">${icon('check')}Válido${r.late ? ' · retardo' : ''}</span>`
  : `<span class="badge badge-bad" title="${esc(r.reason)}">${icon('x')}Rechazado</span>`;
const when = (r) => `${fmtShortDate(r.local_date)} ${r.local_time.slice(0, 5)} <small class="muted">${esc(tzLabel(r.timezone))}</small>`;

// ---------------- Dashboard en tiempo real ----------------

export function dashboardView(root) {
  const body = layout(root, 'dashboard', 'Dashboard');
  body.innerHTML = `<div class="kpis" data-kpis></div>
    <div class="grid-2">
      <section class="panel"><div class="panel-head"><h2>Últimos registros</h2><a href="#/admin/registros">Ver todos</a></div>
        <div class="table-wrap"><table class="table"><thead><tr><th>Usuario</th><th>Tipo</th><th>Fecha y hora</th><th>Ubicación</th><th>Estado</th></tr></thead>
        <tbody data-latest></tbody></table></div></section>
      <section class="panel"><div class="panel-head"><h2>Personal hoy</h2></div><ul class="people" data-people></ul></section>
    </div>`;

  let pending = null;
  async function load(highlightId) {
    try {
      const d = await api('/api/admin/dashboard');
      const t = d.totals;
      const pct = t.expected ? Math.round((t.present / t.expected) * 100) : 0;
      $('[data-kpis]', body).innerHTML = [
        ['users', 'blue', 'Personal activo', t.active],
        ['check', 'green', 'Presentes hoy', `${t.present} <small>(${pct}%)</small>`],
        ['x', 'red', 'Ausentes hoy', `${t.absent} <small>(${t.expected ? 100 - pct : 0}%)</small>`],
        ['clock', 'teal', 'En tiempo real', `${t.inside} <small>dentro</small>`],
        ['alert', 'amber', 'Retardos hoy', t.late],
      ].map(([ic, color, label, value]) => `<div class="kpi"><span class="kpi-icon ${color}">${icon(ic)}</span>
        <span class="kpi-label">${label}</span><b class="kpi-value">${value}</b></div>`).join('');

      $('[data-latest]', body).innerHTML = d.latest.length ? d.latest.map((r) => `<tr class="${r.id === highlightId ? 'flash' : ''}">
        <td>${esc(r.user_name)}</td><td>${typeBadge(r)}</td><td>${when(r)}</td>
        <td>${esc(r.location_name ?? '—')}</td><td>${statusBadge(r)}</td></tr>`).join('')
        : '<tr><td colspan="5" class="empty">Aún no hay registros</td></tr>';

      $('[data-people]', body).innerHTML = d.people.length ? d.people.map((p) => {
        const [cls, text] = p.inside ? ['ok', 'En oficina'] : p.present ? ['muted', 'Salió'] : p.workday ? ['bad', 'Sin registro'] : ['muted', 'Día no laboral'];
        return `<li>${avatar(p.name, 'avatar-sm')}<div><b>${esc(p.name)}</b><span class="muted">${esc(p.department)} · ${esc(tzLabel(p.timezone))}</span></div>
          <div class="people-times">${p.firstIn ? `<span class="${p.late ? 'late' : ''}">${p.firstIn}</span>` : ''}${p.lastOut ? ` – ${p.lastOut}` : ''}</div>
          <span class="pill pill-${cls}">${text}</span>${p.faceEnrolled ? '' : `<span class="pill pill-warn" title="Sin rostro registrado">${icon('face')}</span>`}</li>`;
      }).join('') : '<li class="empty">No hay empleados. <a href="#/admin/personal">Agrega personal</a></li>';
      return d.latest;
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  const off = live.on('record', (r) => {
    if (r.company_id !== activeCompany()) return;
    clearTimeout(pending);
    pending = setTimeout(async () => {
      const latest = await load(r.id);
      const name = latest?.find((x) => x.id === r.id)?.user_name ?? 'Empleado';
      toast(`${name}: ${r.type === 'in' ? 'entrada' : 'salida'} ${r.status === 'valid' ? 'registrada' : 'rechazada'}`, r.status === 'valid' ? 'success' : 'error');
    }, 300);
  });
  const refresh = setInterval(load, 60_000); // cambia el día local de cada zona horaria
  load();
  return () => { off(); clearInterval(refresh); clearTimeout(pending); };
}

// ---------------- Personal ----------------

export function staffView(root) {
  const body = layout(root, 'personal', 'Personal', `<button class="btn btn-primary" data-new>${icon('plus')}Nuevo</button>`);
  body.innerHTML = `<section class="panel"><div class="table-wrap"><table class="table">
    <thead><tr><th>Nombre</th><th>Departamento</th><th>Ubicación</th><th>Horario</th><th>Rostro</th><th>Estado</th><th></th></tr></thead>
    <tbody data-rows><tr><td colspan="7" class="empty">Cargando…</td></tr></tbody></table></div></section>`;

  let users = [];
  let locations = [];
  async function load() {
    [{ users }, { locations }] = await Promise.all([api('/api/admin/users'), api('/api/admin/locations')]);
    $('[data-rows]', body).innerHTML = users.map((u) => `<tr class="${u.active ? '' : 'inactive'}">
      <td><div class="cell-user">${avatar(u.name, 'avatar-sm')}<div><b>${esc(u.name)}</b><span class="muted">${esc(u.email)}${u.role === 'admin' ? ' · Admin' : u.role === 'superadmin' ? ' · Superadmin' : ''}</span></div></div></td>
      <td>${esc(u.department)}<br><small class="muted">${esc(u.position)}</small></td>
      <td>${esc(u.location_name ?? 'Cualquiera')}<br><small class="muted">${esc(tzLabel(u.timezone))}</small></td>
      <td>${u.schedule_start}–${u.schedule_end}<br><small class="muted">${u.work_days.split(',').map((d) => DAYS[d]).join(' ')}</small></td>
      <td>${u.face_enrolled ? `<span class="badge badge-ok">${icon('check')}Registrado</span>` : '<span class="badge badge-warn">Pendiente</span>'}</td>
      <td>${u.active ? 'Activo' : 'Inactivo'}</td>
      <td class="row-actions"><button class="icon-btn" data-edit="${u.id}" aria-label="Editar">${icon('edit')}</button>
        ${u.face_enrolled ? `<button class="icon-btn" data-reset="${u.id}" title="Restablecer rostro" aria-label="Restablecer rostro">${icon('refresh')}</button>` : ''}</td>
    </tr>`).join('');
  }

  body.addEventListener('click', async (e) => {
    const edit = e.target.closest('[data-edit]');
    const reset = e.target.closest('[data-reset]');
    if (edit) openForm(users.find((u) => u.id === edit.dataset.edit));
    if (reset && await confirmDialog('El empleado deberá registrar su rostro de nuevo. ¿Continuar?')) {
      await api(`/api/admin/users/${reset.dataset.reset}/reset-face`, { method: 'POST' });
      toast('Rostro restablecido', 'success');
      load();
    }
  });
  $('[data-new]', root).onclick = () => openForm(null);

  function openForm(u) {
    const v = u ?? { role: 'employee', schedule_start: '09:00', schedule_end: '18:00', tolerance_min: 10, work_days: '1,2,3,4,5', active: true, location_id: locations[0]?.id };
    const wd = new Set(v.work_days.split(','));
    const m = modal(u ? 'Editar empleado' : 'Nuevo empleado', `<form class="form form-grid">
      <label>Nombre completo<input name="name" required value="${esc(v.name)}"></label>
      <label>Correo<input name="email" type="email" required value="${esc(v.email)}"></label>
      <label>${u ? 'Nueva contraseña (opcional)' : 'Contraseña'}<input name="password" type="password" minlength="8" ${u ? '' : 'required'} autocomplete="new-password"></label>
      ${v.role === 'superadmin' ? '<label>Rol<input value="Superadministrador" disabled></label>'
        : `<label>Rol<select name="role"><option value="employee">Empleado</option><option value="admin" ${v.role === 'admin' ? 'selected' : ''}>Administrador</option></select></label>`}
      <label>Puesto<input name="position" value="${esc(v.position ?? 'Personal Administrativo')}"></label>
      <label>Departamento<input name="department" value="${esc(v.department ?? '')}" list="dept-list"></label>
      <label>Ubicación de trabajo<select name="location_id"><option value="">Cualquier ubicación activa</option>
        ${locations.map((l) => `<option value="${l.id}" ${l.id === v.location_id ? 'selected' : ''}>${esc(l.name)} (${esc(tzLabel(l.timezone))})</option>`).join('')}</select></label>
      <div class="inline-3">
        <label>Entrada<input name="schedule_start" type="time" required value="${v.schedule_start}"></label>
        <label>Salida<input name="schedule_end" type="time" required value="${v.schedule_end}"></label>
        <label>Tolerancia (min)<input name="tolerance_min" type="number" min="0" max="240" value="${v.tolerance_min}"></label>
      </div>
      <fieldset class="days" data-group="work_days"><legend>Días laborales</legend>
        ${[1, 2, 3, 4, 5, 6, 0].map((d) => `<label><input type="checkbox" value="${d}" ${wd.has(String(d)) ? 'checked' : ''}>${DAYS[d]}</label>`).join('')}</fieldset>
      <label class="check"><input type="checkbox" name="active" ${v.active ? 'checked' : ''}> Activo</label>
      <datalist id="dept-list">${[...new Set(users.map((x) => x.department))].map((d) => `<option value="${esc(d)}">`).join('')}</datalist>
      <p class="form-error"></p>
      <div class="form-actions"><button type="button" class="btn btn-ghost" data-close>Cancelar</button><button class="btn btn-primary" type="submit">Guardar</button></div>
    </form>`, { wide: true });
    $('form', m.el).onsubmit = async (e) => {
      e.preventDefault();
      const data = formData(e.target);
      data.tolerance_min = Number(data.tolerance_min);
      if (!data.password) delete data.password;
      try {
        await api(u ? `/api/admin/users/${u.id}` : '/api/admin/users', { method: u ? 'PUT' : 'POST', body: data });
        m.close();
        toast('Empleado guardado', 'success');
        load();
      } catch (err) {
        $('.form-error', m.el).textContent = err.message;
      }
    };
  }
  load().catch((err) => toast(err.message, 'error'));
}

// ---------------- Registros (auditoría) ----------------

export function recordsView(root) {
  const body = layout(root, 'registros', 'Registros', `<button class="btn btn-danger" data-delete>${icon('x')}Eliminar registros</button>`);
  const today = localDate(clock.now(), session.user.timezone);
  body.innerHTML = `<form class="filters panel">
      <label>Desde<input type="date" name="from" value="${today.slice(0, 8)}01"></label>
      <label>Hasta<input type="date" name="to" value="${today}"></label>
      <label>Empleado<select name="userId"><option value="">Todos</option></select></label>
      <label>Estado<select name="status"><option value="">Todos</option><option value="valid">Válidos</option><option value="rejected">Rechazados</option></select></label>
      <button class="btn btn-primary">Filtrar</button>
    </form>
    <section class="panel"><div class="table-wrap"><table class="table">
      <thead><tr><th>Foto</th><th>Usuario</th><th>Tipo</th><th>Fecha y hora local</th><th>Ubicación</th><th>Distancia / GPS</th><th>Rostro</th><th>Estado</th></tr></thead>
      <tbody data-rows></tbody></table></div></section>`;
  const form = $('form', body);
  api('/api/admin/users').then(({ users }) => {
    form.userId.insertAdjacentHTML('beforeend', users.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join(''));
  });

  async function load() {
    const q = new URLSearchParams(Object.entries(formData(form)).filter(([, v]) => v));
    try {
      const { records } = await api(`/api/admin/records?${q}`);
      $('[data-rows]', body).innerHTML = records.length ? records.map((r) => `<tr>
        <td>${r.has_snapshot ? `<button class="thumb" data-photo="${r.id}" aria-label="Ver foto">${icon('image')}</button>` : '—'}</td>
        <td>${esc(r.user_name)}</td><td>${typeBadge(r)}</td><td>${when(r)}</td>
        <td>${esc(r.location_name ?? '—')}</td>
        <td>${r.lat == null ? '—' : `<a href="${mapLink(r.lat, r.lng)}" target="_blank" rel="noopener">${Math.round(r.distance_m ?? 0)} m</a> <small class="muted">±${Math.round(r.accuracy_m ?? 0)} m</small>`}</td>
        <td>${r.face_distance == null ? '—' : r.face_distance.toFixed(2)}</td>
        <td>${statusBadge(r)}${r.reason ? `<br><small class="muted">${esc(r.reason)}</small>` : ''}</td></tr>`).join('')
        : '<tr><td colspan="8" class="empty">Sin registros en el rango</td></tr>';
    } catch (err) {
      toast(err.message, 'error');
    }
  }
  form.onsubmit = (e) => { e.preventDefault(); load(); };
  body.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-photo]');
    if (!b) return;
    try {
      const { url } = await api(`/api/admin/records/${b.dataset.photo}/snapshot`);
      modal('Foto del registro', `<img class="snapshot" src="${esc(url)}" alt="Foto tomada al registrar">`);
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  $('[data-delete]', root).onclick = () => {
    const m = modal('Eliminar registros', `<form class="form">
      <p>Se eliminarán <b>permanentemente</b> los registros de entrada y salida de <b>${esc($('[data-company]', root)?.selectedOptions[0]?.textContent ?? session.user.company_name ?? 'esta empresa')}</b>,
        con sus fotos y sus autorizaciones de horas extras. El personal, las ubicaciones y los rostros registrados no se borran.</p>
      <label class="check"><input type="checkbox" name="all" checked> Todos los registros</label>
      <div class="inline-3" data-range hidden>
        <label>Desde<input type="date" name="from" value="${today.slice(0, 8)}01"></label>
        <label>Hasta<input type="date" name="to" value="${today}"></label>
      </div>
      <label>Para confirmar escribe <b>ELIMINAR</b><input name="confirm" autocomplete="off" placeholder="ELIMINAR"></label>
      <p class="form-error"></p>
      <div class="form-actions"><button type="button" class="btn btn-ghost" data-close>Cancelar</button>
        <button class="btn btn-danger" type="submit">${icon('x')}Eliminar</button></div></form>`);
    const f = $('form', m.el);
    f.all.onchange = () => { $('[data-range]', f).hidden = f.all.checked; };
    f.onsubmit = async (e) => {
      e.preventDefault();
      if (f.confirm.value.trim() !== 'ELIMINAR') {
        $('.form-error', f).textContent = 'Escribe ELIMINAR en mayúsculas para confirmar.';
        return;
      }
      $('button[type=submit]', f).disabled = true;
      try {
        const { deleted } = await api('/api/admin/records/delete', {
          method: 'POST',
          body: { confirm: 'ELIMINAR', ...(!f.all.checked && { from: f.from.value, to: f.to.value }) },
        });
        m.close();
        toast(`${deleted} registro(s) eliminado(s)`, 'success');
        load();
      } catch (err) {
        $('.form-error', f).textContent = err.message;
        $('button[type=submit]', f).disabled = false;
      }
    };
  };
  const off = live.on('record', () => load());
  load();
  return off;
}

// ---------------- Empresas (superadministrador) ----------------

export function companiesView(root) {
  const body = layout(root, 'empresas', 'Empresas', `<button class="btn btn-primary" data-new>${icon('plus')}Nueva empresa</button>`);
  body.innerHTML = `<p class="muted small">Cada empresa tiene su propio personal, ubicaciones, registros y reportes, totalmente separados.
      Usa el selector <b>Empresa</b> del menú para administrar cualquiera de ellas.</p>
    <section class="panel"><div class="table-wrap"><table class="table">
      <thead><tr><th>Empresa</th><th class="num">Empleados</th><th class="num">Administradores</th><th class="num">Ubicaciones</th><th>Estado</th><th></th></tr></thead>
      <tbody data-rows><tr><td colspan="6" class="empty">Cargando…</td></tr></tbody></table></div></section>`;
  let companies = [];

  async function load() {
    try {
      ({ companies } = await api('/api/super/companies'));
      $('[data-rows]', body).innerHTML = companies.map((c) => `<tr class="${c.active ? '' : 'inactive'}">
        <td><b>${esc(c.name)}</b>${c.id === session.user.company_id ? ' <small class="muted">(tu empresa)</small>' : ''}</td>
        <td class="num">${c.employees}</td><td class="num">${c.admins}</td><td class="num">${c.locations}</td>
        <td>${c.active ? '<span class="badge badge-ok">Activa</span>' : '<span class="badge badge-bad">Inactiva</span>'}</td>
        <td class="row-actions">
          <button class="btn btn-ghost btn-sm" data-enter="${c.id}">Administrar</button>
          <button class="icon-btn" data-edit="${c.id}" aria-label="Editar">${icon('edit')}</button></td></tr>`).join('');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  body.addEventListener('click', (e) => {
    const enter = e.target.closest('[data-enter]');
    const edit = e.target.closest('[data-edit]');
    if (enter) {
      const id = Number(enter.dataset.enter);
      session.setCompany(id === session.user.company_id ? null : id);
      location.hash = '#/admin';
    }
    if (edit) openEdit(companies.find((c) => c.id === Number(edit.dataset.edit)));
  });

  $('[data-new]', root).onclick = () => {
    const m = modal('Nueva empresa', `<form class="form">
      <label>Nombre de la empresa<input name="name" required minlength="2"></label>
      <p class="muted small">Primer administrador de la empresa (podrá dar de alta a su personal y ubicaciones):</p>
      <label>Nombre completo<input name="admin_name" required></label>
      <label>Correo<input name="admin_email" type="email" required autocomplete="off"></label>
      <label>Contraseña inicial<input name="admin_password" type="password" minlength="8" required autocomplete="new-password"></label>
      <p class="form-error"></p>
      <div class="form-actions"><button type="button" class="btn btn-ghost" data-close>Cancelar</button><button class="btn btn-primary">Crear empresa</button></div>
    </form>`);
    $('form', m.el).onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('/api/super/companies', { method: 'POST', body: formData(e.target) });
        m.close();
        toast('Empresa creada', 'success');
        load();
        fillCompanySwitch($('[data-company]', root));
      } catch (err) {
        $('.form-error', m.el).textContent = err.message;
      }
    };
  };

  function openEdit(c) {
    const m = modal('Editar empresa', `<form class="form">
      <label>Nombre<input name="name" required minlength="2" value="${esc(c.name)}"></label>
      <label class="check"><input type="checkbox" name="active" ${c.active ? 'checked' : ''}> Activa (si la desactivas, su personal no podrá entrar)</label>
      <p class="form-error"></p>
      <div class="form-actions"><button type="button" class="btn btn-ghost" data-close>Cancelar</button><button class="btn btn-primary">Guardar</button></div>
    </form>`);
    $('form', m.el).onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api(`/api/super/companies/${c.id}`, { method: 'PUT', body: formData(e.target) });
        m.close();
        toast('Empresa actualizada', 'success');
        load();
        fillCompanySwitch($('[data-company]', root));
      } catch (err) {
        $('.form-error', m.el).textContent = err.message;
      }
    };
  }
  load();
}

// ---------------- Horas extras ----------------

const OVERTIME = {
  pending: ['badge-warn', 'alert', 'Pendiente'],
  approved: ['badge-ok', 'check', 'Autorizada'],
  rejected: ['badge-bad', 'x', 'Rechazada'],
};
export const overtimeBadge = (o) => {
  const [cls, ic, label] = OVERTIME[o.status];
  return `<span class="badge ${cls}">${icon(ic)}${label}</span>`;
};

export function overtimeView(root) {
  const body = layout(root, 'horas-extras', 'Horas extras');
  const today = localDate(clock.now(), session.user.timezone);
  body.innerHTML = `<form class="filters panel">
      <label>Desde<input type="date" name="from" value="${today.slice(0, 8)}01"></label>
      <label>Hasta<input type="date" name="to" value="${today}"></label>
      <label>Estado<select name="status">
        <option value="pending">Pendientes</option><option value="approved">Autorizadas</option>
        <option value="rejected">Rechazadas</option><option value="all">Todas</option></select></label>
      <label>Empleado<select name="userId"><option value="">Todos</option></select></label>
      <button class="btn btn-primary">Filtrar</button>
    </form>
    <p class="muted small">Se generan cuando el tiempo trabajado supera la jornada programada del empleado.
      Solo un administrador puede autorizarlas o rechazarlas, indicando el motivo en observaciones.</p>
    <section class="panel"><div class="table-wrap"><table class="table">
      <thead><tr><th>Fecha</th><th>Empleado</th><th>Entrada – Salida</th><th class="num">Trabajado</th><th class="num">Jornada</th>
        <th class="num">Horas extra</th><th>Estado</th><th>Observaciones</th><th></th></tr></thead>
      <tbody data-rows></tbody></table></div></section>`;
  const form = $('form', body);
  let items = [];
  api('/api/admin/users').then(({ users }) => {
    form.userId.insertAdjacentHTML('beforeend', users.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join(''));
  });

  async function load() {
    const q = new URLSearchParams(Object.entries(formData(form)).filter(([, v]) => v));
    try {
      ({ items } = await api(`/api/admin/overtime?${q}`));
      $('[data-rows]', body).innerHTML = items.length ? items.map((it, i) => `<tr>
        <td>${fmtShortDate(it.date)}</td>
        <td><b>${esc(it.name)}</b><br><small class="muted">${esc(it.department)}</small></td>
        <td>${it.inTime} – ${it.outTime}</td>
        <td class="num">${fmtDuration(it.minutes)}</td>
        <td class="num">${fmtDuration(it.scheduledMinutes)}</td>
        <td class="num"><b>${fmtDuration(it.overtimeMinutes)}</b>${it.overtime.status === 'approved' && it.overtime.approvedMinutes !== it.overtimeMinutes
          ? `<br><small class="ok">Autorizadas: ${fmtDuration(it.overtime.approvedMinutes)}</small>` : ''}</td>
        <td>${overtimeBadge(it.overtime)}</td>
        <td class="notes">${it.overtime.notes ? `${esc(it.overtime.notes)}<br><small class="muted">${esc(it.overtime.decidedBy)} · ${
          new Date(it.overtime.decidedAt).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' })}</small>` : '<span class="muted">—</span>'}</td>
        <td class="row-actions"><button class="btn btn-ghost btn-sm" data-review="${i}">${it.overtime.status === 'pending' ? 'Revisar' : 'Cambiar'}</button></td>
      </tr>`).join('') : '<tr><td colspan="9" class="empty">No hay horas extras con este filtro</td></tr>';
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function review(it) {
    const o = it.overtime;
    const m = modal('Revisar horas extras', `<form class="form">
      <dl class="info-list">
        <dt>Empleado</dt><dd>${esc(it.name)}</dd>
        <dt>Fecha</dt><dd>${fmtShortDate(it.date)} · ${it.inTime} – ${it.outTime}</dd>
        <dt>Trabajado</dt><dd>${fmtDuration(it.minutes)} (jornada de ${fmtDuration(it.scheduledMinutes)})</dd>
        <dt>Horas extra</dt><dd><b>${fmtDuration(it.overtimeMinutes)}</b></dd>
      </dl>
      <label>Minutos a autorizar<input type="number" name="approved_minutes" min="1" max="${it.overtimeMinutes}"
        value="${o.status === 'approved' ? o.approvedMinutes : it.overtimeMinutes}" required></label>
      <label>Observaciones (motivo) *<textarea name="notes" rows="3" minlength="5" maxlength="1000" required
        placeholder="Ej. Cierre de mes autorizado por la gerencia">${esc(o.notes ?? '')}</textarea></label>
      <p class="form-error"></p>
      <div class="form-actions">
        <button type="button" class="btn btn-danger" data-decide="rejected">${icon('x')}Rechazar</button>
        <button type="button" class="btn btn-primary" data-decide="approved">${icon('check')}Autorizar</button>
      </div></form>`);
    const f = $('form', m.el);
    f.notes.addEventListener('input', () => { $('.form-error', f).textContent = ''; });
    f.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-decide]');
      if (!b) return;
      const status = b.dataset.decide;
      const notes = f.notes.value.trim();
      if (notes.length < 5) {
        $('.form-error', f).textContent = 'Escribe en observaciones el motivo (mínimo 5 caracteres).';
        f.notes.focus();
        return;
      }
      $$('[data-decide]', f).forEach((x) => { x.disabled = true; });
      try {
        await api(`/api/admin/overtime/${it.inId}`, {
          method: 'POST',
          body: { status, notes, ...(status === 'approved' && { approved_minutes: Number(f.approved_minutes.value) }) },
        });
        m.close();
        toast(status === 'approved' ? 'Horas extras autorizadas' : 'Horas extras rechazadas', 'success');
        load();
      } catch (err) {
        $('.form-error', f).textContent = err.message;
        $$('[data-decide]', f).forEach((x) => { x.disabled = false; });
      }
    });
  }

  form.onsubmit = (e) => { e.preventDefault(); load(); };
  body.addEventListener('click', (e) => {
    const b = e.target.closest('[data-review]');
    if (b) review(items[Number(b.dataset.review)]);
  });
  const off = live.on('record', (r) => { if (r.type === 'out') load(); });
  load();
  return off;
}

// ---------------- Reportes ----------------

export function reportsView(root) {
  const body = layout(root, 'reportes', 'Reportes de asistencia');
  const today = localDate(clock.now(), session.user.timezone);
  body.innerHTML = `<form class="filters panel no-print">
      <label>Periodo<select name="period">
        <option value="daily">Diario</option><option value="weekly">Semanal</option>
        <option value="monthly" selected>Mensual</option><option value="custom">Personalizado</option></select></label>
      <label data-single>Fecha<input type="date" name="date" value="${today}"></label>
      <label data-custom hidden>Desde<input type="date" name="start" value="${today.slice(0, 8)}01"></label>
      <label data-custom hidden>Hasta<input type="date" name="end" value="${today}"></label>
      <label>Área / Departamento<select name="department"><option value="">Todos</option></select></label>
      <label>Empleado<select name="userId"><option value="">Todos</option></select></label>
      <button class="btn btn-primary">Generar reporte</button>
    </form>
    <div class="export no-print" hidden>
      <button class="btn btn-excel" data-csv="detail">${icon('download')}Excel (detalle)</button>
      <button class="btn btn-excel" data-csv="summary">${icon('download')}Excel (resumen)</button>
      <button class="btn btn-pdf" data-print>${icon('print')}PDF / Imprimir</button>
    </div>
    <div data-out></div>`;
  const form = $('form', body);
  let query = '';
  let report = null;

  form.period.onchange = () => {
    const custom = form.period.value === 'custom';
    $$('[data-custom]', form).forEach((x) => { x.hidden = !custom; });
    $('[data-single]', form).hidden = custom;
  };
  Promise.all([api('/api/admin/departments'), api('/api/admin/users')]).then(([{ departments }, { users }]) => {
    form.department.insertAdjacentHTML('beforeend', departments.map((d) => `<option>${esc(d)}</option>`).join(''));
    form.userId.insertAdjacentHTML('beforeend', users.filter((u) => u.role === 'employee')
      .map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join(''));
  });

  async function load() {
    const data = formData(form);
    if (data.period === 'custom') delete data.date; else { delete data.start; delete data.end; }
    query = new URLSearchParams(Object.entries(data).filter(([, v]) => v)).toString();
    try {
      report = await api(`/api/admin/reports?${query}`);
      render();
      $('.export', body).hidden = false;
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function render() {
    const { totals: t, range } = report;
    const periodName = { daily: 'Diario', weekly: 'Semanal', monthly: 'Mensual', custom: 'Personalizado' }[report.period];
    $('[data-out]', body).innerHTML = `
      <div class="print-only print-title"><h1>Reporte de asistencia</h1></div>
      <p class="report-range">${periodName}: <b>${fmtShortDate(range.start)}</b> al <b>${fmtShortDate(range.end)}</b></p>
      <div class="kpis">
        ${kpi('users', 'blue', 'Empleados', t.employees)}
        ${kpi('check', 'green', 'Asistencia', t.attendanceRate === null ? '—' : `${t.attendanceRate}%`)}
        ${kpi('clock', 'teal', 'Horas trabajadas', (t.totalMinutes / 60).toFixed(1))}
        ${kpi('alert', 'amber', 'Retardos', t.lateCount)}
        ${kpi('x', 'red', 'Faltas', t.absences)}
        ${kpi('clock', 'blue', 'Horas extra autorizadas', `${(t.approvedOvertimeMinutes / 60).toFixed(1)} <small>de ${(t.overtimeMinutes / 60).toFixed(1)}</small>`)}
      </div>
      ${t.pendingOvertime ? `<p class="banner banner-warning no-print">${icon('alert')}<span>${t.pendingOvertime} jornada(s) con horas extras pendientes de revisión.
        <a href="#/admin/horas-extras">Revisar</a></span></p>` : ''}
      ${report.series.length > 1 ? `<section class="panel"><div class="panel-head"><h2>Asistencias por día</h2></div>${barChart(report.series, t.employees)}</section>` : ''}
      <section class="panel"><div class="panel-head"><h2>Resumen por empleado</h2></div><div class="table-wrap"><table class="table">
        <thead><tr><th>Empleado</th><th>Departamento</th><th>Horario</th><th class="num">Días</th><th class="num">Faltas</th><th class="num">Retardos</th><th class="num">Sin salida</th><th class="num">Horas</th><th class="num">Entrada prom.</th><th class="num">H. extra</th><th class="num">Autorizadas</th></tr></thead>
        <tbody>${report.summary.map((s) => `<tr><td><b>${esc(s.name)}</b><br><small class="muted">${esc(tzLabel(s.timezone))}</small></td>
          <td>${esc(s.department)}</td><td>${s.schedule}</td><td class="num">${s.daysWorked}/${s.expectedDays}</td>
          <td class="num ${s.absences ? 'bad' : ''}" title="${s.absenceDates.map(fmtShortDate).join(', ')}">${s.absences}</td>
          <td class="num ${s.lateCount ? 'warn' : ''}">${s.lateCount}</td><td class="num">${s.incomplete}</td>
          <td class="num">${(s.totalMinutes / 60).toFixed(1)}</td><td class="num">${s.averageIn ?? '—'}</td>
          <td class="num">${(s.overtimeMinutes / 60).toFixed(1)}${s.pendingOvertime ? ` <small class="warn">(${s.pendingOvertime} pend.)</small>` : ''}</td>
          <td class="num">${(s.approvedOvertimeMinutes / 60).toFixed(1)}</td></tr>`).join('')
          || '<tr><td colspan="11" class="empty">Sin empleados</td></tr>'}</tbody></table></div></section>
      <section class="panel"><div class="panel-head"><h2>Detalle de entradas y salidas</h2></div><div class="table-wrap"><table class="table">
        <thead><tr><th>Fecha</th><th>Empleado</th><th>Entrada</th><th>Salida</th><th class="num">Tiempo</th><th>Horas extra</th><th>Ubicación</th></tr></thead>
        <tbody>${report.rows.map((r) => `<tr><td>${fmtShortDate(r.date)}</td><td>${esc(r.name)}</td>
          <td class="${r.late ? 'late' : ''}">${r.inTime}${r.late ? ' <small>(retardo)</small>' : ''}</td><td>${r.outTime ?? '<span class="muted">Sin salida</span>'}</td>
          <td class="num">${r.minutes == null ? '—' : fmtDuration(r.minutes)}</td>
          <td>${r.overtime ? `${fmtDuration(r.overtimeMinutes)} ${overtimeBadge(r.overtime)}${r.overtime.notes ? `<br><small class="muted">${esc(r.overtime.notes)}</small>` : ''}` : '<span class="muted">—</span>'}</td>
          <td>${esc(r.location ?? '—')} <small class="muted">${esc(tzLabel(r.timezone))}</small></td></tr>`).join('')
          || '<tr><td colspan="7" class="empty">Sin registros en el periodo</td></tr>'}</tbody></table></div></section>`;
  }

  form.onsubmit = (e) => { e.preventDefault(); load(); };
  body.addEventListener('click', (e) => {
    const csv = e.target.closest('[data-csv]');
    if (csv) {
      const { start, end } = report.range;
      download(`/api/admin/reports?${query}&format=csv&kind=${csv.dataset.csv}`,
        `asistencia_${csv.dataset.csv === 'summary' ? 'resumen' : 'detalle'}_${start}_${end}.csv`).catch((err) => toast(err.message, 'error'));
    }
    if (e.target.closest('[data-print]')) window.print();
  });
  load();
}

const kpi = (ic, color, label, value) => `<div class="kpi"><span class="kpi-icon ${color}">${icon(ic)}</span>
  <span class="kpi-label">${label}</span><b class="kpi-value">${value}</b></div>`;

/** Gráfica de barras de una sola serie (presentes por día) con tooltip por barra. */
function barChart(series, max) {
  const W = 720;
  const H = 200;
  const pad = { l: 32, r: 8, t: 10, b: 24 };
  const top = Math.max(max, ...series.map((s) => s.present), 1);
  const step = (W - pad.l - pad.r) / series.length;
  const bw = Math.max(Math.min(step - 2, 28), 2);
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / top);
  const ticks = [...new Set([0, Math.round(top / 2), top])];
  const every = Math.ceil(series.length / 12);
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Personas presentes por día">
    ${ticks.map((v) => `<line class="grid-line" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join('')}
    ${series.map((s, i) => {
      const x = pad.l + i * step + (step - bw) / 2;
      const h = Math.max(H - pad.b - y(s.present), 0);
      const r = Math.min(4, bw / 2, h);
      const yy = H - pad.b - h;
      const path = h > 0 ? `M${x},${H - pad.b}V${yy + r}Q${x},${yy} ${x + r},${yy}H${x + bw - r}Q${x + bw},${yy} ${x + bw},${yy + r}V${H - pad.b}Z` : '';
      return `<g class="bar"><title>${fmtShortDate(s.date)}: ${s.present} presente${s.present === 1 ? '' : 's'}</title>
        <rect class="hit" x="${pad.l + i * step}" y="${pad.t}" width="${step}" height="${H - pad.t - pad.b}"/>
        <path d="${path}"/>
        ${i % every === 0 ? `<text class="axis" x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${Number(s.date.slice(8))}</text>` : ''}</g>`;
    }).join('')}
  </svg></div>`;
}

// ---------------- Ubicaciones ----------------

export function locationsView(root) {
  const body = layout(root, 'ubicaciones', 'Ubicaciones', `<button class="btn btn-primary" data-new>${icon('plus')}Nueva</button>`);
  body.innerHTML = '<div class="loc-grid" data-list></div>';
  let locations = [];

  async function load() {
    ({ locations } = await api('/api/admin/locations'));
    $('[data-list]', body).innerHTML = locations.map((l) => `<article class="panel loc ${l.active ? '' : 'inactive'}">
      <div class="loc-head">${icon('building')}<div><h3>${esc(l.name)}</h3><p class="muted">${esc(l.address)}</p></div>
        <button class="icon-btn" data-edit="${l.id}" aria-label="Editar">${icon('edit')}</button></div>
      <dl class="info-list"><dt>Coordenadas</dt><dd><a href="${mapLink(l.lat, l.lng)}" target="_blank" rel="noopener">${l.lat.toFixed(5)}, ${l.lng.toFixed(5)}</a></dd>
        <dt>Radio permitido</dt><dd>${l.radius_m} m</dd><dt>Zona horaria</dt><dd>${esc(l.timezone)}</dd>
        <dt>Estado</dt><dd>${l.active ? 'Activa' : 'Inactiva'}</dd></dl></article>`).join('') || '<p class="empty">Sin ubicaciones</p>';
  }

  body.addEventListener('click', (e) => {
    const b = e.target.closest('[data-edit]');
    if (b) openForm(locations.find((l) => l.id === Number(b.dataset.edit)));
  });
  $('[data-new]', root).onclick = () => openForm(null);

  function openForm(l) {
    const v = l ?? { radius_m: 150, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, active: 1 };
    const zones = Intl.supportedValuesOf?.('timeZone') ?? [v.timezone];
    const m = modal(l ? 'Editar ubicación' : 'Nueva ubicación', `<form class="form form-grid">
      <label>Nombre<input name="name" required value="${esc(v.name)}"></label>
      <label>Dirección<input name="address" value="${esc(v.address)}"></label>
      <div class="inline-3">
        <label>Latitud<input name="lat" type="number" step="any" required value="${v.lat ?? ''}"></label>
        <label>Longitud<input name="lng" type="number" step="any" required value="${v.lng ?? ''}"></label>
        <label>Radio (m)<input name="radius_m" type="number" min="20" max="5000" required value="${v.radius_m}"></label>
      </div>
      <button type="button" class="btn btn-ghost" data-here>${icon('pin')}Usar mi ubicación actual</button>
      <label>Zona horaria<select name="timezone">${zones.map((z) => `<option ${z === v.timezone ? 'selected' : ''}>${z}</option>`).join('')}</select></label>
      <label class="check"><input type="checkbox" name="active" ${v.active ? 'checked' : ''}> Activa</label>
      <p class="form-error"></p>
      <div class="form-actions"><button type="button" class="btn btn-ghost" data-close>Cancelar</button><button class="btn btn-primary" type="submit">Guardar</button></div>
    </form>`, { wide: true });
    const form = $('form', m.el);
    $('[data-here]', form).onclick = () => navigator.geolocation?.getCurrentPosition(
      (p) => { form.lat.value = p.coords.latitude.toFixed(6); form.lng.value = p.coords.longitude.toFixed(6); },
      (err) => toast(err.message, 'error'), { enableHighAccuracy: true },
    );
    form.onsubmit = async (e) => {
      e.preventDefault();
      const data = formData(form);
      Object.assign(data, { lat: Number(data.lat), lng: Number(data.lng), radius_m: Number(data.radius_m) });
      try {
        await api(l ? `/api/admin/locations/${l.id}` : '/api/admin/locations', { method: l ? 'PUT' : 'POST', body: data });
        m.close();
        toast('Ubicación guardada', 'success');
        load();
      } catch (err) {
        $('.form-error', m.el).textContent = err.message;
      }
    };
  }
  load().catch((err) => toast(err.message, 'error'));
}
