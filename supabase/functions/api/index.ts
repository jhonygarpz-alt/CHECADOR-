// Edge Function `api` de AsisteApp (Supabase / Deno).
import postgres from 'postgres';
import { createClient } from '@supabase/supabase-js';
import webpush from 'web-push';
import { createHandler } from '../_shared/handler.js';
import { HttpError, loadConfig } from '../_shared/attendance.js';

const BUCKET = 'asiste-snapshots';

const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { prepare: false, max: 3 });
const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Web Push (notificaciones al celular). Las llaves VAPID vienen de los secrets VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY o,
// si no existen, el servidor las genera una sola vez y las guarda en asiste.app_settings (nunca salen del servidor).
async function loadVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const publicKey = Deno.env.get('VAPID_PUBLIC_KEY');
  const privateKey = Deno.env.get('VAPID_PRIVATE_KEY');
  if (publicKey && privateKey) return { publicKey, privateKey };
  const read = async () => (await sql`select value from asiste.app_settings where key = 'vapid'`)[0]?.value;
  let stored = await read();
  if (!stored) {
    await sql`insert into asiste.app_settings (key, value) values ('vapid', ${JSON.stringify(webpush.generateVAPIDKeys())})
      on conflict (key) do nothing`;
    stored = await read(); // si otra instancia se adelantó, se usan sus llaves
  }
  return JSON.parse(stored);
}

let push: { publicKey: string; send(s: webpush.PushSubscription, p: string): Promise<number> } | null = null;
try {
  const vapid = await loadVapidKeys();
  webpush.setVapidDetails(Deno.env.get('VAPID_SUBJECT') || 'mailto:soporte@asisteapp.mx', vapid.publicKey, vapid.privateKey);
  push = {
    publicKey: vapid.publicKey,
    async send(subscription: webpush.PushSubscription, payload: string) {
      try {
        const res = await webpush.sendNotification(subscription, payload, { TTL: 6 * 3600, urgency: 'high' });
        return res.statusCode;
      } catch (err) {
        if (!(err instanceof webpush.WebPushError)) console.error('push', err);
        return (err as { statusCode?: number }).statusCode ?? 0;
      }
    },
  };
} catch (err) {
  console.error('Notificaciones push desactivadas', err); // queda la campana dentro de la app
}

const handler = createHandler({
  sql,
  push,
  config: loadConfig(Deno.env.toObject()),
  auth: {
    async getUser(token: string) {
      const { data, error } = await admin.auth.getUser(token);
      return error || !data.user ? null : { id: data.user.id, email: data.user.email };
    },
    async createUser({ email, password }: { email: string; password: string }) {
      const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (error) throw new HttpError(error.status === 422 ? 409 : 400, translate(error.message));
      return { id: data.user.id };
    },
    async updateUser(id: string, changes: { email?: string; password?: string; banned?: boolean }) {
      const attrs: Record<string, unknown> = {};
      if (changes.email) Object.assign(attrs, { email: changes.email, email_confirm: true });
      if (changes.password) attrs.password = changes.password;
      if (changes.banned !== undefined) attrs.ban_duration = changes.banned ? '876000h' : 'none';
      if (Object.keys(attrs).length === 0) return;
      const { error } = await admin.auth.admin.updateUserById(id, attrs);
      if (error) throw new HttpError(400, translate(error.message));
    },
    async deleteUser(id: string) {
      const { error } = await admin.auth.admin.deleteUser(id);
      if (error && error.status !== 404) throw new HttpError(400, translate(error.message));
    },
  },
  storage: {
    async upload(path: string, bytes: Uint8Array, contentType: string) {
      const { error } = await admin.storage.from(BUCKET).upload(path, bytes, { contentType, upsert: false });
      if (error) throw error;
    },
    async remove(paths: string[]) {
      const { error } = await admin.storage.from(BUCKET).remove(paths);
      if (error) throw error;
    },
    async signedUrl(path: string, seconds: number) {
      const { data, error } = await admin.storage.from(BUCKET).createSignedUrl(path, seconds);
      if (error) throw error;
      return data.signedUrl;
    },
  },
});

function translate(message: string) {
  if (/already been registered|already exists/i.test(message)) return 'Ya existe un usuario con ese correo';
  if (/password/i.test(message)) return `Contraseña no válida: ${message}`;
  return message;
}

Deno.serve(handler);
