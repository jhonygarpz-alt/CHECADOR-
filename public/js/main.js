import { api, clock, configured, live, session, signOut } from './api.js';
import { checkView, enrollView, historyView, homeView, landingView, loginView, profileView } from './employee.js';
import { dashboardView, locationsView, recordsView, reportsView, staffView } from './admin.js';

const app = document.getElementById('app');
let cleanup = null;

const routes = {
  '': homeView,
  historial: historyView,
  perfil: (root) => profileView(root, { onLogout: logout }),
  enrolar: (root) => enrollView(root, { onDone: () => { location.hash = '#/'; } }),
  'registrar/in': (root) => checkView(root, { type: 'in' }),
  'registrar/out': (root) => checkView(root, { type: 'out' }),
  admin: dashboardView,
  'admin/dashboard': dashboardView,
  'admin/personal': staffView,
  'admin/registros': recordsView,
  'admin/reportes': reportsView,
  'admin/ubicaciones': locationsView,
};

function render() {
  cleanup?.();
  cleanup = null;
  const path = location.hash.replace(/^#\/?/, '').split('?')[0].replace(/\/$/, '');

  if (!session.user) {
    if (path === 'login') return loginView(app, { onLogin: start });
    return landingView(app);
  }
  if (path === 'login') { location.hash = '#/'; return; }
  if (path.startsWith('admin') && session.user.role !== 'admin') { location.hash = '#/'; return; }
  const view = routes[path] ?? homeView;
  window.scrollTo(0, 0);
  cleanup = view(app) ?? null;
}

async function start(user) {
  session.user = user;
  live.start();
  await clock.sync();
  if (location.hash === '#/login' || !location.hash) location.hash = user.role === 'admin' ? '#/admin' : '#/';
  else render();
}

async function logout() {
  await signOut();
  location.hash = '#/';
  render();
}

live.on('status', (on) => document.body.classList.toggle('live-on', on));

window.addEventListener('hashchange', render);

(async () => {
  if (!configured) {
    app.innerHTML = `<main class="phone phone-plain"><h1>Configuración pendiente</h1>
      <p class="muted">Define la URL y la llave pública de Supabase en <code>config.js</code>.</p></main>`;
    return;
  }
  if (await session.hasSession()) {
    try {
      const { user } = await api('/api/me');
      session.user = user;
      live.start();
      await clock.sync();
    } catch {
      await signOut();
    }
  }
  render();
})();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
