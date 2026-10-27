import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { hashPassword } from './auth.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS locations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  address     TEXT    NOT NULL DEFAULT '',
  lat         REAL    NOT NULL,
  lng         REAL    NOT NULL,
  radius_m    INTEGER NOT NULL DEFAULT 150,
  timezone    TEXT    NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS users (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT    NOT NULL,
  email            TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash    TEXT    NOT NULL,
  role             TEXT    NOT NULL DEFAULT 'employee' CHECK (role IN ('admin','employee')),
  position         TEXT    NOT NULL DEFAULT 'Personal Administrativo',
  department       TEXT    NOT NULL DEFAULT 'General',
  location_id      INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  schedule_start   TEXT    NOT NULL DEFAULT '09:00',
  schedule_end     TEXT    NOT NULL DEFAULT '18:00',
  tolerance_min    INTEGER NOT NULL DEFAULT 10,
  work_days        TEXT    NOT NULL DEFAULT '1,2,3,4,5',
  face_descriptor  TEXT,
  face_enrolled_at TEXT,
  active           INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS records (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type           TEXT    NOT NULL CHECK (type IN ('in','out')),
  ts             TEXT    NOT NULL,              -- instante UTC (ISO 8601), tomado del reloj del servidor
  local_date     TEXT    NOT NULL,              -- fecha en la zona horaria de la ubicación
  local_time     TEXT    NOT NULL,              -- hora local HH:MM:SS
  timezone       TEXT    NOT NULL,
  location_id    INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  lat            REAL,
  lng            REAL,
  accuracy_m     REAL,
  distance_m     REAL,
  face_distance  REAL,
  status         TEXT    NOT NULL CHECK (status IN ('valid','rejected')),
  reason         TEXT,
  late           INTEGER NOT NULL DEFAULT 0,
  snapshot       TEXT,
  user_agent     TEXT
);

CREATE INDEX IF NOT EXISTS idx_records_user_ts ON records(user_id, ts);
CREATE INDEX IF NOT EXISTS idx_records_date    ON records(local_date);
`;

export function openDb(file = process.env.DB_FILE || 'data/asisteapp.db') {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  seedDefaults(db);
  return db;
}

/** Crea la ubicación y el administrador iniciales si la base está vacía. */
function seedDefaults(db) {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get();
  if (n > 0) return;

  const loc = db.prepare(`INSERT INTO locations (name, address, lat, lng, radius_m, timezone)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    'Oficina Central', 'Av. Insurgentes 123, CDMX', 19.4326, -99.1332, 150,
    process.env.DEFAULT_TZ || 'America/Mexico_City',
  );

  const email = process.env.ADMIN_EMAIL || 'admin@empresa.com';
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  db.prepare(`INSERT INTO users (name, email, password_hash, role, position, department, location_id)
    VALUES (?, ?, ?, 'admin', 'Administrador', 'Recursos Humanos', ?)`)
    .run('Administrador', email, hashPassword(password), loc.lastInsertRowid);

  if (!process.env.ADMIN_PASSWORD && process.env.NODE_ENV !== 'test') {
    console.warn(`[AsisteApp] Administrador inicial creado: ${email} / ${password} — cambia la contraseña.`);
  }
}
