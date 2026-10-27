# AsisteApp — Checador de entrada y salida

Control de asistencia para personal administrativo con **reconocimiento facial**, **geolocalización (geocercas)**,
**zonas horarias reales**, **actualización en tiempo real** y **reportes diarios, semanales y mensuales**.

Funciona como aplicación web instalable (PWA) en el celular de cada empleado y como panel de administración en escritorio.

## Funciones

| Empleado (móvil) | Administración (escritorio) |
|---|---|
| Registro de entrada/salida con rostro + GPS | Dashboard en vivo: presentes, ausentes, dentro, retardos |
| Reloj sincronizado con el servidor en su zona horaria | Alta/edición de personal, horarios, tolerancia y días laborales |
| Jornada del día y tiempo en oficina | Ubicaciones con radio permitido y zona horaria IANA |
| Historial mensual con horas y retardos | Auditoría de registros (incluye intentos rechazados y foto) |
| Enrolamiento facial guiado | Reportes diario / semanal / mensual / personalizado, Excel (CSV) e impresión/PDF |

## Cómo funciona cada requisito

- **Reconocimiento facial.** En el navegador, [face-api](https://github.com/vladmandic/face-api) detecta el rostro y
  calcula un descriptor numérico de 128 valores. El servidor lo compara con el registrado (distancia euclidiana,
  umbral `FACE_THRESHOLD`, 0.5 por defecto). Las fotos de referencia no se almacenan; solo una miniatura de cada
  registro como evidencia para auditoría.
- **Ubicación.** Cada ubicación tiene coordenadas y radio. El registro solo es válido si el GPS del dispositivo está
  dentro del radio y la precisión es suficiente (`MAX_GPS_ACCURACY_M`). Un empleado puede estar asignado a una
  ubicación o a cualquiera activa.
- **Zonas horarias reales.** Los instantes se guardan en UTC con la hora del **servidor** (no la del celular). La fecha y
  hora local se calculan con la zona IANA de la ubicación (`America/Mexico_City`, `America/Tijuana`, `America/Cancun`…),
  así los retardos, reportes y horario de verano son correctos en cada sucursal.
- **Tiempo real.** Server-Sent Events: el panel se actualiza en cuanto alguien checa, sin recargar.
- **Reportes.** Por periodo: días trabajados vs. esperados, faltas, retardos, jornadas sin salida, horas totales,
  entrada promedio, gráfica de asistencia por día y detalle de cada entrada/salida. Las jornadas nocturnas se
  asignan al día de la entrada.

## Puesta en marcha

Requisitos: **Node.js 22.13 o superior** (usa SQLite integrado en Node, sin dependencias nativas).

```bash
npm install
npm start                 # http://localhost:3000
npm run seed:demo         # opcional: 6 empleados con 6 semanas de historial (contraseña demo1234)
npm test
```

Acceso inicial: `admin@empresa.com` / `admin123` (define `ADMIN_EMAIL` y `ADMIN_PASSWORD` antes del primer arranque
para cambiarlo). Después, en **Ubicaciones** ajusta la Oficina Central a tus coordenadas reales y en **Personal** da de
alta a los empleados; cada uno registra su rostro la primera vez que entra.

> **Importante:** la cámara y el GPS del navegador solo funcionan en **HTTPS** (o `localhost`). En producción publica la
> app detrás de un proxy con certificado (Nginx, Caddy, Cloudflare, etc.).

### Variables de entorno

| Variable | Por defecto | Descripción |
|---|---|---|
| `PORT` | `3000` | Puerto HTTP |
| `DB_FILE` | `data/asisteapp.db` | Archivo SQLite |
| `DEFAULT_TZ` | `America/Mexico_City` | Zona horaria para empleados sin ubicación asignada |
| `FACE_THRESHOLD` | `0.5` | Distancia máxima para aceptar un rostro (menor = más estricto) |
| `MAX_GPS_ACCURACY_M` | `100` | Precisión GPS mínima requerida, en metros |
| `MAX_SHIFT_HOURS` | `16` | Duración máxima de una jornada para emparejar entrada y salida |
| `SESSION_HOURS` | `12` | Vigencia de la sesión |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | `admin@empresa.com` / `admin123` | Administrador inicial |

## Estructura

```
server/
  index.js        API REST + archivos estáticos
  attendance.js   Validación de rostro, geocerca, secuencia entrada/salida y retardos
  reports.js      Emparejamiento de jornadas, reportes, dashboard y CSV
  time.js         Zonas horarias y periodos (diario, semanal, mensual)
  geo.js / face.js / auth.js / realtime.js / db.js
public/           PWA (HTML/CSS/JS sin framework)
scripts/seed-demo.js
test/             Pruebas (node --test)
```

## Limitaciones conocidas y siguientes pasos

- **Prueba de vida (anti-spoofing).** La verificación facial corre en el navegador; una foto o video del empleado frente
  a la cámara podría pasar, y un usuario técnico podría alterar los datos enviados. La miniatura guardada en cada
  registro permite auditarlo. Para mayor seguridad se recomienda una app nativa o un servicio con detección de vida
  (AWS Rekognition Face Liveness, Azure Face, FaceTec).
- **Ubicación simulada.** Un navegador no puede detectar apps de GPS falso; una app nativa sí puede (Android
  `isMock`). También puede restringirse por IP/Wi-Fi de la oficina.
- **Escala.** SQLite es adecuado para cientos de empleados; para varias sucursales con alta concurrencia conviene
  migrar a PostgreSQL.
- **Privacidad.** Los datos biométricos son datos personales sensibles (en México, LFPDPPP): obtén consentimiento
  expreso por escrito y publica el aviso de privacidad antes de usar el sistema.
