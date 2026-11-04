// Campana de notificaciones: lista en tiempo real (Supabase Realtime) y activación de avisos push del celular.
import { api, disablePush, enablePush, live, pushSubscription, pushSupported } from './api.js';
import { $, esc, icon, toast } from './ui.js';

const state = { items: [], unread: 0, loaded: false, loading: null };
const bells = new Set();

async function load() {
  state.loading ??= api('/api/me/notifications').then((r) => {
    Object.assign(state, r, { loaded: true });
    renderAll();
  }).catch(() => {}).finally(() => { state.loading = null; });
  return state.loading;
}

function renderAll() {
  for (const b of bells) b.render();
}

const ago = (iso) => {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (min < 1) return 'Ahora';
  if (min < 60) return `Hace ${min} min`;
  if (min < 1440) return `Hace ${Math.round(min / 60)} h`;
  return new Date(iso).toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });
};

live.on('notification', (n) => {
  state.items = [n, ...state.items.filter((x) => x.id !== n.id)].slice(0, 40);
  state.unread += 1;
  renderAll();
  toast(n.title, 'info');
});

// Las notificaciones push abren la app en la sección indicada.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'navigate') location.href = e.data.url;
  });
}

/** Mantiene ligada la suscripción push del dispositivo al usuario que inició sesión. */
export async function refreshPush() {
  try {
    if (!pushSupported() || Notification.permission !== 'granted') return;
    const sub = await pushSubscription();
    if (sub) await api('/api/me/push', { method: 'POST', body: sub.toJSON() });
    else await enablePush();
  } catch { /* sin push: queda la campana */ }
}

export function resetNotifications() {
  Object.assign(state, { items: [], unread: 0, loaded: false });
}

/** Inserta la campana dentro de `host`. Las campanas de pantallas anteriores se retiran solas. */
export function mountBell(host) {
  for (const b of bells) if (!b.el.isConnected) b.destroy();
  host.insertAdjacentHTML('beforeend', `<div class="bell">
    <button class="icon-btn bell-btn" aria-label="Notificaciones" aria-haspopup="true">${icon('bell')}<b class="bell-count" hidden></b></button>
    <div class="bell-panel" hidden>
      <div class="bell-head"><b>Notificaciones</b><button class="link-btn" data-read-all>Marcar como leídas</button></div>
      <div class="bell-push"></div>
      <ul class="bell-list"></ul>
    </div></div>`);
  const el = host.lastElementChild;
  const panel = $('.bell-panel', el);
  const close = (e) => { if (!el.contains(e.target)) panel.hidden = true; };

  const bell = {
    el,
    destroy() {
      bells.delete(bell);
      document.removeEventListener('click', close);
    },
    render() {
      const count = $('.bell-count', el);
      count.hidden = state.unread === 0;
      count.textContent = state.unread > 99 ? '99+' : String(state.unread);
      $('.bell-list', el).innerHTML = state.items.length ? state.items.map((n) => `<li class="${n.read_at ? '' : 'unread'}">
          <a href="${esc(n.link || '#/')}" data-id="${n.id}"><b>${esc(n.title)}</b><span>${esc(n.body)}</span>
          <small class="muted">${ago(n.created_at)}</small></a></li>`).join('')
        : `<li class="empty">${state.loaded ? 'No tienes notificaciones' : 'Cargando…'}</li>`;
    },
    async renderPush() {
      const box = $('.bell-push', el);
      if (!pushSupported()) { box.innerHTML = ''; return; }
      const sub = await pushSubscription().catch(() => null);
      const on = sub && Notification.permission === 'granted';
      box.innerHTML = on
        ? `<span class="ok">${icon('check')} Avisos en este celular activados</span><button class="link-btn" data-push="off">Desactivar</button>`
        : `<span>${icon('bell')} Recibe avisos en este celular aunque la app esté cerrada</span><button class="btn btn-primary btn-sm" data-push="on">Activar</button>`;
    },
  };
  bells.add(bell);
  bell.render();
  load();

  document.addEventListener('click', close);

  $('.bell-btn', el).onclick = () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) { load(); bell.renderPush(); }
  };
  el.addEventListener('click', async (e) => {
    const push = e.target.closest('[data-push]');
    if (push) {
      push.disabled = true;
      try {
        if (push.dataset.push === 'on') { await enablePush(); toast('Notificaciones activadas en este celular', 'success'); }
        else { await disablePush(); toast('Notificaciones desactivadas en este celular'); }
      } catch (err) {
        toast(err.message, 'error');
      }
      bell.renderPush();
      return;
    }
    if (e.target.closest('[data-read-all]')) {
      await api('/api/me/notifications/read', { method: 'POST', body: {} }).catch(() => {});
      state.items = state.items.map((n) => ({ ...n, read_at: n.read_at ?? new Date().toISOString() }));
      state.unread = 0;
      renderAll();
      return;
    }
    const a = e.target.closest('a[data-id]');
    if (a) {
      panel.hidden = true;
      const n = state.items.find((x) => x.id === Number(a.dataset.id));
      if (n && !n.read_at) {
        n.read_at = new Date().toISOString();
        state.unread = Math.max(0, state.unread - 1);
        renderAll();
        api('/api/me/notifications/read', { method: 'POST', body: { ids: [n.id] } }).catch(() => {});
      }
    }
  });
}
