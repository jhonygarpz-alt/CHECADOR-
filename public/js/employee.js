import { api, changePassword, clock, live, session, signIn } from './api.js';
import { averageDescriptor, captureSamples, getPosition, loadFaceApi, snapshot, startCamera, stopCamera } from './face.js';
import {
  $, avatar, esc, fmtDay, fmtDayMonth, fmtDuration, fmtLongDate, fmtMonth, fmtTime, formData, icon,
  localDate, mapEmbed, modal, toast, tzLabel,
} from './ui.js';

// ---------------- Pantallas públicas ----------------

export function landingView(root) {
  root.innerHTML = `<main class="landing">
    <div class="landing-brand">
      <div class="brand-mark">${icon('clock')}<span>${icon('users')}</span></div>
      <h1>AsisteApp</h1>
      <p>Control de asistencia<br>para personal administrativo</p>
    </div>
    <a class="btn btn-white btn-block" href="#/login">Iniciar sesión</a>
    <ul class="landing-features">
      <li>${icon('face')}<span>Reconocimiento facial</span></li>
      <li>${icon('pin')}<span>Ubicación GPS</span></li>
      <li>${icon('report')}<span>Reportes</span></li>
    </ul>
  </main>`;
}

export function loginView(root, { onLogin }) {
  root.innerHTML = `<main class="phone phone-plain">
    <form class="login" novalidate>
      <a class="back-link" href="#/">${icon('chevronL')} Inicio</a>
      <h1>Bienvenido</h1>
      <p class="muted center">Ingresa tus credenciales</p>
      <label>Correo institucional<input name="email" type="email" autocomplete="username" required placeholder="nombre@empresa.com"></label>
      <label>Contraseña
        <span class="input-icon"><input name="password" type="password" autocomplete="current-password" required placeholder="••••••••">
        <button type="button" class="icon-btn" data-toggle aria-label="Mostrar contraseña">${icon('face')}</button></span>
      </label>
      <p class="form-error" role="alert"></p>
      <button class="btn btn-primary btn-block" type="submit">Iniciar sesión</button>
      <p class="muted center small">¿Olvidaste tu contraseña? Solicita el restablecimiento a Recursos Humanos.</p>
    </form>
  </main>`;
  const form = $('form', root);
  $('[data-toggle]', root).onclick = () => {
    const input = form.password;
    input.type = input.type === 'password' ? 'text' : 'password';
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('button[type=submit]', form);
    btn.disabled = true;
    $('.form-error', form).textContent = '';
    try {
      const { email, password } = formData(form);
      onLogin(await signIn(email.trim(), password));
    } catch (err) {
      $('.form-error', form).textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  };
}

// ---------------- Estructura con navegación inferior ----------------

function shell(root, active, content) {
  const user = session.user;
  const tabs = [
    ['#/', 'home', 'Inicio'],
    ['#/historial', 'history', 'Historial'],
    ...(user.role === 'admin' ? [['#/admin', 'grid', 'Panel']] : []),
    ['#/perfil', 'user', 'Perfil'],
  ];
  root.innerHTML = `<div class="phone">
    <div class="phone-content">${content}</div>
    <nav class="tabbar">${tabs.map(([href, ic, label]) =>
      `<a href="${href}" class="${href === active ? 'active' : ''}">${icon(ic)}<span>${label}</span></a>`).join('')}
    </nav></div>`;
  return $('.phone-content', root);
}

// ---------------- Pantalla principal ----------------

export function homeView(root) {
  const user = session.user;
  const tz = user.timezone;
  const el = shell(root, '#/', `
    <header class="greeting">
      ${avatar(user.name)}
      <div><h1>Hola, ${esc(user.name.split(' ')[0])}</h1><p>${esc(user.position)}</p></div>
      <span class="live-dot" title="Conexión en tiempo real"></span>
    </header>
    ${user.face_enrolled ? '' : `<a class="banner banner-warning" href="#/enrolar">${icon('face')}
      <span><b>Registra tu rostro</b><br>Es necesario antes de tu primer registro.</span>${icon('chevronR')}</a>`}
    <section class="card clock-card">
      <p class="muted" data-date></p>
      <div class="big-clock" data-clock>--:--</div>
      <p class="clock-status" data-sched></p>
      <p class="tz-label">${icon('globe')} ${esc(tzLabel(tz))} · ${esc(user.location_name ?? 'Cualquier ubicación activa')}</p>
      <div class="check-buttons">
        <button class="check-btn check-in" data-type="in" disabled>${icon('login')}<span>Registrar<br>Entrada</span></button>
        <button class="check-btn check-out" data-type="out" disabled>${icon('logout')}<span>Registrar<br>Salida</span></button>
      </div>
    </section>
    <section class="card">
      <h2 class="card-title">Tu jornada de hoy</h2>
      <div class="day-stats">
        <div><span>Entrada</span><b data-in>--:--</b></div>
        <div><span>Salida</span><b data-out>--:--</b></div>
        <div><span>Tiempo en oficina</span><b data-worked>--:--</b></div>
      </div>
    </section>`);

  let status = null;
  const tick = () => {
    const now = clock.now();
    $('[data-clock]', el).textContent = fmtTime(now, tz);
    $('[data-date]', el).textContent = fmtLongDate(now, tz);
    if (status?.open) $('[data-worked]', el).textContent = fmtDuration((now - new Date(status.open.ts)) / 60000);
    renderSchedule(now);
  };

  function renderSchedule(now) {
    const [h, m] = fmtTime(now, tz).split(':').map(Number);
    const mins = h * 60 + m;
    const toMin = (s) => s.split(':').reduce((a, b, i) => (i ? a + Number(b) : Number(b) * 60), 0);
    const start = toMin(user.schedule_start);
    const end = toMin(user.schedule_end);
    const sched = $('[data-sched]', el);
    let text = `Horario ${user.schedule_start} – ${user.schedule_end}`;
    let cls = 'muted';
    if (status?.open) { text = 'Jornada en curso'; cls = 'ok'; }
    else if (status?.shift?.outTime) { text = 'Jornada concluida'; cls = 'muted'; }
    else if (mins <= start + user.tolerance_min && mins >= start - 120) { text = 'Dentro del horario'; cls = 'ok'; }
    else if (mins > start + user.tolerance_min && mins < end) { text = 'Fuera de tolerancia: se marcará retardo'; cls = 'warn'; }
    sched.textContent = text;
    sched.className = `clock-status ${cls}`;
  }

  async function load() {
    try {
      status = await api('/api/me/status');
      const s = status.shift;
      $('[data-in]', el).textContent = s?.inTime ?? '--:--';
      $('[data-out]', el).textContent = s?.outTime ?? '--:--';
      if (s?.minutes != null) $('[data-worked]', el).textContent = fmtDuration(s.minutes);
      $('[data-in]', el).classList.toggle('late', !!s?.late);
      $('[data-type=in]', el).disabled = !!status.open || !user.face_enrolled;
      $('[data-type=out]', el).disabled = !status.open || !user.face_enrolled;
      tick();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  el.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-type]');
    if (btn && !btn.disabled) location.hash = `#/registrar/${btn.dataset.type}`;
  });

  const timer = setInterval(tick, 1000);
  const off = live.on('record', (r) => { if (r.user_id === user.id) load(); });
  tick();
  load();
  return () => { clearInterval(timer); off(); };
}

// ---------------- Registro de entrada / salida ----------------

export function checkView(root, { type }) {
  const user = session.user;
  const label = type === 'in' ? 'Entrada' : 'Salida';
  root.innerHTML = `<main class="camera-screen">
    <button class="icon-btn camera-close" aria-label="Cancelar">${icon('x')}</button>
    <div class="camera-title">Reconocimiento facial (${label})</div>
    <div class="camera-wrap">
      <video playsinline muted></video>
      <div class="face-frame"><i></i><i></i><i></i><i></i></div>
    </div>
    <div class="camera-hint" data-hint>Preparando cámara…</div>
    <div class="camera-steps">
      <span data-step="face">${icon('face')} Rostro</span>
      <span data-step="gps">${icon('pin')} Ubicación</span>
    </div>
    <button class="shutter" aria-label="Capturar" disabled></button>
  </main>`;

  const video = $('video', root);
  const hint = (t) => { $('[data-hint]', root).textContent = t; };
  const step = (name, state) => { $(`[data-step=${name}]`, root).className = state; };
  let stream = null;
  let cancelled = false;
  let gps;
  const locate = () => {
    step('gps', 'busy');
    gps = getPosition();
    gps.then(() => step('gps', 'done'), () => step('gps', 'fail'));
  };
  locate();

  $('.camera-close', root).onclick = () => { location.hash = '#/'; };

  (async () => {
    try {
      const [faceapi, s] = await Promise.all([loadFaceApi(), startCamera(video)]);
      stream = s;
      if (cancelled) return stopCamera(stream);
      hint('Coloca tu rostro en el recuadro');
      const shutter = $('.shutter', root);
      shutter.disabled = false;
      shutter.onclick = async () => {
        shutter.disabled = true;
        step('face', 'busy');
        try {
          const samples = await captureSamples(faceapi, video, { count: 3, onProgress: (_, msg) => hint(msg) });
          const photo = snapshot(video);
          step('face', 'done');
          hint('Verificando ubicación…');
          const pos = await gps;
          hint('Validando registro…');
          const result = await api('/api/attendance', {
            method: 'POST',
            body: { type, ...pos, descriptor: averageDescriptor(samples), snapshot: photo },
          });
          stopCamera(stream);
          showResult(root, { type, ok: true, ...result });
        } catch (err) {
          step('face', '');
          if (err.body?.checks) {
            stopCamera(stream);
            showResult(root, { type, ok: false, error: err.message, checks: err.body.checks, record: err.body.record });
          } else {
            hint(err.message);
            toast(err.message, 'error');
            if ($('[data-step=gps]', root).className === 'fail') locate();
            shutter.disabled = false;
          }
        }
      };
    } catch (err) {
      hint(err.name === 'NotAllowedError' ? 'Permiso de cámara denegado. Habilítalo para continuar.' : err.message);
    }
  })();

  return () => { cancelled = true; stopCamera(stream); };

  function showResult(rootEl, r) {
    const tz = r.record?.timezone ?? user.timezone;
    const when = r.record ? new Date(r.record.ts) : clock.now();
    const loc = r.checks.location;
    const row = (ok, ic, title, detail) => `<li>${icon(ic)}<div><b>${title}</b><span class="${ok ? 'ok' : 'bad'}">${detail}</span></div>
      <span class="state ${ok ? 'ok' : 'bad'}">${icon(ok ? 'check' : 'x')}</span></li>`;
    rootEl.innerHTML = `<main class="phone phone-plain result">
      <div class="result-icon ${r.ok ? 'ok' : 'bad'}">${icon(r.ok ? 'check' : 'x')}</div>
      <h1>${r.ok ? `¡${label} registrada!` : 'Registro rechazado'}</h1>
      <div class="result-time">${fmtTime(when, tz)}</div>
      <p class="muted center">${fmtLongDate(when, tz)} · ${esc(tzLabel(tz))}</p>
      ${r.ok ? '' : `<p class="form-error center">${esc(r.error)}</p>`}
      <div class="card map-card">
        ${mapEmbed(loc.lat, loc.lng)}
        <div class="map-label">${icon('pin')}<div><b>${esc(loc.name)}</b><span>${esc(loc.address)}</span></div></div>
      </div>
      <ul class="check-list card">
        ${row(r.checks.face.ok, 'face', 'Reconocimiento facial', r.checks.face.ok ? 'Verificado' : 'No coincide')}
        ${row(loc.ok, 'pin', 'Ubicación', loc.ok ? 'Dentro del área permitida' : `A ${loc.distance} m (máx. ${loc.radius} m)`)}
        ${r.checks.accuracy.ok ? '' : row(false, 'alert', 'Precisión GPS', `±${r.checks.accuracy.value} m (máx. ${r.checks.accuracy.max} m)`)}
        ${r.workedMinutes != null ? row(true, 'clock', 'Tiempo total', fmtDuration(r.workedMinutes)) : ''}
        ${r.ok && r.record.late ? row(false, 'alert', 'Puntualidad', 'Entrada con retardo') : ''}
      </ul>
      <div class="result-actions">
        ${r.ok ? '' : `<a class="btn btn-ghost btn-block" href="#/registrar/${r.type}?retry=${Date.now()}">Reintentar</a>`}
        <a class="btn btn-primary btn-block" href="#/">Continuar</a>
      </div>
    </main>`;
  }
}

// ---------------- Enrolamiento facial ----------------

export function enrollView(root, { onDone }) {
  root.innerHTML = `<main class="camera-screen">
    <a class="icon-btn camera-close" href="#/perfil" aria-label="Cancelar">${icon('x')}</a>
    <div class="camera-title">Registro de rostro</div>
    <div class="camera-wrap">
      <video playsinline muted></video>
      <div class="face-frame"><i></i><i></i><i></i><i></i></div>
    </div>
    <div class="camera-hint" data-hint>Preparando cámara…</div>
    <div class="progress"><div data-bar></div></div>
    <p class="camera-note">Usa buena iluminación, sin lentes oscuros ni cubrebocas. Se tomarán 5 capturas.</p>
    <button class="shutter" aria-label="Comenzar" disabled></button>
  </main>`;
  const video = $('video', root);
  const hint = (t) => { $('[data-hint]', root).textContent = t; };
  let stream = null;
  let cancelled = false;

  (async () => {
    try {
      const [faceapi, s] = await Promise.all([loadFaceApi(), startCamera(video)]);
      stream = s;
      if (cancelled) return stopCamera(stream);
      hint('Coloca tu rostro en el recuadro y presiona el botón');
      const shutter = $('.shutter', root);
      shutter.disabled = false;
      shutter.onclick = async () => {
        shutter.disabled = true;
        try {
          const samples = await captureSamples(faceapi, video, {
            count: 5,
            timeoutMs: 25000,
            onProgress: (n, msg) => { hint(msg); $('[data-bar]', root).style.width = `${n * 20}%`; },
          });
          const { user } = await api('/api/me/face', { method: 'POST', body: { descriptors: samples } });
          session.user = user;
          stopCamera(stream);
          toast('Rostro registrado correctamente', 'success');
          onDone();
        } catch (err) {
          hint(err.message);
          shutter.disabled = false;
        }
      };
    } catch (err) {
      hint(err.name === 'NotAllowedError' ? 'Permiso de cámara denegado. Habilítalo para continuar.' : err.message);
    }
  })();
  return () => { cancelled = true; stopCamera(stream); };
}

// ---------------- Historial ----------------

export function historyView(root) {
  const user = session.user;
  let month = localDate(clock.now(), user.timezone).slice(0, 7);
  const el = shell(root, '#/historial', `
    <header class="page-head">${icon('calendar')}<h1>Mis registros</h1></header>
    <div class="month-nav card">
      <button class="icon-btn" data-prev aria-label="Mes anterior">${icon('chevronL')}</button>
      <b data-month></b>
      <button class="icon-btn" data-next aria-label="Mes siguiente">${icon('chevronR')}</button>
    </div>
    <div class="mini-stats" data-stats></div>
    <ul class="history card" data-list><li class="empty">Cargando…</li></ul>`);

  const shift = (delta) => {
    const [y, m] = month.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    month = d.toISOString().slice(0, 7);
    load();
  };
  $('[data-prev]', el).onclick = () => shift(-1);
  $('[data-next]', el).onclick = () => shift(1);

  async function load() {
    $('[data-month]', el).textContent = fmtMonth(month);
    $('[data-next]', el).disabled = month >= localDate(clock.now(), user.timezone).slice(0, 7);
    try {
      const { shifts } = await api(`/api/me/records?month=${month}`);
      const total = shifts.reduce((a, s) => a + (s.minutes ?? 0), 0);
      $('[data-stats]', el).innerHTML = `
        <div><b>${new Set(shifts.map((s) => s.date)).size}</b><span>Días</span></div>
        <div><b>${(total / 60).toFixed(1)}</b><span>Horas</span></div>
        <div><b>${shifts.filter((s) => s.late).length}</b><span>Retardos</span></div>`;
      $('[data-list]', el).innerHTML = shifts.length ? shifts.map((s) => `<li>
        <div class="h-date"><b>${fmtDay(s.date)}</b><span>${fmtDayMonth(s.date)}</span></div>
        <div class="h-col"><span class="in">Entrada</span><b class="${s.late ? 'late' : ''}">${s.inTime}</b></div>
        <div class="h-col"><span>Salida</span><b>${s.outTime ?? '--:--'}</b></div>
        <div class="h-total ${s.minutes == null ? 'open' : ''}"><i></i>${s.minutes == null ? 'Sin salida' : fmtDuration(s.minutes)}</div>
      </li>`).join('') : '<li class="empty">Sin registros este mes</li>';
    } catch (err) {
      toast(err.message, 'error');
    }
  }
  load();
}

// ---------------- Perfil ----------------

const DAYS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

export function profileView(root, { onLogout }) {
  const user = session.user;
  const el = shell(root, '#/perfil', `
    <div class="profile-head">
      ${avatar(user.name, 'avatar-xl')}
      <h1>${esc(user.name)}</h1>
      <p>${esc(user.position)}</p>
      <p class="muted">${esc(user.email)}</p>
    </div>
    <ul class="menu card">
      <li><button data-act="info">${icon('user')}<span>Datos personales</span>${icon('chevronR')}</button></li>
      <li><button data-act="face">${icon('face')}<span>Reconocimiento facial
        <small class="${user.face_enrolled ? 'ok' : 'bad'}">${user.face_enrolled ? 'Registrado' : 'Pendiente'}</small></span>${icon('chevronR')}</button></li>
      <li><button data-act="password">${icon('lock')}<span>Cambiar contraseña</span>${icon('chevronR')}</button></li>
      ${user.role === 'admin' ? `<li><a href="#/admin">${icon('grid')}<span>Panel de administración</span>${icon('chevronR')}</a></li>` : ''}
      <li><button data-act="logout">${icon('logout')}<span>Cerrar sesión</span>${icon('chevronR')}</button></li>
    </ul>`);

  el.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'logout') onLogout();
    if (act === 'face') {
      if (!user.face_enrolled) location.hash = '#/enrolar';
      else toast('Tu rostro ya está registrado. Para cambiarlo, solicítalo a un administrador.');
    }
    if (act === 'info') {
      modal('Datos personales', `<dl class="info-list">
        <dt>Departamento</dt><dd>${esc(user.department)}</dd>
        <dt>Puesto</dt><dd>${esc(user.position)}</dd>
        <dt>Horario</dt><dd>${esc(user.schedule_start)} – ${esc(user.schedule_end)} (tolerancia ${user.tolerance_min} min)</dd>
        <dt>Días laborales</dt><dd>${user.work_days.split(',').map((d) => DAYS[d]).join(', ')}</dd>
        <dt>Ubicación</dt><dd>${esc(user.location_name ?? 'Cualquier ubicación activa')}</dd>
        <dt>Zona horaria</dt><dd>${esc(user.timezone)}</dd>
      </dl>`);
    }
    if (act === 'password') {
      const m = modal('Cambiar contraseña', `<form class="form">
        <label>Contraseña actual<input type="password" name="current" required autocomplete="current-password"></label>
        <label>Nueva contraseña<input type="password" name="next" required minlength="8" autocomplete="new-password"></label>
        <p class="form-error"></p>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Guardar</button></div></form>`);
      $('form', m.el).onsubmit = async (ev) => {
        ev.preventDefault();
        try {
          const { current, next } = formData(ev.target);
          await changePassword(current, next);
          m.close();
          toast('Contraseña actualizada', 'success');
        } catch (err) {
          $('.form-error', m.el).textContent = err.message;
        }
      };
    }
  });
}
