import { api, clock, live, session } from './api.js';
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

async function render() {
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
  document.body.classList.toggle('is-admin-view', path.startsWith('admin'));
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
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* sesión ya inválida */ }
  live.stop();
  session.clear();
  location.hash = '#/';
  render();
}

live.on('status', (on) => document.body.classList.toggle('live-on', on));
live.on('user', async () => {
  const { user } = await api('/api/me');
  session.user = user;
});

window.addEventListener('hashchange', render);

(async () => {
  if (session.token) {
    try {
      const { user } = await api('/api/me');
      session.user = user;
      live.start();
      await clock.sync();
    } catch {
      session.clear();
    }
  }
  render();
})();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
