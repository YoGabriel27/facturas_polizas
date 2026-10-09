// Lectura de facturas PDF de la aseguradora (formato "Gestión Seguros").
// Usa la capa de texto del PDF con coordenadas: cada dato se ubica por su
// posición en la hoja, igual que lo lee una persona.

import { parseAR, round2, cuitValido, normalizarCuit, numeroALetras, premioDeItem, TOLERANCIA } from './calc.js';

const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build';

// ---------- Extracción ----------
export async function leerArchivoPdf(archivo) {
  const pdfjs = await import(`${PDFJS}/pdf.min.mjs`);
  pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS}/pdf.worker.min.mjs`;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await archivo.arrayBuffer()) }).promise;
  return interpretarFactura(await extraerPaginas(doc));
}

export async function extraerPaginas(doc) {
  const paginas = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const contenido = await (await doc.getPage(n)).getTextContent();
    paginas.push(contenido.items
      .filter((i) => i.str && i.str.trim())
      .map((i) => ({ s: i.str.trim(), x: i.transform[4], y: i.transform[5], r: i.transform[4] + i.width })));
  }
  return paginas;
}

// ---------- Utilidades ----------
const esNumero = (s) => /^-?[\d.,]+$/.test(s) && /\d/.test(s);
const RX_FECHA = /(\d{2})\/(\d{2})\/(\d{4})/;
const aFecha = (s) => { const m = String(s || '').match(RX_FECHA); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
const mismaFila = (a, b, tol = 3) => Math.abs(a.y - b.y) <= tol;
const buscar = (items, pred) => items.find(pred);
const limpiarObjeto = (s) => s.replace(/\s*[.\-]+\s*$/, '').replace(/\s+/g, ' ').trim();

// Texto a la derecha de una etiqueta en la misma fila ("CAE Nº:" -> "86096265854384")
function valorDeEtiqueta(items, rx) {
  const et = buscar(items, (i) => rx.test(i.s));
  if (!et) return null;
  const resto = et.s.replace(rx, '').replace(/^\s*:?\s*/, '').trim();
  if (resto) return resto;
  const derecha = items.filter((i) => i !== et && mismaFila(i, et) && i.x > et.x).sort((a, b) => a.x - b.x)[0];
  return derecha ? derecha.s.replace(/^\s*:\s*/, '').trim() : null;
}

function cuitDesde(texto, avisos, quien) {
  if (!texto) return null;
  const limpio = texto.replace(/^CUIT\s*N[º°o]?\s*:?\s*/i, '').trim();
  const normal = normalizarCuit(limpio);
  if (normal && cuitValido(normal)) return normal;
  avisos.push(`El CUIT ${quien} viene incompleto en el PDF ("${limpio}"). Cargalo a mano en Entidades.`);
  return null;
}

// ---------- Interpretación ----------
const COLUMNAS_FILA1 = { 'Suma Asegurada': 'suma_asegurada', Prima: 'prima', 'Gtos. Not': 'gastos_notariales', Impuestos: 'impuestos', IVA: 'iva', Premio: 'premio' };
const COLUMNAS_FILA2 = { SubTotal: 'subtotal', 'Perc. IIBB': 'perc_iibb', 'IVA RG': 'iva_rg' };
const BORDES_POR_DEFECTO = {
  fila1: { suma_asegurada: 240, prima: 306, gastos_notariales: 366, impuestos: 438, iva: 498, premio: 552 },
  fila2: { subtotal: 366, perc_iibb: 438, iva_rg: 498 },
};

// Los importes están alineados a la derecha: se asignan a la columna cuyo borde derecho está más cerca.
function bordesDeColumnas(pagina) {
  const medir = (mapa, defecto) => {
    const bordes = { ...defecto };
    const filasNumericas = pagina.filter((i) => esNumero(i.s));
    for (const [titulo, campo] of Object.entries(mapa)) {
      const et = buscar(pagina, (i) => i.s === titulo);
      if (!et) continue;
      // El importe más cercano debajo del título define el borde real de la columna
      const debajo = filasNumericas.filter((n) => n.y < et.y && Math.abs(n.r - defecto[campo]) < 30);
      if (debajo.length) bordes[campo] = debajo.sort((a, b) => b.y - a.y)[0].r;
    }
    return bordes;
  };
  return { fila1: medir(COLUMNAS_FILA1, BORDES_POR_DEFECTO.fila1), fila2: medir(COLUMNAS_FILA2, BORDES_POR_DEFECTO.fila2) };
}

function columnaMasCercana(item, bordes) {
  let mejor = null, distancia = Infinity;
  for (const [campo, r] of Object.entries(bordes)) {
    const d = Math.abs(item.r - r);
    if (d < distancia) { distancia = d; mejor = campo; }
  }
  return distancia <= 20 ? mejor : null;
}

function leerItemsDePagina(pagina, avisos) {
  const titulo = buscar(pagina, (i) => i.s === 'Póliza');
  if (!titulo) return [];
  const pie = pagina.filter((i) => i.s === 'TOTALES' || /^Productor/.test(i.s)).sort((a, b) => b.y - a.y)[0];
  const limiteInferior = pie ? pie.y : 0;
  const bordes = bordesDeColumnas(pagina);

  const inicios = pagina
    .filter((i) => /^\d+$/.test(i.s) && i.x < 45 && i.y < titulo.y - 20 && i.y > limiteInferior + 3)
    .sort((a, b) => b.y - a.y);

  return inicios.map((inicio) => {
    const fila = (n) => pagina.filter((i) => Math.abs(i.y - (inicio.y - 12 * n)) <= 3 && i !== inicio);
    const [f1, f2, f3] = [fila(0), fila(1), fila(2)];
    const textos = (f, desde, hasta, conFechas = false) => f.filter((i) => i.x >= desde && i.x < hasta && !esNumero(i.s) && (conFechas || !RX_FECHA.test(i.s)))
      .sort((a, b) => a.x - b.x).map((i) => i.s).join(' ').trim();

    const it = {
      poliza_numero: Number(inicio.s),
      endoso: null, vigencia_desde: null, vigencia_hasta: null,
      asegurado: textos(f1, 95, 200),
      riesgo_texto: textos(f2, 95, 330),
      movimiento: textos(f3, 95, 205) || 'Lote de Refacturación',
      objeto: limpiarObjeto(textos(f3, 205, 600, true)),
      suma_asegurada: 0, prima: 0, gastos_notariales: 0, subtotal: 0,
      impuestos: 0, perc_iibb: 0, iva: 0, iva_rg: 0, premio: 0,
    };

    for (const i of f1) {
      if (RX_FECHA.test(i.s)) it.vigencia_desde = aFecha(i.s);
      else if (/^\d+$/.test(i.s) && i.r < 75) it.endoso = Number(i.s);
      else if (esNumero(i.s)) { const c = columnaMasCercana(i, bordes.fila1); if (c) it[c] = parseAR(i.s); }
    }
    for (const i of f2) {
      if (RX_FECHA.test(i.s)) it.vigencia_hasta = aFecha(i.s);
      else if (esNumero(i.s)) { const c = columnaMasCercana(i, bordes.fila2); if (c) it[c] = parseAR(i.s); }
    }

    const [ramo, ...resto] = it.riesgo_texto.split(' - ');
    it.ramo = ramo.trim();
    it.subtipo = resto.join(' - ').trim() || 'Sin especificar';

    if (it.endoso === null) avisos.push(`Póliza ${it.poliza_numero}: no se encontró el número de endoso.`);
    if (!it.vigencia_desde || !it.vigencia_hasta) avisos.push(`Póliza ${it.poliza_numero}: vigencia incompleta.`);
    return it;
  });
}

export function interpretarFactura(paginas) {
  const avisos = [];
  const errores = [];
  const p1 = paginas[0] || [];
  const todo = paginas.flat();

  // --- Comprobante ---
  const nro = buscar(p1, (i) => /^\d{4}-\d{8}$/.test(i.s));
  if (!nro) throw new Error('No parece una factura de la aseguradora: no se encontró el número de comprobante (0000-00000000).');
  const [pv, numero] = nro.s.split('-').map(Number);
  const tipo = (buscar(p1, (i) => /^[ABCM]$/.test(i.s) && i.y > nro.y - 60) || {}).s || 'A';
  const fecha = aFecha(valorDeEtiqueta(p1, /^Fecha:/));

  // --- Emisor: bloque superior izquierdo, por encima de "Sr (es):" ---
  const sr = buscar(p1, (i) => /^Sr\s*\(es\)/.test(i.s));
  const bloqueEmisor = p1.filter((i) => i.x < 60 && sr && i.y > sr.y + 5).sort((a, b) => b.y - a.y);
  const lineaCp = bloqueEmisor.find((i) => /^\(\d{4}\)/.test(i.s));
  const emisor = {
    razon_social: bloqueEmisor[0]?.s,
    domicilio: bloqueEmisor[1]?.s,
    codigo_postal: lineaCp ? lineaCp.s.match(/^\((\d{4})\)/)[1] : null,
    localidad: lineaCp ? lineaCp.s.replace(/^\(\d{4}\)\s*/, '') : null,
    cuit: cuitDesde(bloqueEmisor.find((i) => /^CUIT/.test(i.s))?.s, avisos, 'de la aseguradora'),
    ingresos_brutos: (bloqueEmisor.find((i) => /^Ingresos Brutos/.test(i.s))?.s || '').replace(/^Ingresos Brutos\s*N[º°o]?\s*:?\s*/, '') || null,
    condicion_iva: bloqueEmisor.find((i) => /^(Responsable|Exento|Monotributo)/.test(i.s))?.s || null,
  };

  // --- Cliente ---
  const cliente = { razon_social: null };
  if (sr) {
    cliente.razon_social = valorDeEtiqueta(p1, /^Sr\s*\(es\)\s*:?/);
    const debajo = p1.filter((i) => i.x < 60 && i.y < sr.y - 5).sort((a, b) => b.y - a.y);
    const filaDomicilio = debajo[0];
    const filaLocalidad = debajo[1];
    cliente.domicilio = filaDomicilio?.s || null;
    if (filaLocalidad) {
      cliente.localidad = filaLocalidad.s;
      const enFila = p1.filter((i) => mismaFila(i, filaLocalidad) && i !== filaLocalidad);
      const cp = enFila.map((i) => i.s.match(/^:?\s*(\d{4})$/)).find(Boolean);
      cliente.codigo_postal = cp ? cp[1] : null;
      cliente.provincia = enFila.filter((i) => i.x > 200 && /^[A-Za-zÁÉÍÓÚÑáéíóúñ .]+$/.test(i.s)).map((i) => i.s)[0] || null;
    }
  }
  cliente.condicion_iva = (buscar(p1, (i) => /^IVA:/.test(i.s))?.s || '').replace(/^IVA:\s*/, '') || null;
  cliente.cuit = cuitDesde(buscar(p1, (i) => /^CUIT/.test(i.s) && i.x > 300)?.s, avisos, 'del cliente');
  cliente.codigo_cliente = valorDeEtiqueta(p1, /^Código:/);
  if (!cliente.razon_social) errores.push('No se encontró el nombre del cliente.');

  // --- Pólizas (todas las páginas) ---
  const items = paginas.flatMap((pag) => leerItemsDePagina(pag, avisos));
  if (!items.length) errores.push('No se encontró ninguna póliza en el detalle.');

  // --- Totales (última página con "Premio Total") ---
  const ultima = [...paginas].reverse().find((pag) => pag.some((i) => i.s === 'Premio Total')) || [];
  // La misma etiqueta ("Prima", "Impuestos") aparece también como título de la tabla:
  // se toma la que tiene un importe en su misma fila, a la derecha.
  const totalDe = (etiqueta) => {
    for (const et of ultima.filter((i) => i.s === etiqueta)) {
      const v = ultima.find((i) => mismaFila(i, et) && i.x > et.x + 100 && esNumero(i.s));
      if (v) return parseAR(v.s);
    }
    return null;
  };
  const totales = {
    prima: totalDe('Prima'), subtotal: totalDe('Subtotal'), impuestos: totalDe('Impuestos'),
    iva: totalDe('Iva Insc. 21%'), otros_gastos: totalDe('Otros Gastos') ?? 0, premio_total: totalDe('Premio Total'),
  };
  if (totales.premio_total === null) errores.push('No se encontró el premio total.');

  // --- Deuda informada ---
  let deuda = null;
  const encVencido = buscar(todo, (i) => i.s === 'Vencido');
  if (encVencido) {
    const pag = paginas.find((pg) => pg.includes(encVencido));
    const valores = pag.filter((i) => esNumero(i.s) && i.y < encVencido.y - 4 && i.y > encVencido.y - 20).sort((a, b) => a.x - b.x);
    if (valores.length >= 3) deuda = { vencido: parseAR(valores[0].s), a_vencer: parseAR(valores[1].s), total: parseAR(valores[2].s) };
  }

  // --- Pie ---
  const productor = (valorDeEtiqueta(todo, /^Productor\s*:?/) || '').replace(/^:\s*/, '') || null;
  const cae = valorDeEtiqueta(todo, /^CAE\s*N[º°o]?\s*:?/);
  const caeVto = aFecha(valorDeEtiqueta(todo, /^Fecha de Vto\. de CAE:?/));
  const letras = buscar(todo, (i) => /\bPESOS\b.*\bCENTAVOS?\b/.test(i.s))?.s || null;

  // --- Controles ---
  items.forEach((it) => {
    const calculado = premioDeItem(it);
    if (Math.abs(calculado - it.premio) > TOLERANCIA) {
      errores.push(`Póliza ${it.poliza_numero}: el premio leído (${it.premio}) no coincide con la suma de sus componentes (${calculado}).`);
    }
  });
  const sumaItems = round2(items.reduce((a, it) => a + it.premio, 0));
  const cuadra = totales.premio_total !== null && Math.abs(sumaItems + (totales.otros_gastos || 0) - totales.premio_total) <= TOLERANCIA;
  if (totales.premio_total !== null && !cuadra) {
    errores.push(`Las pólizas suman ${sumaItems} y el premio total impreso es ${totales.premio_total}. Puede faltar alguna póliza en la lectura.`);
  }
  if (letras && totales.premio_total !== null) {
    const normal = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
    if (normal(letras) !== normal(numeroALetras(totales.premio_total))) {
      avisos.push('El importe en letras no coincide exactamente con el premio total en números.');
    }
  }
  if (deuda && Math.abs(deuda.vencido + deuda.a_vencer - deuda.total) > 1) {
    avisos.push('En la deuda informada, vencido + a vencer no da exactamente el total (redondeo de la aseguradora).');
  }

  return {
    tipo, punto_venta: pv, numero, fecha, emisor, cliente, productor,
    cae, cae_vencimiento: caeVto, items, totales, deuda, suma_items: sumaItems, cuadra,
    errores, avisos,
  };
}

// Datos que se envían a importar_factura() en Supabase
export function armarPayload(f, pdfPath = null) {
  return {
    tipo: f.tipo, punto_venta: f.punto_venta, numero: f.numero, fecha: f.fecha,
    cae: f.cae, cae_vencimiento: f.cae_vencimiento,
    otros_gastos: f.totales.otros_gastos || 0,
    premio_total: f.totales.premio_total,
    emisor: f.emisor, cliente: f.cliente, productor: f.productor,
    deuda: f.deuda, pdf_path: pdfPath,
    items: f.items.map((it) => ({
      poliza_numero: it.poliza_numero, endoso: it.endoso,
      vigencia_desde: it.vigencia_desde, vigencia_hasta: it.vigencia_hasta,
      asegurado: it.asegurado, ramo: it.ramo, subtipo: it.subtipo,
      movimiento: it.movimiento, objeto: it.objeto,
      suma_asegurada: it.suma_asegurada, prima: it.prima, gastos_notariales: it.gastos_notariales,
      impuestos: it.impuestos, perc_iibb: it.perc_iibb, iva: it.iva, iva_rg: it.iva_rg, premio: it.premio,
    })),
  };
}
