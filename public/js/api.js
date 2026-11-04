import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/+esm';

const cfg = window.ASISTE_CONFIG ?? {};
export const configured = Boolean(cfg.supabaseUrl && cfg.supabaseKey);

export const supabase = configured
  ? createClient(cfg.supabaseUrl, cfg.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true } })
  : null;

const API_BASE = configured ? `${cfg.supabaseUrl.replace(/\/$/, '')}/functions/v1/api` : '';

const COMPANY_KEY = 'asisteapp.company';
const storage = (fn) => { try { return fn(localStorage); } catch { return null; } };

export const isAdmin = (user) => user?.role === 'admin' || user?.role === 'superadmin';

export const session = {
  user: null,
  /** Empresa que está administrando el superadministrador (null = la suya). */
  companyId: Number(storage((s) => s.getItem(COMPANY_KEY))) || null,
  setCompany(id) {
    this.companyId = id || null;
    storage((s) => (id ? s.setItem(COMPANY_KEY, String(id)) : s.removeItem(COMPANY_KEY)));
  },
  async token() {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  },
  async hasSession() {
    return Boolean(await this.token());
  },
};

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `Error ${status}`);
    this.status = status;
    this.body = body;
  }
}

/** Llama a la Edge Function `api`. Las rutas se escriben como '/api/...'. */
export async function api(path, { method = 'GET', body, raw = false } = {}) {
  const token = await session.token();
  const res = await fetch(API_BASE + path.replace(/^\/api/, ''), {
    method,
    headers: {
      apikey: cfg.supabaseKey,
      ...(session.user?.role === 'superadmin' && session.companyId && { 'X-Company-Id': String(session.companyId) }),
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && token) {
    await signOut();
    location.hash = '#/login';
  }
  if (raw && res.ok) return res;
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

// ---------- Autenticación (Supabase Auth) ----------

export async function signIn(email, password) {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    throw new Error(/invalid login/i.test(error.message) ? 'Correo o contraseña incorrectos' : error.message);
  }
  try {
    const { user } = await api('/api/me');
    session.user = user;
    return user;
  } catch (err) {
    await supabase.auth.signOut();
    throw err;
  }
}

export async function signOut() {
  const signedIn = session.user;
  session.user = null;
  // El celular deja de recibir avisos de esta cuenta (otra persona podría iniciar sesión en él).
  if (signedIn) await disablePush().catch(() => {});
  live.stop();
  session.setCompany(null);
  await supabase.auth.signOut().catch(() => {});
}

export async function changePassword(current, next) {
  if (typeof next !== 'string' || next.length < 8) throw new Error('La nueva contraseña debe tener al menos 8 caracteres');
  const { error: authError } = await supabase.auth.signInWithPassword({ email: session.user.email, password: current });
  if (authError) throw new Error('La contraseña actual no es correcta');
  const { error } = await supabase.auth.updateUser({ password: next });
  if (error) throw new Error(error.message);
}

/** Descarga un archivo protegido (CSV) usando la sesión actual. */
export async function download(path, filename) {
  const res = await api(path, { raw: true });
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/**
 * Reloj sincronizado con el servidor: la hora mostrada no depende del reloj del dispositivo,
 * que puede estar mal configurado o manipulado.
 */
export const clock = {
  offset: 0,
  timer: null,
  now() { return new Date(Date.now() + this.offset); },
  async sync() {
    try {
      const t0 = Date.now();
      const { now } = await api('/api/time');
      const t1 = Date.now();
      this.offset = Date.parse(now) - (t0 + t1) / 2;
    } catch { /* se usa el reloj local */ }
    this.timer ??= setInterval(() => this.sync(), 5 * 60_000);
  },
};

/**
 * Registros en tiempo real (Supabase Realtime). La seguridad por fila (RLS) hace que los
 * administradores reciban todos los registros y cada empleado solo los suyos.
 */
export const live = {
  channel: null,
  listeners: new Map(),
  connected: false,
  async start() {
    if (this.channel || !configured) return;
    await supabase.realtime.setAuth();
    this.channel = supabase.channel('asiste-records')
      .on('postgres_changes', { event: 'INSERT', schema: 'asiste', table: 'records' }, (p) => this.emit('record', p.new))
      .on('postgres_changes', { event: 'INSERT', schema: 'asiste', table: 'notifications' }, (p) => this.emit('notification', p.new))
      .subscribe((status) => this.setConnected(status === 'SUBSCRIBED'));
  },
  stop() {
    if (this.channel) supabase.removeChannel(this.channel);
    this.channel = null;
    this.setConnected(false);
  },
  setConnected(v) {
    this.connected = v;
    this.emit('status', v);
  },
  on(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
    return () => this.listeners.get(type).delete(fn);
  },
  emit(type, data) {
    for (const fn of this.listeners.get(type) ?? []) fn(data);
  },
};

// ---------- Notificaciones push (Web Push) ----------

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

const b64ToBytes = (s) => Uint8Array.from(atob((s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')),
  (c) => c.charCodeAt(0));

export async function pushSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

/** Pide permiso de notificaciones y registra este dispositivo para recibir avisos push. */
export async function enablePush() {
  if (!pushSupported()) throw new Error('Este navegador no admite notificaciones push');
  const { publicKey } = await api('/api/push/key');
  if (!publicKey) throw new Error('Las notificaciones push no están configuradas en el servidor');
  if (await Notification.requestPermission() !== 'granted') {
    throw new Error('Permiso de notificaciones denegado. Actívalo en los ajustes del celular para esta app.');
  }
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
  await api('/api/me/push', { method: 'POST', body: sub.toJSON() });
  return sub;
}

export async function disablePush() {
  const sub = await pushSubscription();
  if (!sub) return;
  await api('/api/me/push/remove', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
  await sub.unsubscribe();
}

if (configured) {
  // Mantiene el token de Realtime al día cuando Supabase renueva la sesión.
  supabase.auth.onAuthStateChange((event, s) => {
    if (event === 'TOKEN_REFRESHED' && s) supabase.realtime.setAuth(s.access_token);
  });
}
