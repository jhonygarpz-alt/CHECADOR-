# Publicar AsisteApp en Google Play

La app de Android es una **Trusted Web Activity (TWA)**: una app nativa mínima que abre
`https://checador-jhug.vercel.app` a pantalla completa, sin barra del navegador. Toda la lógica sigue en la web, así
que **cada cambio que se publica en Vercel llega a la app sin subir una versión nueva a Play Store**.

| Dato | Valor |
|---|---|
| Nombre del paquete | `com.optimasolutions.asisteapp` (no se puede cambiar después de la primera publicación) |
| Versión | 1.0.1 (código de versión 2) |
| Android mínimo | 7.0 (API 24) · target API 36 |
| Permisos | Ubicación precisa y aproximada (la cámara la gestiona Chrome) |
| Configuración | [`android/twa-manifest.json`](../android/twa-manifest.json) |

## Archivos (no están en el repositorio)

- `app-release-bundle.aab`: el archivo que se sube a Play Console.
- `app-release-signed.apk`: para instalar y probar directamente en un celular Android.
- `asisteapp-upload.keystore` y su contraseña: **la llave de carga**. Guárdala en un lugar seguro (y una copia de
  respaldo). Se necesita para cada versión nueva. Nunca la subas a GitHub.

## Requisito en la web: `assetlinks.json`

`public/.well-known/assetlinks.json` demuestra a Android que la app y el sitio son del mismo dueño. Si no coincide,
la app se abre mostrando la barra de direcciones del navegador. Debe contener **dos** huellas SHA-256:

1. La de la llave de carga (ya incluida): `3B:EF:C5:F5:...:58:E7:AF`.
2. La de la **llave de firma de apps de Google Play**, que se obtiene después de subir el primer `.aab` en
   *Play Console → Prueba y publicación → Configuración → Integridad de la app → Firma de apps*. Agrégala al
   arreglo `sha256_cert_fingerprints` y vuelve a publicar en Vercel.

Comprobar: `https://checador-jhug.vercel.app/.well-known/assetlinks.json` debe abrir el JSON.

## Pasos en Play Console

1. Crea una cuenta de desarrollador en <https://play.google.com/console> (pago único de 25 USD; la verificación de
   identidad puede tardar unos días). Las cuentas personales nuevas deben hacer una **prueba cerrada con al menos
   12 personas durante 14 días** antes de publicar en producción; las cuentas de organización no.
2. **Crear app**: nombre *AsisteApp - Control de asistencia*, idioma español (México), tipo *App*, *Gratis*.
3. **Contenido de la app** (menú lateral, sección *Política*):
   - *Política de privacidad*: `https://checador-jhug.vercel.app/privacidad.html` (completa antes los datos entre
     corchetes de `public/privacidad.html`).
   - *Acceso a la app*: "Toda o parte de la funcionalidad está restringida" → da un usuario y contraseña de
     prueba (crea un empleado de demostración en *Personal*) e indica que el registro de entrada requiere estar dentro
     de la geocerca de una ubicación; puedes crear una ubicación de prueba con radio amplio para la revisión.
   - *Anuncios*: No contiene anuncios.
   - *Clasificación de contenido*: categoría *Utilidad, productividad, comunicación u otra*; responde "No" a todo.
   - *Público objetivo*: 18 años o más.
   - *Seguridad de los datos* (ver tabla abajo).
   - *Apps gubernamentales / financieras / de salud*: No.
4. **Ficha de Play Store**: descripción corta y completa (abajo), ícono 512×512, gráfica de portada 1024×500 y al
   menos 2 capturas de teléfono (incluidas en el paquete de archivos).
5. **Prueba y publicación → Pruebas internas** (o *Producción*): crea una versión, acepta la *Firma de apps de
   Google Play*, sube `app-release-bundle.aab`, escribe las notas de la versión y envíala a revisión.
6. Copia la huella SHA-256 de la llave de firma de Google Play al `assetlinks.json` (sección anterior).

### Seguridad de los datos (respuestas sugeridas)

| Tipo de dato | Se recopila | Se comparte | Opcional | Finalidad |
|---|---|---|---|---|
| Nombre, correo electrónico | Sí | No | No | Funcionalidad de la app, administración de cuentas |
| Ubicación precisa | Sí | No | No | Funcionalidad de la app (verificar el lugar al checar) |
| Fotos | Sí | No | No | Funcionalidad de la app (evidencia de cada registro) |
| Datos biométricos (rostro) | Sí (en *Información personal → Otra*) | No | No | Funcionalidad de la app, seguridad |
| Actividad en la app (registros) | Sí | No | No | Funcionalidad de la app, estadísticas para el empleador |

- Los datos se **cifran en tránsito**: Sí.
- Los usuarios **pueden solicitar la eliminación**: Sí (mediante el contacto del aviso de privacidad).

### Textos para la ficha

**Descripción corta** (máx. 80 caracteres):
> Checador de asistencia con reconocimiento facial, GPS y reportes en tiempo real.

**Descripción completa**:
> AsisteApp es el control de asistencia para el personal administrativo de tu empresa.
>
> • Registro de entrada y salida con reconocimiento facial: solo el empleado puede checar por sí mismo.
> • Verificación de ubicación GPS: el registro solo es válido dentro del área de su centro de trabajo.
> • Hora oficial del servidor y zonas horarias reales para cada sucursal.
> • Historial personal con horas trabajadas, retardos y horas extras.
> • Panel de administración en tiempo real: presentes, ausentes, retardos y quién está en la oficina.
> • Horas extras con autorización del administrador y observaciones.
> • Reportes diarios, semanales y mensuales exportables a Excel y PDF.
>
> AsisteApp es para uso interno de empresas: las cuentas las crea el administrador de cada organización.

> **Importante:** `enableNotifications` debe quedar en `true` en `twa-manifest.json`. Bubblewrap usa ese valor para
> activar el servicio interno (`DelegationService`) por el que Chrome le pide a la app el permiso de **ubicación**; si
> está en `false`, Android responde "permiso denegado" sin mostrar la pregunta.

## Publicar una versión nueva de la app Android

Solo hace falta si cambia algo de la parte nativa (nombre, ícono, colores, permisos). Los cambios de la web no lo
requieren.

```bash
npm i -g @bubblewrap/cli         # requiere JDK 17 y Android SDK
cd android                       # copia aquí asisteapp-upload.keystore
# sube appVersionCode y appVersionName en twa-manifest.json
bubblewrap update --skipVersionUpgrade
bubblewrap build                 # pide la contraseña de la llave
```
