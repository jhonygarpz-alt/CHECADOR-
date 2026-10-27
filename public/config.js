// Conexión con Supabase. La llave publicable (anon) es pública por diseño: la seguridad la dan
// Supabase Auth, la Edge Function `api` y las políticas RLS. NUNCA pongas aquí la llave service_role.
window.ASISTE_CONFIG = {
  supabaseUrl: '',
  supabaseKey: '',
};
