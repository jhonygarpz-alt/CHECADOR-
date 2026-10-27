const TOKEN_KEY = 'asisteapp.token';

function storage(fn) {
  try { return fn(localStorage); } catch { return null; }
}

export const session = {
  token: storage((s) => s.getItem(TOKEN_KEY)),
  user: null,
  set(token, user) {
    this.token = token;
    this.user = user;
    storage((s) => s.setItem(TOKEN_KEY, token));
  },
  clear() {
    this.token = null;
    this.user = null;
    storage((s) => s.removeItem(TOKEN_KEY));
  },
};

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `Error ${status}`);
    this.status = status;
    this.body = body;
  }
}

export async function api(path, { method = 'GET', body, raw = false } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
      ...(session.token && { Authorization: `Bearer ${session.token}` }),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && session.token && path !== '/api/auth/login') {
    session.clear();
    location.hash = '#/login';
  }
  if (raw && res.ok) return res;
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

/** Descarga un archivo protegido (CSV, foto) usando la sesión actual. */
export async function download(path, filename) {
  const res = await api(path, { raw: true });
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export async function blobUrl(path) {
  const res = await api(path, { raw: true });
  return URL.createObjectURL(await res.blob());
}

/**
 * Reloj sincronizado con el servidor: la hora mostrada no depende del reloj del dispositivo,
 * que puede estar mal configurado o manipulado.
 */
export const clock = {
  offset: 0,
  now() { return new Date(Date.now() + this.offset); },
  async sync() {
    try {
      const t0 = Date.now();
      const { now } = await api('/api/time');
      const t1 = Date.now();
      this.offset = Date.parse(now) - (t0 + t1) / 2;
    } catch { /* se usa el reloj local */ }
  },
};

/** Canal de eventos en tiempo real (SSE) compartido por toda la app. */
export const live = {
  source: null,
  listeners: new Map(),
  connected: false,
  start() {
    if (this.source || !session.token) return;
    const es = new EventSource(`/api/stream?token=${encodeURIComponent(session.token)}`);
    this.source = es;
    es.onopen = () => this.setConnected(true);
    es.onerror = () => this.setConnected(false);
    for (const type of ['record', 'user', 'tick', 'hello']) {
      es.addEventListener(type, (e) => {
        const data = JSON.parse(e.data);
        if (data.now) clock.offset = Date.parse(data.now) - Date.now();
        this.emit(type, data);
      });
    }
  },
  stop() {
    this.source?.close();
    this.source = null;
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
