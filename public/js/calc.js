// Cálculos, formatos argentinos y validaciones de la factura

const formatoPesos = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const TOLERANCIA = 0.05;          // redondeos de la aseguradora
export const TASA_IVA = 0.21;
export const TASA_IMPUESTOS = 0.127;     // observado en la factura 0004-00259740
export const ALICUOTA_PRIMA = 0.001;     // 1 ‰ de la suma asegurada

export const money = (v) => formatoPesos.format(Number(v || 0));
export const round2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;

// Acepta "1.234,56", "1234,56", "1234.56" y "16,477,101"
export function parseAR(texto) {
  if (texto === null || texto === undefined) return 0;
  let s = String(texto).trim().replace(/\s|\$/g, '');
  if (!s) return 0;
  const tieneComa = s.includes(','), tienePunto = s.includes('.');
  if (tieneComa && tienePunto) {
    const decimal = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';
    const miles = decimal === ',' ? '.' : ',';
    s = s.split(miles).join('').replace(decimal, '.');
  } else if (tieneComa) {
    s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if (tienePunto && /^\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

export const fmtFecha = (iso) => {
  if (!iso) return '';
  const [a, m, d] = String(iso).slice(0, 10).split('-');
  return `${d}/${m}/${a}`;
};

export const comprobante = (f) =>
  `${f.tipo} ${String(f.punto_venta).padStart(4, '0')}-${String(f.numero).padStart(8, '0')}`;

// ---------- CUIT ----------
export function normalizarCuit(texto) {
  const d = String(texto || '').replace(/\D/g, '');
  if (d.length !== 11) return null;
  return `${d.slice(0, 2)}-${d.slice(2, 10)}-${d.slice(10)}`;
}

export function cuitValido(texto) {
  const d = String(texto || '').replace(/\D/g, '');
  if (d.length !== 11) return false;
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma = pesos.reduce((acc, p, i) => acc + p * Number(d[i]), 0);
  let dv = 11 - (suma % 11);
  if (dv === 11) dv = 0;
  if (dv === 10) dv = 9;
  return dv === Number(d[10]);
}

// ---------- Importes ----------
export function premioDeItem(it) {
  const subtotal = Number(it.prima || 0) + Number(it.gastos_notariales || 0);
  return round2(subtotal + Number(it.impuestos || 0) + Number(it.perc_iibb || 0) +
                Number(it.iva || 0) + Number(it.iva_rg || 0));
}

export function sugerirImportes(sumaAsegurada, primaMinima = 0) {
  const prima = round2(Math.max(sumaAsegurada * ALICUOTA_PRIMA, primaMinima));
  return {
    prima,
    impuestos: round2(prima * TASA_IMPUESTOS),
    iva: round2(prima * TASA_IVA),
  };
}

export function sumar(items, campo) {
  return round2(items.reduce((acc, it) => acc + Number(it[campo] || 0), 0));
}

// Devuelve [{nivel: 'error'|'aviso', texto}]
export function validarItem(it) {
  const res = [];
  const subtotal = Number(it.prima || 0) + Number(it.gastos_notariales || 0);
  const premioEsperado = premioDeItem(it);
  if (Math.abs(premioEsperado - Number(it.premio || 0)) > TOLERANCIA) {
    res.push({ nivel: 'error', texto: `El premio debería ser ${money(premioEsperado)} (subtotal + impuestos + IVA).` });
  }
  const ivaEsperado = round2(subtotal * TASA_IVA);
  if (Math.abs(ivaEsperado - Number(it.iva || 0)) > 1) {
    res.push({ nivel: 'aviso', texto: `El IVA no es el 21 % del subtotal (se esperaba ${money(ivaEsperado)}).` });
  }
  if (Number(it.prima || 0) + TOLERANCIA < round2(Number(it.suma_asegurada || 0) * ALICUOTA_PRIMA)) {
    res.push({ nivel: 'aviso', texto: 'La prima es menor al 1 ‰ de la suma asegurada.' });
  }
  if (it.vigencia_desde && it.vigencia_hasta && it.vigencia_hasta < it.vigencia_desde) {
    res.push({ nivel: 'error', texto: 'La vigencia termina antes de empezar.' });
  }
  return res;
}

// ---------- Importe en letras ----------
const UNIDADES = ['', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve',
  'diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho',
  'diecinueve', 'veinte', 'veintiuno', 'veintidós', 'veintitrés', 'veinticuatro', 'veinticinco',
  'veintiséis', 'veintisiete', 'veintiocho', 'veintinueve'];
const DECENAS = ['', '', '', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
const CENTENAS = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos',
  'seiscientos', 'setecientos', 'ochocientos', 'novecientos'];

function menorMil(n) {
  if (n === 0) return '';
  if (n === 100) return 'cien';
  const c = Math.floor(n / 100), r = n % 100;
  let s = CENTENAS[c];
  if (r) {
    const dec = r < 30 ? UNIDADES[r] : DECENAS[Math.floor(r / 10)] + (r % 10 ? ' y ' + UNIDADES[r % 10] : '');
    s += (s ? ' ' : '') + dec;
  }
  return s;
}

const apocope = (s) => s.replace(/veintiuno$/, 'veintiún').replace(/uno$/, 'un');

function enteroALetras(n) {
  if (n === 0) return 'cero';
  const millones = Math.floor(n / 1e6), miles = Math.floor((n % 1e6) / 1000), resto = n % 1000;
  const partes = [];
  if (millones) partes.push(millones === 1 ? 'un millón' : `${apocope(enteroALetras(millones))} millones`);
  if (miles) partes.push(miles === 1 ? 'mil' : `${apocope(menorMil(miles))} mil`);
  if (resto) partes.push(menorMil(resto));
  return partes.join(' ');
}

export function numeroALetras(valor) {
  const total = round2(valor);
  const pesos = Math.floor(total);
  const centavos = Math.round((total - pesos) * 100);
  const textoPesos = pesos === 1 ? 'un peso' : `${apocope(enteroALetras(pesos))} pesos`;
  const textoCentavos = centavos === 1 ? 'un centavo' : `${apocope(enteroALetras(centavos))} centavos`;
  return `${textoPesos} con ${textoCentavos}`.toUpperCase();
}
