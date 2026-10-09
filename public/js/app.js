import {
  money, round2, fmtFecha, comprobante,
  sumar, validarItem, TOLERANCIA,
} from './calc.js';
import { leerArchivoPdf, armarPayload } from './pdf-factura.js';

const app = document.getElementById('app');
const nav = document.getElementById('nav');
const cfg = window.APP_CONFIG;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const aviso = (tipo, html) => `<div class="aviso ${tipo}" role="${tipo === 'error' ? 'alert' : 'status'}">${html}</div>`;

if (!cfg?.SUPABASE_URL || !cfg?.SUPABASE_ANON_KEY) {
  app.innerHTML = aviso('error', 'Falta la configuración de Supabase. Generá <code>public/js/config.js</code> con <code>npm run config</code> (ver README).');
  throw new Error('Sin configuración');
}

const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

// ---------- Utilidades de datos ----------
function traducirError(error) {
  const m = error.message || '';
  if (error.code === '23505') return 'Ya existe un registro con esos datos (por ejemplo, el mismo comprobante o la misma razón social).';
  if (error.code === '42501' || m.includes('row-level security') || m.includes('permission denied')) return 'La app permite ver y cargar facturas nuevas, pero no modificar ni eliminar lo que ya está cargado.';
  if (m.includes('ya tiene su PDF archivado')) return 'Esta factura ya tiene su PDF archivado.';
  if (m.includes('no es un PDF')) return 'El archivo no es un PDF válido.';
  if (m.includes('5 MB')) return 'El PDF supera los 5 MB permitidos.';
  if (m.includes('premio_cuadra')) return 'Hay una póliza cuyo premio no coincide con subtotal + impuestos + IVA. Revisá los importes.';
  if (m.includes('vigencia_valida')) return 'Hay una póliza con vigencia "hasta" anterior a "desde".';
  if (m.includes('entidades_cuit_check')) return 'El CUIT debe tener el formato 30-12345678-9.';
  return m || 'Ocurrió un error inesperado.';
}

async function q(consulta) {
  const { data, error } = await consulta;
  if (error) throw new Error(traducirError(error));
  return data;
}

function iniciar() {
  nav.hidden = false;
  window.addEventListener('hashchange', router);
  router();
}

async function router() {
  const [ruta = 'facturas', id] = location.hash.replace(/^#\/?/, '').split('/');
  const seccion = ruta === 'factura' ? 'facturas' : ruta;
  nav.querySelectorAll('a').forEach((a) => {
    if (a.dataset.ruta === seccion) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  app.innerHTML = '<p class="cargando">Cargando…</p>';
  try {
    if (ruta === 'factura' && id) await vistaDetalle(id);
    else if (ruta === 'importar') await vistaImportar();
    else if (ruta === 'entidades') await vistaEntidades();
    else await vistaFacturas();
    window.scrollTo(0, 0);
  } catch (err) {
    app.innerHTML = aviso('error', esc(err.message));
  }
}

// ---------- Instalación en escritorio y celular ----------
const botonInstalar = document.getElementById('instalar');
const ayudaIos = document.getElementById('ayuda-ios');
const enModoApp = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
const esIos = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let eventoInstalacion = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  eventoInstalacion = e;
  botonInstalar.hidden = false;
});
window.addEventListener('appinstalled', () => { botonInstalar.hidden = true; eventoInstalacion = null; });
if (esIos && !enModoApp) botonInstalar.hidden = false;

botonInstalar.addEventListener('click', async () => {
  if (eventoInstalacion) {
    eventoInstalacion.prompt();
    await eventoInstalacion.userChoice;
    eventoInstalacion = null;
    botonInstalar.hidden = true;
  } else if (esIos) {
    ayudaIos.showModal();
  }
});
document.getElementById('cerrar-ayuda').addEventListener('click', () => ayudaIos.close());

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

iniciar();

// Convierte un archivo en base64 (sin el prefijo data:)
const aBase64 = (archivo) => new Promise((ok, mal) => {
  const lector = new FileReader();
  lector.onload = () => ok(String(lector.result).split(',')[1]);
  lector.onerror = () => mal(new Error('No se pudo leer el archivo.'));
  lector.readAsDataURL(archivo);
});

// Agrega el PDF original a una factura que todavía no lo tiene
async function archivarPdf(facturaId, archivo) {
  if (archivo.size > 5 * 1024 * 1024) throw new Error('El PDF supera los 5 MB permitidos.');
  await q(sb.rpc('archivar_pdf', { p_factura_id: facturaId, p_nombre: archivo.name, p_base64: await aBase64(archivo) }));
}


// ---------- Formatos de fecha legibles ----------
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
  'septiembre', 'octubre', 'noviembre', 'diciembre'];
const partesFecha = (iso) => String(iso).slice(0, 10).split('-').map(Number);
const fechaLarga = (iso) => { const [a, m, d] = partesFecha(iso); return `${d} de ${MESES[m - 1]} de ${a}`; };
const mesAnio = (iso) => { const [a, m] = partesFecha(iso); return `${MESES[m - 1][0].toUpperCase()}${MESES[m - 1].slice(1)} ${a}`; };
const fechaCorta = (iso) => { const [, m, d] = partesFecha(iso); return `${d}/${m}`; };
const periodo = (desde, hasta) => `del ${fechaCorta(desde)} al ${fmtFecha(hasta)}`;
const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;

// Agrupa las pólizas por obra: mismo organismo y mismo contrato (objeto)
const claveObra = (it) => `${it.poliza.asegurado.razon_social}|${(it.poliza.objeto || '').toUpperCase().replace(/[^A-Z0-9]/g, '')}`;

// ---------- Listado de facturas ----------
async function vistaFacturas() {
  const facturas = await q(sb.from('facturas')
    .select('id, tipo, punto_venta, numero, fecha, premio_total, emisor:entidades!facturas_emisor_id_fkey(razon_social), cliente:entidades!facturas_cliente_id_fkey(razon_social), items:factura_items(count)')
    .order('fecha', { ascending: false }));

  if (!facturas.length) {
    app.innerHTML = `
      <h1>Facturas</h1>
      <div class="vacio"><p>Todavía no hay facturas cargadas.</p><a class="boton" href="#/importar">Importar PDF</a></div>`;
    return;
  }

  app.innerHTML = `
    <div class="encabezado">
      <div>
        <h1>Facturas</h1>
        <p class="bajada">Abrí una factura para revisar, obra por obra, qué pólizas se están cobrando.</p>
      </div>
    </div>
    <ul class="lista-facturas">
      ${facturas.map((f) => {
        const cantidad = f.items?.[0]?.count ?? 0;
        return `<li>
          <a class="fila-factura" href="#/factura/${f.id}">
            <span class="fila-factura-mes">${mesAnio(f.fecha)}</span>
            <span class="fila-factura-detalle">
              ${esc(f.emisor.razon_social)}
              <span class="secundario-texto">Factura ${esc(comprobante(f))} del ${fmtFecha(f.fecha)}, ${plural(cantidad, 'póliza', 'pólizas')}</span>
            </span>
            <span class="fila-factura-total">$ ${money(f.premio_total)}</span>
          </a>
        </li>`;
      }).join('')}
    </ul>`;
}

// ---------- Factura como resumen ----------
async function vistaDetalle(id) {
  const f = await q(sb.from('facturas').select(`
    *,
    emisor:entidades!facturas_emisor_id_fkey(razon_social),
    cliente:entidades!facturas_cliente_id_fkey(razon_social),
    deuda:deuda_snapshots(*),
    items:factura_items(*, poliza:polizas(id, numero, objeto,
      asegurado:entidades!polizas_asegurado_id_fkey(razon_social),
      riesgo:riesgos(ramo, subtipo)))
  `).eq('id', id).single());

  const items = [...f.items].sort((a, b) => a.orden - b.orden);
  const deuda = Array.isArray(f.deuda) ? f.deuda[0] : f.deuda;

  // Historial de cada póliza en todas las facturas cargadas
  const historial = await q(sb.from('factura_items')
    .select('poliza_id, endoso, premio, vigencia_desde, vigencia_hasta, factura:facturas(id, fecha, tipo, punto_venta, numero)')
    .in('poliza_id', items.map((it) => it.poliza.id)));
  const historialDe = (polizaId) => historial
    .filter((h) => h.poliza_id === polizaId)
    .sort((a, b) => String(b.factura.fecha).localeCompare(String(a.factura.fecha)) || b.endoso - a.endoso);

  // Obras
  const obras = [];
  const indice = new Map();
  for (const it of items) {
    const clave = claveObra(it);
    if (!indice.has(clave)) {
      indice.set(clave, obras.length);
      obras.push({ organismo: it.poliza.asegurado.razon_social, objeto: it.poliza.objeto, items: [], total: 0 });
    }
    const obra = obras[indice.get(clave)];
    obra.items.push(it);
    obra.total = round2(obra.total + Number(it.premio));
  }

  // Por tipo de garantía
  const tipos = new Map();
  for (const it of items) {
    const nombre = `${it.poliza.riesgo.subtipo} (${it.poliza.riesgo.ramo})`;
    const t = tipos.get(nombre) || { nombre, cantidad: 0, total: 0 };
    t.cantidad += 1;
    t.total = round2(t.total + Number(it.premio));
    tipos.set(nombre, t);
  }
  const listaTipos = [...tipos.values()].sort((a, b) => b.total - a.total);
  const maxTipo = Math.max(...listaTipos.map((t) => t.total));

  // Control de totales: solo se muestra si algo no cuadra
  const sumaItems = sumar(items, 'premio');
  const cuadra = Math.abs(round2(sumaItems + Number(f.otros_gastos)) - Number(f.premio_total)) <= TOLERANCIA;
  const conDiferencias = items.filter((it) => validarItem(it).some((p) => p.nivel === 'error'));

  const desde = items.map((it) => it.vigencia_desde).sort()[0];
  const hasta = items.map((it) => it.vigencia_hasta).sort().slice(-1)[0];

  const cargo = (it) => {
    const hist = historialDe(it.poliza.id);
    const totalHist = round2(hist.reduce((a, h) => a + Number(h.premio), 0));
    return `<li>
      <details class="cargo">
        <summary>
          <span class="cargo-descripcion">
            <strong>${esc(it.poliza.riesgo.subtipo)}</strong>
            <span class="secundario-texto">Póliza ${it.poliza.numero}, endoso ${it.endoso}. Cobertura ${periodo(it.vigencia_desde, it.vigencia_hasta)}</span>
          </span>
          <span class="cargo-monto">$ ${money(it.premio)}</span>
        </summary>
        <div class="cargo-detalle">
          <dl class="desglose">
            <dt>Monto asegurado</dt><dd>$ ${money(it.suma_asegurada)}</dd>
            <dt>Prima</dt><dd>$ ${money(it.prima)}</dd>
            <dt>Impuestos</dt><dd>$ ${money(it.impuestos)}</dd>
            <dt>IVA</dt><dd>$ ${money(Number(it.iva) + Number(it.iva_rg))}</dd>
            <dt class="fuerte">Costo de este período</dt><dd class="fuerte">$ ${money(it.premio)}</dd>
          </dl>
          <div>
            <h4>Cobrada en ${plural(hist.length, 'factura cargada', 'facturas cargadas')}, por $ ${money(totalHist)}</h4>
            <ul class="historial">
              ${hist.map((h) => `<li class="${h.factura.id === f.id ? 'actual' : ''}">
                <a href="#/factura/${h.factura.id}">Factura del ${fmtFecha(h.factura.fecha)}</a>
                <span class="secundario-texto">Endoso ${h.endoso}, ${periodo(h.vigencia_desde, h.vigencia_hasta)}</span>
                <span class="historial-monto">$ ${money(h.premio)}</span>
              </li>`).join('')}
            </ul>
          </div>
        </div>
      </details>
    </li>`;
  };

  const pintarObras = (orden, texto) => {
    const buscado = texto.trim().toUpperCase();
    const lista = obras
      .map((o) => {
        if (!buscado) return o;
        const enObra = `${o.organismo} ${o.objeto || ''}`.toUpperCase().includes(buscado);
        const visibles = enObra ? o.items : o.items.filter((it) => `${it.poliza.numero} ${it.poliza.riesgo.subtipo}`.toUpperCase().includes(buscado));
        return visibles.length ? { ...o, items: visibles, total: sumar(visibles, 'premio') } : null;
      })
      .filter(Boolean)
      .sort(orden === 'importe' ? (a, b) => b.total - a.total : (a, b) => a.organismo.localeCompare(b.organismo, 'es'));
    document.getElementById('obras').innerHTML = lista.length
      ? lista.map((o) => `
        <article class="obra">
          <header class="obra-cabecera">
            <div>
              <h3>${esc(o.organismo)}</h3>
              <p class="secundario-texto">${esc(o.objeto || 'Sin contrato informado')}</p>
            </div>
            <p class="obra-total">$ ${money(o.total)}<span class="secundario-texto">${plural(o.items.length, 'póliza', 'pólizas')}</span></p>
          </header>
          <ul class="cargos">${o.items.map(cargo).join('')}</ul>
        </article>`).join('')
      : '<div class="vacio"><p>Ninguna póliza coincide con la búsqueda.</p></div>';
  };

  app.innerHTML = `
    <a href="#/facturas" class="volver">Todas las facturas</a>

    <section class="resumen" aria-labelledby="total-factura">
      <div class="resumen-principal">
        <p class="resumen-emisor">${esc(f.emisor.razon_social)}</p>
        <p class="resumen-total" id="total-factura">$ ${money(f.premio_total)}</p>
        <p class="resumen-texto">Total de la factura del ${fechaLarga(f.fecha)} a ${esc(f.cliente.razon_social)}.
          ${plural(items.length, 'póliza', 'pólizas')} en ${plural(obras.length, 'obra', 'obras')}, con cobertura ${periodo(desde, hasta)}.</p>
      </div>
      <dl class="resumen-datos">
        <div><dt>Comprobante</dt><dd>${esc(comprobante(f))}</dd></div>
        ${f.cae ? `<div><dt>CAE</dt><dd>${esc(f.cae)}</dd></div>` : ''}
        ${deuda ? `<div><dt>Deuda vencida con la aseguradora</dt><dd>$ ${money(deuda.vencido)}</dd></div>
                   <div><dt>Deuda total al emitir la factura</dt><dd>$ ${money(deuda.total)}</dd></div>` : ''}
      </dl>
      ${f.pdf_path ? '<button type="button" class="boton claro" id="ver-pdf">Ver factura original</button>' : ''}
    </section>
    <div id="msg-estado"></div>

    ${!cuadra || conDiferencias.length ? aviso('advertencia',
      `Revisá esta factura con el PDF original: ${!cuadra ? `las pólizas suman $ ${money(sumaItems)} y el total impreso es $ ${money(f.premio_total)}.` : ''}
       ${conDiferencias.length ? `Hay ${plural(conDiferencias.length, 'póliza', 'pólizas')} cuyo importe no coincide con su desglose.` : ''}`) : ''}

    <h2>En qué se va el total</h2>
    <ul class="tipos">
      ${listaTipos.map((t) => `<li>
        <span class="tipo-nombre">${esc(t.nombre)}<span class="secundario-texto">${plural(t.cantidad, 'póliza', 'pólizas')}</span></span>
        <span class="tipo-barra" aria-hidden="true"><span style="width:${Math.max(2, (t.total / maxTipo) * 100)}%"></span></span>
        <span class="tipo-monto">$ ${money(t.total)}</span>
      </li>`).join('')}
    </ul>

    <div class="encabezado encabezado-obras">
      <h2>Pólizas por obra</h2>
      <div class="filtros">
        <label class="buscar">Buscar <input type="search" id="buscar" placeholder="Organismo, contrato o número de póliza"></label>
        <label>Ordenar
          <select id="orden"><option value="importe">Mayor importe</option><option value="organismo">Organismo (A-Z)</option></select>
        </label>
      </div>
    </div>
    <div id="obras"></div>`;

  const buscar = document.getElementById('buscar');
  const orden = document.getElementById('orden');
  const repintar = () => pintarObras(orden.value, buscar.value);
  buscar.addEventListener('input', repintar);
  orden.addEventListener('change', repintar);
  repintar();

  document.getElementById('ver-pdf')?.addEventListener('click', async () => {
    const ventana = window.open('', '_blank');
    try {
      const fila = await q(sb.from('factura_pdfs').select('contenido_base64').eq('factura_id', f.id).single());
      const bytes = Uint8Array.from(atob(fila.contenido_base64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      if (ventana) ventana.location = url; else location.href = url;
    } catch {
      ventana?.close();
      document.getElementById('msg-estado').innerHTML = aviso('error', 'No se pudo abrir el PDF original.');
    }
  });
}

// ---------- Entidades y productores ----------
async function vistaEntidades() {
  const [entidades, productores] = await Promise.all([
    q(sb.from('entidades').select('*').order('razon_social')),
    q(sb.from('productores').select('*').order('nombre')),
  ]);
  app.innerHTML = `
    <h1>Organismos y empresas</h1>
    <p class="bajada">Aseguradoras, clientes y organismos comitentes que figuran en las facturas.</p>
    <div class="tabla-scroll"><table>
      <thead><tr><th>Razón social</th><th>CUIT</th><th>Ubicación</th><th>Condición IVA</th></tr></thead>
      <tbody>${entidades.map((e) => `<tr>
        <td>${esc(e.razon_social)}</td>
        <td>${e.cuit ? esc(e.cuit) : '<span class="secundario-texto">Sin cargar</span>'}</td>
        <td>${esc([e.localidad, e.provincia].filter(Boolean).join(', '))}</td>
        <td>${esc(e.condicion_iva || '')}</td></tr>`).join('')}</tbody>
    </table></div>

    <h2>Productores</h2>
    <p class="bajada">${productores.map((p) => esc(p.nombre)).join('; ') || 'Sin productores cargados.'}</p>
`;
}


// ---------- Importación de PDF ----------
async function vistaImportar() {
  const entidades = await q(sb.from('entidades').select('razon_social, cuit'));
  const conocidas = new Set(entidades.map((e) => e.razon_social.trim().toUpperCase()));
  const conCuit = new Set(entidades.filter((e) => e.cuit).map((e) => e.razon_social.trim().toUpperCase()));

  app.innerHTML = `
    <h1>Importar facturas en PDF</h1>
    <p class="bajada">Elegí uno o varios PDF tal como los envía la aseguradora. La app lee los datos,
      controla que los importes cuadren y te muestra un resumen antes de guardar. El PDF original queda archivado con la factura.</p>
    <label class="zona-pdf" id="zona">
      <input type="file" id="archivos" accept="application/pdf,.pdf" multiple>
      <strong>Elegir archivos PDF</strong>
      <span>o arrastralos a este recuadro</span>
    </label>
    <div class="acciones" id="acciones-lote" hidden>
      <button type="button" class="boton" id="guardar-todas">Guardar todas las listas</button>
    </div>
    <div id="lecturas"></div>`;

  const lecturas = [];
  const zona = document.getElementById('zona');
  const contenedor = document.getElementById('lecturas');
  const lote = document.getElementById('acciones-lote');

  const actualizarLote = () => {
    lote.hidden = lecturas.filter((l) => l.estado === 'lista').length < 2;
  };

  const procesar = async (archivos) => {
    for (const archivo of archivos) {
      if (!/\.pdf$/i.test(archivo.name) && archivo.type !== 'application/pdf') continue;
      const lectura = { archivo, estado: 'leyendo', el: document.createElement('article') };
      lectura.el.className = 'lectura';
      lectura.el.innerHTML = `<p class="cargando">Leyendo ${esc(archivo.name)}…</p>`;
      contenedor.prepend(lectura.el);
      lecturas.push(lectura);
      try {
        lectura.f = await leerArchivoPdf(archivo);
        // El aviso de CUIT incompleto solo sirve mientras no esté cargado en Entidades
        const tieneCuit = (e) => conCuit.has((e.razon_social || '').trim().toUpperCase());
        lectura.f.avisos = lectura.f.avisos.filter((t) =>
          !(t.startsWith('El CUIT de la aseguradora') && tieneCuit(lectura.f.emisor)) &&
          !(t.startsWith('El CUIT del cliente') && tieneCuit(lectura.f.cliente)));
        const previas = await q(sb.from('facturas')
          .select('id, pdf_path, emisor:entidades!facturas_emisor_id_fkey(razon_social)')
          .eq('tipo', lectura.f.tipo).eq('punto_venta', lectura.f.punto_venta).eq('numero', lectura.f.numero));
        const nombreEmisor = (lectura.f.emisor.razon_social || '').trim().toUpperCase();
        lectura.existente = previas.find((x) => x.emisor.razon_social.trim().toUpperCase() === nombreEmisor);
        lectura.estado = lectura.existente ? 'duplicada' : lectura.f.errores.length ? 'con-errores' : 'lista';
      } catch (err) {
        lectura.estado = 'ilegible';
        lectura.error = err.message;
      }
      pintar(lectura);
    }
    actualizarLote();
  };

  const pintar = (l) => {
    if (l.estado === 'ilegible') {
      l.el.innerHTML = `<h3>${esc(l.archivo.name)}</h3>
        ${aviso('error', `No se pudo leer este PDF. ${esc(l.error)} Verificá que sea una factura de la aseguradora, tal como llega por correo.`)}`;
      return;
    }
    const f = l.f;
    const nuevas = [f.emisor.razon_social, f.cliente.razon_social, ...new Set(f.items.map((it) => it.asegurado))]
      .filter((n) => n && !conocidas.has(n.trim().toUpperCase()));
    const chip = {
      lista: '<span class="chip ok">Lista para guardar</span>',
      'con-errores': '<span class="chip error">No cuadra</span>',
      duplicada: '<span class="chip pendiente">Ya estaba cargada</span>',
      guardando: '<span class="chip pendiente">Guardando…</span>',
      guardada: '<span class="chip ok">Guardada</span>',
      adjuntado: '<span class="chip ok">PDF archivado</span>',
    }[l.estado];

    l.el.innerHTML = `
      <div class="lectura-cabecera">
        <div>
          <h3>Factura ${esc(comprobante(f))} ${chip}</h3>
          <p class="secundario-texto">${esc(l.archivo.name)}</p>
        </div>
        <p class="lectura-total">$ ${money(f.totales.premio_total)}</p>
      </div>
      <p class="lectura-meta">Emitida el ${fmtFecha(f.fecha)} por ${esc(f.emisor.razon_social)} a ${esc(f.cliente.razon_social)}.
        ${f.items.length} pólizas, que suman $ ${money(f.suma_items)}${f.cuadra ? ' y coinciden con el total impreso.' : '.'}</p>
      ${l.estado === 'guardada' ? aviso('ok', `Factura guardada. <a href="#/factura/${l.id}">Ver la factura</a>`) : ''}
      ${l.estado === 'duplicada' ? aviso('advertencia', `Esta factura ya está en el sistema. <a href="#/factura/${l.existente.id}">Ver la factura cargada</a>
        ${l.existente.pdf_path ? '' : '<br>Todavía no tiene el PDF original archivado. <button type="button" class="enlace" style="color:inherit;text-decoration:underline" data-adjuntar>Archivar este PDF en esa factura</button>'}`) : ''}
      ${l.estado === 'adjuntado' ? aviso('ok', `PDF archivado en la factura. <a href="#/factura/${l.existente.id}">Ver la factura</a>`) : ''}
      ${l.errorGuardado ? aviso('error', esc(l.errorGuardado)) : ''}
      ${f.errores.length ? aviso('error', `No se puede guardar porque los datos leídos no cuadran:<ul>${f.errores.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`) : ''}
      ${f.avisos.length ? aviso('advertencia', `<ul>${f.avisos.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`) : ''}
      ${nuevas.length && l.estado === 'lista' ? `<p class="lectura-meta">Se van a dar de alta ${nuevas.length === 1 ? 'una entidad nueva' : `${nuevas.length} entidades nuevas`}: ${nuevas.map(esc).join('; ')}.</p>` : ''}
      <details>
        <summary>Ver las ${f.items.length} pólizas leídas</summary>
        <div class="tabla-scroll">
          <table>
            <thead><tr><th>Póliza / endoso</th><th>Vigencia</th><th>Asegurado y riesgo</th>
              <th class="num">Suma asegurada</th><th class="num">Prima</th><th class="num">Premio</th></tr></thead>
            <tbody>${f.items.map((it) => `<tr>
              <td>${it.poliza_numero}<span class="secundario-texto">Endoso ${it.endoso ?? '?'}</span></td>
              <td>${fmtFecha(it.vigencia_desde)}<span class="secundario-texto">al ${fmtFecha(it.vigencia_hasta)}</span></td>
              <td class="col-texto">${esc(it.asegurado)}<span class="secundario-texto">${esc(it.ramo)}, ${esc(it.subtipo)}</span>
                <span class="secundario-texto">${esc(it.objeto)}</span></td>
              <td class="num">${money(it.suma_asegurada)}</td>
              <td class="num">${money(it.prima)}</td>
              <td class="num">${money(it.premio)}</td></tr>`).join('')}</tbody>
          </table>
        </div>
      </details>
      ${l.estado === 'lista' ? '<div class="acciones"><button type="button" class="boton" data-guardar>Guardar factura</button></div>' : ''}`;
    l.el.querySelector('[data-guardar]')?.addEventListener('click', () => guardar(l));
    l.el.querySelector('[data-adjuntar]')?.addEventListener('click', () => adjuntar(l));
  };

  const adjuntar = async (l) => {
    try {
      await archivarPdf(l.existente.id, l.archivo);
      l.estado = 'adjuntado';
      l.errorGuardado = null;
    } catch (err) {
      l.errorGuardado = err.message;
    }
    pintar(l);
  };

  const guardar = async (l) => {
    if (l.estado !== 'lista') return;
    l.estado = 'guardando';
    l.errorGuardado = null;
    pintar(l);
    const f = l.f;
    try {
      if (l.archivo.size > 5 * 1024 * 1024) throw new Error('El PDF supera los 5 MB permitidos.');
      const payload = { ...armarPayload(f, null), pdf: { nombre: l.archivo.name, base64: await aBase64(l.archivo) } };
      l.id = await q(sb.rpc('importar_factura', { p: payload }));
      l.estado = 'guardada';
      [f.emisor.razon_social, f.cliente.razon_social, ...f.items.map((it) => it.asegurado)]
        .forEach((n) => n && conocidas.add(n.trim().toUpperCase()));
    } catch (err) {
      l.estado = 'lista';
      l.errorGuardado = err.message;
    }
    pintar(l);
    actualizarLote();
  };

  document.getElementById('archivos').addEventListener('change', (e) => { procesar([...e.target.files]); e.target.value = ''; });
  document.getElementById('guardar-todas').addEventListener('click', async (e) => {
    e.target.disabled = true;
    for (const l of lecturas.filter((x) => x.estado === 'lista')) await guardar(l);
    e.target.disabled = false;
  });
  ['dragenter', 'dragover'].forEach((ev) => zona.addEventListener(ev, (e) => { e.preventDefault(); zona.classList.add('arrastrando'); }));
  ['dragleave', 'drop'].forEach((ev) => zona.addEventListener(ev, (e) => { e.preventDefault(); zona.classList.remove('arrastrando'); }));
  zona.addEventListener('drop', (e) => procesar([...e.dataTransfer.files]));
}
