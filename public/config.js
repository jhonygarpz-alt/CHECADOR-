// Conexión con Supabase. La llave publicable (anon) es pública por diseño: la seguridad la dan
// Supabase Auth, la Edge Function `api` y las políticas RLS. NUNCA pongas aquí la llave service_role.
window.ASISTE_CONFIG = {
  supabaseUrl: 'https://pwsayfyjndignhqkxikv.supabase.co',
  supabaseKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB3c2F5ZnlqbmRpZ25ocWt4aWt2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIyNTIyNTEsImV4cCI6MjEwNzgyODI1MX0.UFyHdUDXm8konTabY053jB6fCCGiG5fd7To28eTsIK0',
};
