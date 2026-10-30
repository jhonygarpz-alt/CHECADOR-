// Genera el Excel "INCIDENCIAS DE NOMINA" con el formato exacto de la empresa.
// Usa /plantillas/incidencias-nomina.xlsx (estilos, colores y tema del archivo original) y escribe la hoja:
// dos renglones por empleado (INCIDENCIA y HRS ADIC) y una columna por día del periodo.

const JSZIP_URL = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm';
const TEMPLATE_URL = '/plantillas/incidencias-nomina.xlsx';

// Índices de estilo (cellXfs) y de formato condicional (dxf) de la plantilla.
const S = {
  title: 17, titleMid: 18, titleEnd: 19, monthDay: 1,
  sub: { B: 2, C: 2, D: 2, E: 3, F: 3, G: 4, H: 4, I: 5, J: 5, K: 5, L: 4 }, weekday: 6,
  head: { B: 7, C: 8, D: 8, E: 8, F: 8, G: 8, H: 8, I: 8, J: 8, K: 9, L: 10 }, headDay: 11,
  top: { B: 20, C: 22, D: 24, E: 26, F: 28, G: 30, H: 30, I: 30, J: 32, Jred: 38, K: 34, L: 12, day: 13 },
  bottom: { B: 21, C: 23, D: 25, E: 27, F: 29, G: 31, H: 31, I: 31, J: 33, Jred: 39, K: 35, L: 14, day: 15 },
};
const DXF = { ACTIVO: 48, VACANTE: 47, BAJA: 46, F: 44, R: 43, A: 42 };
const WEEKDAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const HEADERS = {
  B: 'NOMBRE', C: 'PUESTO', D: 'ESTATUS', E: 'FECHA INICIAL', F: 'FECHA FIN', G: 'ASISTENCIAS\n(A)', H: 'FALTAS\n(F)',
  I: 'REVISIONES\n(R)', J: 'HRS\nADICIONALES', K: 'OBSERVACIONES', L: 'DATO',
};
const FIXED = ['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'];

const xml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const colName = (n) => { let s = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
const serial = (d) => (Date.parse(`${d}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86400000;
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const weekday = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();
const ddmm = (d) => `${d.slice(8, 10)}-${d.slice(5, 7)}`;
const round1 = (n) => Math.round(n * 10) / 10;

function cell(ref, style, value) {
  if (value === null || value === undefined || value === '') return `<c r="${ref}" s="${style}"/>`;
  if (typeof value === 'number') return `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
}

/** Semana ISO (para el nombre del archivo, igual que "SEM 44"). */
export function isoWeek(d) {
  const date = new Date(`${d}T00:00:00Z`);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  return Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
}

/** Semana de nómina de jueves a miércoles que contiene la fecha. */
export function payrollWeek(d) {
  const start = addDays(d, -((weekday(d) - 4 + 7) % 7));
  return { start, end: addDays(start, 6) };
}

/** Convierte el reporte de la API en las filas del formato de incidencias. */
export function incidenciasData(report, users, today) {
  const days = [];
  for (let d = report.range.start; d <= report.range.end; d = addDays(d, 1)) days.push(d);
  const byId = new Map(users.map((u) => [u.id, u]));
  return [...report.summary].sort((a, b) => a.name.localeCompare(b.name, 'es')).map((s) => {
    const user = byId.get(s.userId) ?? {};
    const workDays = new Set(String(user.work_days ?? '1,2,3,4,5').split(',').map(Number));
    const shifts = report.rows.filter((r) => r.userId === s.userId);
    const absences = new Set(s.absenceDates);
    const notes = [];
    const perDay = days.map((d) => {
      const own = shifts.filter((r) => r.date === d);
      const extra = own.reduce((acc, r) => acc + (r.overtime?.approvedMinutes ?? 0), 0) / 60;
      for (const r of own.filter((x) => x.overtime)) {
        const o = r.overtime;
        const h = round1((o.status === 'approved' ? o.approvedMinutes : r.overtimeMinutes) / 60);
        if (o.status === 'approved') notes.push(`${ddmm(d)} ${h} HRS AUTORIZADAS: ${o.notes}`);
        else if (o.status === 'rejected') notes.push(`${ddmm(d)} NO PAGAR ${round1(r.overtimeMinutes / 60)} HRS: ${o.notes}`);
        else notes.push(`${ddmm(d)} ${h} HRS PENDIENTES DE AUTORIZAR`);
      }
      let code = '';
      if (own.length) code = own.some((r) => r.outTs === null) ? 'R' : 'A';
      else if (absences.has(d)) code = 'F';
      else if (d <= today && !workDays.has(weekday(d))) code = 'D';
      return { date: d, code, hours: extra > 0 ? round1(extra) : null };
    });
    return {
      name: s.name.toUpperCase(),
      position: String(user.position ?? '').toUpperCase(),
      status: user.active === false ? 'BAJA' : 'ACTIVO',
      start: report.range.start,
      end: report.range.end,
      attendances: perDay.filter((x) => x.code === 'A' || x.code === 'R').length,
      absences: perDay.filter((x) => x.code === 'F').length,
      reviews: perDay.filter((x) => x.code === 'R').length,
      extraHours: round1(s.approvedOvertimeMinutes / 60),
      notes: notes.join(', ').toUpperCase(),
      days: perDay,
    };
  });
}

/** Genera el archivo .xlsx a partir de las filas de incidenciasData(). */
export async function buildIncidenciasXlsx(people, range) {
  const [{ default: JSZip }, template] = await Promise.all([
    import(JSZIP_URL),
    fetch(TEMPLATE_URL).then((r) => { if (!r.ok) throw new Error('No se encontró la plantilla de Excel'); return r.arrayBuffer(); }),
  ]);
  const zip = await JSZip.loadAsync(template);
  const sheetPath = 'xl/worksheets/sheet1.xml';
  const base = await zip.file(sheetPath).async('string');

  const days = [];
  for (let d = range.start; d <= range.end; d = addDays(d, 1)) days.push(d);
  const dayCols = days.map((_, i) => colName(13 + i)); // la columna M es la 13
  const lastCol = dayCols.at(-1) ?? 'L';

  const rows = [];
  rows.push(`<row r="5" spans="2:${12 + days.length}" ht="20.25" customHeight="1">${[
    cell('B5', S.title, 'INCIDENCIAS DE NOMINA'),
    ...FIXED.slice(1, -1).map((c) => cell(`${c}5`, S.titleMid)), cell('L5', S.titleEnd),
    ...dayCols.map((c) => cell(`${c}5`, S.monthDay)),
  ].join('')}</row>`);
  rows.push(`<row r="6" spans="2:${12 + days.length}">${[
    ...FIXED.map((c) => cell(`${c}6`, S.sub[c])),
    ...dayCols.map((c, i) => cell(`${c}6`, S.weekday, WEEKDAYS[weekday(days[i])])),
  ].join('')}</row>`);
  rows.push(`<row r="7" spans="2:${12 + days.length}" ht="36.75" customHeight="1" thickBot="1">${[
    ...FIXED.map((c) => cell(`${c}7`, S.head[c], HEADERS[c])),
    ...dayCols.map((c, i) => cell(`${c}7`, S.headDay, serial(days[i]))),
  ].join('')}</row>`);

  const merges = ['B5:L5'];
  const statusCells = [];
  let r = 8;
  for (const p of people) {
    const top = r;
    const bottom = r + 1;
    const jStyle = p.extraHours > 0 ? 'Jred' : 'J';
    rows.push(`<row r="${top}" spans="2:${12 + days.length}">${[
      cell(`B${top}`, S.top.B, p.name), cell(`C${top}`, S.top.C, p.position), cell(`D${top}`, S.top.D, p.status),
      cell(`E${top}`, S.top.E, serial(p.start)), cell(`F${top}`, S.top.F, serial(p.end)),
      cell(`G${top}`, S.top.G, p.attendances), cell(`H${top}`, S.top.H, p.absences), cell(`I${top}`, S.top.I, p.reviews),
      cell(`J${top}`, S.top[jStyle], p.extraHours), cell(`K${top}`, S.top.K, p.notes), cell(`L${top}`, S.top.L, 'INCIDENCIA'),
      ...dayCols.map((c, i) => cell(`${c}${top}`, S.top.day, p.days[i].code)),
    ].join('')}</row>`);
    rows.push(`<row r="${bottom}" spans="2:${12 + days.length}" ht="15.75" customHeight="1" thickBot="1">${[
      ...['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'].map((c) => cell(`${c}${bottom}`, S.bottom[c])),
      cell(`J${bottom}`, S.bottom[jStyle]), cell(`K${bottom}`, S.bottom.K), cell(`L${bottom}`, S.bottom.L, 'HRS ADIC'),
      ...dayCols.map((c, i) => cell(`${c}${bottom}`, S.bottom.day, p.days[i].hours)),
    ].join('')}</row>`);
    for (const c of ['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K']) merges.push(`${c}${top}:${c}${bottom}`);
    statusCells.push(`D${top}`);
    r += 2;
  }
  const lastRow = Math.max(r - 1, 7);

  const cond = [];
  if (statusCells.length) {
    cond.push(`<conditionalFormatting sqref="${statusCells.join(' ')}">${['ACTIVO', 'VACANTE', 'BAJA'].map((v, i) =>
      `<cfRule type="cellIs" dxfId="${DXF[v]}" priority="${i + 1}" operator="equal"><formula>"${v}"</formula></cfRule>`).join('')}</conditionalFormatting>`);
    cond.push(`<conditionalFormatting sqref="M8:${lastCol}${lastRow}">${['F', 'R', 'A'].map((v, i) =>
      `<cfRule type="cellIs" dxfId="${DXF[v]}" priority="${i + 4}" operator="equal"><formula>"${v}"</formula></cfRule>`).join('')}</conditionalFormatting>`);
  }

  // Anchos: los de la plantilla para B..L y el de los días para cada columna de fecha.
  const fixedCols = (base.match(/<col [^>]*>/g) ?? []).filter((c) => Number(c.match(/min="(\d+)"/)[1]) <= 12);
  const cols = `<cols>${fixedCols.join('')}${dayCols.map((_, i) =>
    `<col min="${13 + i}" max="${13 + i}" width="4.5703125" customWidth="1"/>`).join('')}</cols>`;

  const sheet = base
    .replace(/<dimension ref="[^"]*"\/>/, `<dimension ref="B5:${lastCol}${lastRow}"/>`)
    .replace(/<cols>.*?<\/cols>/s, cols)
    .replace('<sheetData/>', `<sheetData>${rows.join('')}</sheetData><mergeCells count="${merges.length}">${
      merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>${cond.join('')}`);
  zip.file(sheetPath, sheet);
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
