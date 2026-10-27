// Servidor estático para desarrollo local de la carpeta public/.
// Si defines SUPABASE_URL y SUPABASE_KEY, sirve /config.js con esos valores (sin editar el archivo).
// Uso: SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_KEY=<anon> npm run dev
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = join(import.meta.dirname, '..', 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.png': 'image/png',
};
const { SUPABASE_URL, SUPABASE_KEY, PORT = 3000 } = process.env;

createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  if (path === '/config.js' && SUPABASE_URL && SUPABASE_KEY) {
    res.writeHead(200, { 'Content-Type': TYPES['.js'] });
    return res.end(`window.ASISTE_CONFIG = ${JSON.stringify({ supabaseUrl: SUPABASE_URL, supabaseKey: SUPABASE_KEY })};`);
  }
  try {
    const file = join(ROOT, path === '/' ? 'index.html' : path);
    if (!file.startsWith(ROOT)) throw new Error('fuera de public');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('No encontrado');
  }
}).listen(PORT, () => console.log(`AsisteApp en http://localhost:${PORT}`));
