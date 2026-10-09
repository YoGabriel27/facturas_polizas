// Centros de costo (CC): lectura del "Reporte CC" en Excel y sugerencias de asignación.
// El Excel trae las columnas CC (código), Descripción y Habilitado (Verdadero/Falso).

// SheetJS desde su CDN oficial (versión con las correcciones de seguridad al leer archivos)
const URL_SHEETJS = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';

// La mayoría de los códigos son NN-NNN, pero el listado también tiene NN-N, NN-NN y NN-NNNNN
export const RX_CC = /^\d{2}-\d{1,5}$/;

// Mayúsculas y sin tildes, pero conservando la Ñ ("Aña" no es "Ana")
const normalizar = (s) => String(s ?? '').toUpperCase().normalize('NFD')
  .replace(/(?!\u0303)[\u0300-\u036f]/g, '').normalize('NFC').trim();

export async function cargarLectorExcel() {
  if (window.XLSX) return window.XLSX;
  await new Promise((ok, mal) => {
    const s = document.createElement('script');
    s.src = URL_SHEETJS;
    s.onload = ok;
    s.onerror = () => mal(new Error('No se pudo cargar el lector de Excel. Revisá la conexión a internet.'));
    document.head.appendChild(s);
  });
  return window.XLSX;
}

function aBooleano(valor) {
  if (typeof valor === 'boolean') return valor;
  const v = normalizar(valor);
  if (['VERDADERO', 'TRUE', 'SI', '1', 'X', 'HABILITADO'].includes(v)) return true;
  if (['FALSO', 'FALSE', 'NO', '0', 'DESHABILITADO'].includes(v)) return false;
  return null;
}

// Fecha del reporte tomada del nombre del archivo: "BASE_de_CC_24-09-2026.xlsx" -> 2026-09-24
export function fechaDesdeNombre(nombre) {
  const m = String(nombre).match(/(\d{2})[-_.](\d{2})[-_.](\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

export function leerReporteCC(XLSX, buffer) {
  const libro = XLSX.read(buffer, { type: 'array' });
  const nombreHoja = libro.SheetNames.find((n) => normalizar(n) === 'CC') || libro.SheetNames[0];
  const filas = XLSX.utils.sheet_to_json(libro.Sheets[nombreHoja], { header: 1, defval: '', raw: true });

  // Encabezado: la primera fila que tenga una columna "CC"
  const iEnc = filas.findIndex((f) => f.some((c) => normalizar(c) === 'CC'));
  if (iEnc === -1) throw new Error('No se encontró la columna "CC". El Excel debe tener las columnas CC, Descripción y Habilitado.');
  const enc = filas[iEnc].map(normalizar);
  const col = (nombre, defecto) => { const i = enc.indexOf(nombre); return i === -1 ? defecto : i; };
  const iCC = col('CC', 0), iDesc = col('DESCRIPCION', 1), iHab = col('HABILITADO', 2);

  const validas = new Map();
  const invalidas = [];
  filas.slice(iEnc + 1).forEach((f, k) => {
    const nroFila = iEnc + k + 2;
    const codigo = String(f[iCC] ?? '').trim();
    if (!codigo && !String(f[iDesc] ?? '').trim()) return; // fila vacía
    const habilitado = aBooleano(f[iHab]);
    if (!RX_CC.test(codigo)) { invalidas.push(`fila ${nroFila} (código "${codigo || 'vacío'}")`); return; }
    if (habilitado === null) { invalidas.push(`fila ${nroFila} (Habilitado "${f[iHab]}")`); return; }
    validas.set(codigo, { codigo, descripcion: String(f[iDesc] ?? '').trim() || 'Sin descripción', habilitado });
  });

  return { hoja: nombreHoja, filas: [...validas.values()], invalidas };
}

// ---------- Sugerencias ----------
// Compara las palabras de la obra (organismo y contrato) con la descripción de cada CC.
const VACIAS = new Set(['DEL', 'LAS', 'LOS', 'PARA', 'POR', 'CON', 'PROVINCIA', 'MINISTERIO', 'SOCIEDAD',
  'ANONIMA', 'SRL', 'NRO', 'LICITACION', 'PUBLICA', 'CONTRATACION', 'DIRECTA', 'EXPEDIENTE', 'OBRA',
  'OBRAS', 'CONTRATO', 'FECHA', 'NOTA', 'PEDIDO', 'ORDEN', 'COMPRA', 'GENERALES', 'EMPRESA', 'ESTADO',
  'SERVICIO', 'SERVICIOS', 'SEGUROS', 'MUTUAL', 'GOBIERNO', 'NACIONAL', 'ENTE', 'ACTUACION', 'ELECTRONICA']);

function palabras(texto) {
  const t = normalizar(texto).replace(/\b(?:[A-ZÑ] ){2,}[A-ZÑ]\b/g, (m) => m.replace(/ /g, '')); // "S A M E E P" -> "SAMEEP"
  return t.split(/[^A-Z0-9Ñ]+/).filter((p) => p.length >= 3 && !VACIAS.has(p) && !/^\d+$/.test(p));
}

const coincide = (a, b) => a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));

// Cada palabra pesa según lo rara que es en el listado: "SAMEEP" o "PATAGONIA" pesan mucho,
// "CHACO" o "MANT" casi nada. Se calcula una vez por listado.
let indice = { centros: null, filas: [], frecuencia: new Map() };
function indexar(centros) {
  if (indice.centros === centros) return indice;
  const filas = [...centros.values()].map((cc) => ({ cc, palabras: [...new Set(palabras(cc.descripcion))] }));
  const frecuencia = new Map();
  filas.forEach((f) => f.palabras.forEach((p) => frecuencia.set(p, (frecuencia.get(p) || 0) + 1)));
  indice = { centros, filas, frecuencia };
  return indice;
}

export function sugerirCentros(texto, centros, cantidad = 5) {
  const propias = [...new Set(palabras(texto))];
  if (!propias.length || !centros.size) return [];
  const { filas, frecuencia } = indexar(centros);
  const total = filas.length;
  return filas
    .map(({ cc, palabras: delCC }) => {
      let puntos = 0;
      for (const p of propias) {
        const d = delCC.find((x) => coincide(p, x));
        if (d) puntos += Math.log(total / (frecuencia.get(d) || 1));
      }
      return { cc, puntos };
    })
    .filter((x) => x.puntos >= Math.log(total / 10)) // al menos una coincidencia poco frecuente
    .sort((a, b) => b.puntos - a.puntos || Number(b.cc.habilitado) - Number(a.cc.habilitado))
    .slice(0, cantidad)
    .map((x) => x.cc);
}

export function buscarCentros(texto, centros, cantidad = 40) {
  const t = normalizar(texto);
  if (!t) return [];
  const exacto = centros.get(texto.trim());
  const lista = [...centros.values()].filter((cc) => cc !== exacto &&
    (cc.codigo.startsWith(texto.trim()) || normalizar(cc.descripcion).includes(t)));
  return (exacto ? [exacto, ...lista] : lista).slice(0, cantidad);
}
