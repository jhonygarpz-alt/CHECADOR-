import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SESSION_HOURS = Number(process.env.SESSION_HOURS || 12);

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(password, salt, expected.length);
  return timingSafeEqual(expected, actual);
}

export function createSession(db, userId) {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_HOURS * 3600_000).toISOString();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expires);
  return { token, expiresAt: expires };
}

export function userFromToken(db, token) {
  if (!token) return null;
  return db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ? AND u.active = 1`).get(token, new Date().toISOString()) ?? null;
}

/** Middleware: exige sesión válida (cabecera Bearer o ?token= para EventSource). */
export function requireAuth(db) {
  return (req, res, next) => {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.token;
    const user = userFromToken(db, token);
    if (!user) return res.status(401).json({ error: 'Sesión no válida o expirada' });
    req.user = user;
    req.token = token;
    next();
  };
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Solo administradores' });
  next();
}

/** Limitador sencillo de intentos de inicio de sesión por IP + correo. */
export function loginLimiter({ max = 8, windowMs = 15 * 60_000 } = {}) {
  const hits = new Map();
  return {
    blocked(key) {
      const h = hits.get(key);
      if (!h || h.resetAt < Date.now()) return false;
      return h.count >= max;
    },
    fail(key) {
      const h = hits.get(key);
      if (!h || h.resetAt < Date.now()) hits.set(key, { count: 1, resetAt: Date.now() + windowMs });
      else h.count++;
    },
    reset(key) { hits.delete(key); },
  };
}
