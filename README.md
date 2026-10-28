# AsisteApp: checador de entrada y salida

Control de asistencia para personal administrativo con **reconocimiento facial**, **geolocalización (geocercas)**,
**zonas horarias reales**, **actualización en tiempo real** y **reportes diarios, semanales y mensuales**.
Funciona sobre **Supabase**.

## Funciones

| Empleado (móvil) | Administración (escritorio) |
|---|---|
| Registro de entrada/salida con rostro + GPS | Dashboard en vivo: presentes, ausentes, dentro, retardos |
| Reloj sincronizado con el servidor en su zona horaria | Alta/edición de personal, horarios, tolerancia y días laborales |
| Jornada del día y tiempo en oficina | Ubicaciones con radio permitido y zona horaria IANA |
| Historial mensual con horas y retardos | Auditoría de registros (incluye intentos rechazados y foto) |
| Enrolamiento facial guiado | Reportes diario / semanal / mensual / personalizado, Excel (CSV) e impresión/PDF |
| Sus horas extras y si fueron autorizadas | Autorización de horas extras con observaciones obligatorias |

## Arquitectura

```
Navegador (PWA, carpeta public/)          Supabase
 ├─ face-api: descriptor facial  ───────►  Edge Function `api`  ──► Postgres (esquema `asiste`)
 ├─ GPS del dispositivo                    (valida rostro, geocerca,     ├─ locations, profiles,
 ├─ Supabase Auth (inicio de sesión)        hora del servidor, reportes)  │  face_templates, records
 └─ Supabase Realtime  ◄──────────────────────────────────────────────────┘  (RLS)
                                           Storage: bucket `asiste-snapshots` (fotos de cada registro)
```

- **Reconocimiento facial.** En el navegador, [face-api](https://github.com/vladmandic/face-api) calcula un
  descriptor de 128 valores. La Edge Function lo compara con la plantilla del empleado (distancia euclidiana,
  umbral `FACE_THRESHOLD`, 0.5 por defecto). Las plantillas están en una tabla que ningún cliente puede leer.
- **Ubicación.** Cada ubicación tiene coordenadas y radio. El registro solo es válido dentro del radio y con
  precisión GPS suficiente (`MAX_GPS_ACCURACY_M`).
- **Zonas horarias reales.** La hora la pone el servidor (no el celular), se guarda en UTC y la fecha/hora local se
  calcula con la zona IANA de la ubicación: retardos, reportes y horario de verano son correctos en cada sucursal.
- **Tiempo real.** Supabase Realtime sobre `asiste.records`; la seguridad por fila (RLS) hace que el administrador
  reciba todos los registros y cada empleado solo los suyos.
- **Horas extras.** Se calculan solas: tiempo trabajado menos la jornada programada del empleado (a partir de
  `MIN_OVERTIME_MINUTES`, 15 por defecto). Quedan *pendientes* hasta que un **administrador** las autoriza (todas o
  solo parte de los minutos) o las rechaza, siempre escribiendo el motivo en **observaciones**. Se guarda quién decidió
  y cuándo; los empleados solo pueden consultarlas. Aparecen en el historial del empleado, en los reportes y en el Excel.
- **Aislamiento.** Todo vive en el esquema `asiste` y el bucket `asiste-snapshots`, así que no toca otras tablas que ya
  tenga el proyecto.

## Publicar en Supabase

Requisitos: Node.js 22.13+ y la [CLI de Supabase](https://supabase.com/docs/guides/cli) (incluida como dependencia).

```bash
npm install
npx supabase login
npx supabase link --project-ref <ref-del-proyecto>

npx supabase db push                                   # crea el esquema asiste, RLS, Realtime y el bucket
npx supabase secrets set ADMIN_EMAILS=jhonygarpz@gmail.com DEFAULT_TZ=America/Mexico_City
npx supabase functions deploy api --no-verify-jwt      # la función valida el token por sí misma
```

En el panel de Supabase:

1. **Authentication → Users → Add user**: crea tu usuario con el correo de `ADMIN_EMAILS` (márcalo como confirmado).
   Al entrar por primera vez quedarás como administrador.
2. **Authentication → Sign In / Providers**: desactiva *Allow new users to sign up*. Los empleados los da de alta el
   administrador desde la app.

Después llena `public/config.js` con la URL del proyecto y la llave **publicable (anon)** (Project Settings → API) y
publica la carpeta `public/` en un hosting estático con HTTPS. Con **Vercel**: *Add New → Project*, importa este
repositorio de GitHub y presiona *Deploy* (el archivo `vercel.json` ya indica que se publica `public/` sin compilación).
Cada push a la rama de producción vuelve a publicar la app.

> La cámara y el GPS del navegador solo funcionan en **HTTPS** (o `localhost`).

### Primeros pasos en la app

1. Entra con tu usuario administrador.
2. **Ubicaciones**: registra tus oficinas (puedes usar "Usar mi ubicación actual" estando en el lugar) con su radio y
   zona horaria.
3. **Personal**: da de alta a los empleados con su horario, tolerancia, días laborales y ubicación.
4. Cada empleado entra desde su celular, registra su rostro y ya puede checar.

### Variables (secrets) de la Edge Function

| Variable | Por defecto | Descripción |
|---|---|---|
| `ADMIN_EMAILS` | — | Correos (separados por coma) que se vuelven administradores al primer inicio de sesión |
| `DEFAULT_TZ` | `America/Mexico_City` | Zona horaria para empleados sin ubicación asignada |
| `FACE_THRESHOLD` | `0.5` | Distancia máxima para aceptar un rostro (menor = más estricto) |
| `MAX_GPS_ACCURACY_M` | `100` | Precisión GPS mínima requerida, en metros |
| `MAX_SHIFT_HOURS` | `16` | Duración máxima de una jornada para emparejar entrada y salida |
| `MIN_OVERTIME_MINUTES` | `15` | Minutos mínimos por encima de la jornada para considerarse horas extras |

## Desarrollo local

Necesitas Docker para el Supabase local.

```bash
npm install
npm run supabase:start                                  # Postgres, Auth, Realtime, Storage y Edge Runtime
cp supabase/functions/.env.example supabase/functions/.env   # pon ADMIN_EMAILS=admin@empresa.com
npx supabase functions serve --env-file supabase/functions/.env

eval "$(npx supabase status -o env)"
npm run seed:demo                                       # opcional: 2 sucursales y 6 empleados con historial (demo1234)
SUPABASE_URL=$API_URL SUPABASE_KEY=$ANON_KEY npm run dev     # http://localhost:3000
```

Crea el administrador local con `admin@empresa.com` en Auth (por ejemplo, ejecutando la prueba de integración, que lo
crea con la contraseña `admin-secreto-123`).

Pruebas:

```bash
npm test                                                # lógica pura: zonas horarias, GPS, rostro, jornadas
eval "$(npx supabase status -o env)" && npm run test:integration   # punta a punta contra el Supabase local
```

## Estructura

```
supabase/
  migrations/…_asisteapp.sql   Esquema asiste, RLS, Realtime y bucket de fotos
  functions/api/index.ts       Edge Function (Deno): conecta Postgres, Auth y Storage
  functions/_shared/           Lógica compartida: handler.js (rutas), attendance.js, reports.js, time.js, geo.js, face.js
public/                        PWA (HTML/CSS/JS sin framework) + config.js
scripts/                       serve.mjs (servidor local), seed-demo.mjs (datos de ejemplo)
test/                          Pruebas unitarias e integración
```

## Limitaciones conocidas y siguientes pasos

- **Prueba de vida (anti-spoofing).** La verificación facial corre en el navegador; una foto o video del empleado
  frente a la cámara podría pasar, y un usuario técnico podría alterar los datos enviados. La foto guardada en cada
  registro permite auditarlo. Para mayor seguridad: app nativa o un servicio con detección de vida (AWS Rekognition
  Face Liveness, Azure Face, FaceTec).
- **Ubicación simulada.** Un navegador no puede detectar apps de GPS falso; una app nativa sí (Android `isMock`).
- **Privacidad.** Los datos biométricos son datos personales sensibles (LFPDPPP en México): obtén consentimiento
  expreso por escrito y publica el aviso de privacidad antes de usar el sistema.
