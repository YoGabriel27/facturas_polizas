import {
  money, round2, parseAR, fmtFecha, comprobante, numeroALetras,
  premioDeItem, sugerirImportes, sumar, validarItem, normalizarCuit, cuitValido, TOLERANCIA,
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

// ---------- Acceso por enlace ----------
// El enlace trae la clave como ?acceso=...; se guarda en este navegador y se
// quita de la barra de direcciones para que no quede a la vista.
const PARAM_ACCESO = 'acceso';

function obtenerClave() {
  const url = new URL(location.href);
  const delEnlace = url.searchParams.get(PARAM_ACCESO);
  if (delEnlace) {
    try { localStorage.setItem(PARAM_ACCESO, delEnlace); } catch { /* navegación privada */ }
    url.searchParams.delete(PARAM_ACCESO);
    history.replaceState(null, '', url.pathname + url.search + url.hash);
    return delEnlace;
  }
  try { return localStorage.getItem(PARAM_ACCESO); } catch { return null; }
}

const clave = obtenerClave();
const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
  global: { headers: { 'x-acceso': clave || '' } },
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

// ---------- Utilidades de datos ----------
function traducirError(error) {
  const m = error.message || '';
  if (error.code === '23505') return 'Ya existe un registro con esos datos (por ejemplo, el mismo comprobante o la misma razón social).';
  if (error.code === '42501' || m.includes('row-level security')) return 'El enlace de acceso ya no es válido. Pedí uno nuevo a quien administra las facturas.';
  if (m.includes('premio_cuadra')) return 'Hay una póliza cuyo premio no coincide con subtotal + impuestos + IVA. Revisá los importes.';
  if (m.includes('vigencia_valida')) return 'Hay una póliza con vigencia "hasta" anterior a "desde".';
  if (m.includes('entidades_cuit_check')) return 'El CUIT debe tener el formato 30-12345678-9.';
  if (m.includes('factura_pdfs_bytes_check')) return 'El PDF supera los 5 MB permitidos.';
  return m || 'Ocurrió un error inesperado.';
}

async function q(consulta) {
  const { data, error } = await consulta;
  if (error) throw new Error(traducirError(error));
  return data;
}

function sinAcceso(titulo, texto) {
  nav.hidden = true;
  app.innerHTML = `
    <section class="login">
      <h1>${esc(titulo)}</h1>
      <p class="bajada">${esc(texto)}</p>
    </section>`;
}

async function iniciar() {
  if (!clave) {
    return sinAcceso('Se necesita el enlace de acceso',
      'Esta app se abre con el enlace que te compartieron. Pedíselo a quien administra las facturas.');
  }
  const { data, error } = await sb.rpc('acceso_valido');
  if (error || !data) {
    try { localStorage.removeItem(PARAM_ACCESO); } catch { /* sin almacenamiento */ }
    return sinAcceso('El enlace no es válido',
      'Puede que esté incompleto o que lo hayan dado de baja. Pedí un enlace nuevo a quien administra las facturas.');
  }
  nav.hidden = false;
  window.addEventListener('hashchange', router);
  router();
}

async function router() {
  const [ruta = 'facturas', id] = location.hash.replace(/^#\/?/, '').split('/');
  nav.querySelectorAll('a').forEach((a) => {
    if (a.dataset.ruta === ruta) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  app.innerHTML = '<p class="cargando">Cargando…</p>';
  try {
    if (ruta === 'factura' && id) await vistaDetalle(id);
    else if (ruta === 'importar') await vistaImportar();
    else if (ruta === 'nueva') await vistaNueva();
    else if (ruta === 'vencimientos') await vistaVencimientos();
    else if (ruta === 'entidades') await vistaEntidades();
    else await vistaFacturas();
  } catch (err) {
    app.innerHTML = aviso('error', esc(err.message));
  }
}

iniciar();

// Convierte un archivo en base64 (sin el prefijo data:)
const aBase64 = (archivo) => new Promise((ok, mal) => {
  const lector = new FileReader();
  lector.onload = () => ok(String(lector.result).split(',')[1]);
  lector.onerror = () => mal(new Error('No se pudo leer el archivo.'));
  lector.readAsDataURL(archivo);
});

// Guarda el PDF original junto a la factura (reemplaza uno anterior si lo había)
async function archivarPdf(facturaId, archivo) {
  if (archivo.size > 5 * 1024 * 1024) throw new Error('El PDF supera los 5 MB permitidos.');
  await q(sb.from('factura_pdfs').upsert({
    factura_id: facturaId, nombre: archivo.name, contenido_base64: await aBase64(archivo), bytes: archivo.size,
  }));
  await q(sb.from('facturas').update({ pdf_path: archivo.name }).eq('id', facturaId));
}

// ---------- Listado de facturas ----------
async function vistaFacturas() {
  const filas = await q(sb.from('v_facturas_resumen').select('*').order('fecha', { ascending: false }));
  const pendiente = filas.filter((f) => f.estado === 'pendiente').reduce((a, f) => a + Number(f.premio_total), 0);

  if (!filas.length) {
    app.innerHTML = `
      <h1>Facturas</h1>
      <div class="vacio"><p>Todavía no hay facturas cargadas.</p><a class="boton" href="#/importar">Importar PDF</a></div>`;
    return;
  }

  app.innerHTML = `
    <div class="encabezado">
      <div>
        <h1>Facturas</h1>
        <p class="bajada">${filas.length} comprobantes. Pendiente de pago: <strong>$ ${money(pendiente)}</strong></p>
      </div>
      <a class="boton" href="#/importar">Importar PDF</a>
    </div>
    <div class="tabla-scroll">
      <table>
        <thead><tr>
          <th>Comprobante</th><th>Fecha</th><th>Cliente</th><th class="num">Pólizas</th>
          <th class="num">Premio total</th><th>Estado</th><th>Control</th>
        </tr></thead>
        <tbody>
          ${filas.map((f) => {
            const cuadra = Math.abs(Number(f.diferencia)) <= TOLERANCIA;
            return `<tr class="fila-enlace" data-id="${f.id}">
              <td><a href="#/factura/${f.id}">${esc(comprobante(f))}</a></td>
              <td>${fmtFecha(f.fecha)}</td>
              <td>${esc(f.cliente)}</td>
              <td class="num">${f.cantidad_items}</td>
              <td class="num">$ ${money(f.premio_total)}</td>
              <td><span class="chip ${f.estado}">${esc(f.estado)}</span></td>
              <td>${cuadra ? '<span class="chip ok">Cuadra</span>'
                           : `<span class="chip error">Difiere $ ${money(f.diferencia)}</span>`}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
  app.querySelectorAll('tr.fila-enlace').forEach((tr) =>
    tr.addEventListener('click', (e) => { if (e.target.tagName !== 'A') location.hash = `#/factura/${tr.dataset.id}`; }));
}

// ---------- Detalle de factura ----------
async function vistaDetalle(id) {
  const f = await q(sb.from('facturas').select(`
    *,
    emisor:entidades!facturas_emisor_id_fkey(*),
    cliente:entidades!facturas_cliente_id_fkey(*),
    productor:productores(nombre),
    deuda:deuda_snapshots(*),
    items:factura_items(*, poliza:polizas(numero, objeto,
      asegurado:entidades!polizas_asegurado_id_fkey(razon_social),
      riesgo:riesgos(ramo, subtipo)))
  `).eq('id', id).single());

  const items = [...f.items].sort((a, b) => a.orden - b.orden);
  const deuda = Array.isArray(f.deuda) ? f.deuda[0] : f.deuda;

  // Controles
  const problemas = [];
  items.forEach((it) => validarItem(it).forEach((p) =>
    problemas.push({ ...p, texto: `Póliza ${it.poliza.numero}: ${p.texto}` })));
  const premioItems = sumar(items, 'premio');
  const esperado = round2(premioItems + Number(f.otros_gastos));
  if (Math.abs(esperado - Number(f.premio_total)) > TOLERANCIA) {
    problemas.push({ nivel: 'error', texto: `El premio total impreso ($ ${money(f.premio_total)}) no coincide con la suma de las pólizas ($ ${money(esperado)}).` });
  }
  if (deuda && Math.abs(Number(deuda.vencido) + Number(deuda.a_vencer) - Number(deuda.total)) > 1) {
    problemas.push({ nivel: 'aviso', texto: 'En la deuda informada, vencido + a vencer no da el total (puede ser por redondeo de la aseguradora).' });
  }
  const errores = problemas.filter((p) => p.nivel === 'error');
  const resumenControl = problemas.length
    ? aviso(errores.length ? 'error' : 'advertencia',
        `${errores.length ? 'La factura tiene diferencias.' : 'La factura cuadra, con observaciones.'}
         <ul>${problemas.map((p) => `<li>${esc(p.texto)}</li>`).join('')}</ul>`)
    : aviso('ok', `Las ${items.length} pólizas suman exactamente el premio total.`);

  const parte = (rol, e, extra = '') => `
    <div class="parte">
      <div class="rol">${rol}</div>
      <h3>${esc(e.razon_social)}</h3>
      <p>${esc([e.domicilio, e.localidad, e.codigo_postal && `CP ${e.codigo_postal}`, e.provincia].filter(Boolean).join(', '))}</p>
      <p>CUIT ${esc(e.cuit || 'sin cargar')}${e.condicion_iva ? `, ${esc(e.condicion_iva)}` : ''}</p>
      ${extra}
    </div>`;

  app.innerHTML = `
    <a href="#/facturas">Volver a facturas</a>
    <p class="comprobante-numero">Factura ${esc(comprobante(f))}</p>
    <div class="comprobante-meta">
      <span>Emitida el ${fmtFecha(f.fecha)}</span>
      <span class="chip ${f.estado}">${esc(f.estado)}${f.fecha_pago ? ` el ${fmtFecha(f.fecha_pago)}` : ''}</span>
      ${f.cae ? `<span>CAE ${esc(f.cae)}, vence ${fmtFecha(f.cae_vencimiento)}</span>` : ''}
      ${f.pdf_path ? '<button type="button" class="boton secundario" id="ver-pdf">Ver PDF original</button>' : ''}
    </div>

    ${resumenControl}

    <div class="partes">
      ${parte('Emisor', f.emisor, f.emisor.ingresos_brutos ? `<p>IIBB ${esc(f.emisor.ingresos_brutos)}</p>` : '')}
      ${parte('Cliente', f.cliente, `${f.cliente.codigo_cliente ? `<p>Código de cliente ${esc(f.cliente.codigo_cliente)}</p>` : ''}
                                     ${f.productor ? `<p>Productor: ${esc(f.productor.nombre)}</p>` : ''}`)}
    </div>

    <h2>Pólizas facturadas</h2>
    <div class="tabla-scroll">
      <table>
        <thead><tr>
          <th>Póliza / endoso</th><th>Vigencia</th><th>Asegurado y riesgo</th>
          <th class="num">Suma asegurada</th><th class="num">Prima</th><th class="num">Impuestos</th>
          <th class="num">IVA</th><th class="num">Premio</th><th>Control</th>
        </tr></thead>
        <tbody>
          ${items.map((it) => {
            const obs = validarItem(it);
            return `<tr>
              <td>${it.poliza.numero}<span class="secundario-texto">Endoso ${it.endoso}</span></td>
              <td>${fmtFecha(it.vigencia_desde)}<span class="secundario-texto">al ${fmtFecha(it.vigencia_hasta)}</span></td>
              <td class="col-texto">${esc(it.poliza.asegurado.razon_social)}
                <span class="secundario-texto">${esc(it.poliza.riesgo.ramo)}, ${esc(it.poliza.riesgo.subtipo)}</span>
                <span class="secundario-texto">${esc(it.poliza.objeto || '')}</span></td>
              <td class="num">${money(it.suma_asegurada)}</td>
              <td class="num">${money(it.prima)}</td>
              <td class="num">${money(it.impuestos)}</td>
              <td class="num">${money(it.iva)}</td>
              <td class="num"><strong>${money(it.premio)}</strong></td>
              <td>${obs.length
                ? `<span class="chip ${obs.some((o) => o.nivel === 'error') ? 'error' : 'pendiente'}" title="${esc(obs.map((o) => o.texto).join(' '))}">Revisar</span>`
                : '<span class="chip ok">Cuadra</span>'}</td>
            </tr>`;
          }).join('')}
        </tbody>
        <tfoot><tr>
          <td colspan="3">Totales</td>
          <td class="num">${money(sumar(items, 'suma_asegurada'))}</td>
          <td class="num">${money(sumar(items, 'prima'))}</td>
          <td class="num">${money(sumar(items, 'impuestos'))}</td>
          <td class="num">${money(sumar(items, 'iva'))}</td>
          <td class="num">${money(premioItems)}</td>
          <td></td>
        </tr></tfoot>
      </table>
    </div>

    <section class="cheque" aria-label="Totales de la factura">
      <div>
        <h3>Premio total</h3>
        <p class="monto-total">$ ${money(f.premio_total)}</p>
        <p class="letras">${esc(numeroALetras(f.premio_total))}</p>
      </div>
      <dl>
        <dt>Prima</dt><dd>${money(f.prima)}</dd>
        <dt>Gastos notariales</dt><dd>${money(f.gastos_notariales)}</dd>
        <dt>Subtotal</dt><dd>${money(f.subtotal)}</dd>
        <dt>Impuestos</dt><dd>${money(f.impuestos)}</dd>
        <dt>Percepción IIBB</dt><dd>${money(f.perc_iibb)}</dd>
        <dt>IVA inscripto 21 %</dt><dd>${money(f.iva)}</dd>
        <dt>IVA RG 3337</dt><dd>${money(f.iva_rg)}</dd>
        <dt>Otros gastos</dt><dd>${money(f.otros_gastos)}</dd>
        <dt class="fuerte">Premio total</dt><dd class="fuerte">${money(f.premio_total)}</dd>
      </dl>
    </section>

    ${deuda ? `
      <h2>Deuda informada al emitir la factura</h2>
      <div class="deuda">
        <div><span>Vencido</span><strong>$ ${money(deuda.vencido)}</strong></div>
        <div><span>A vencer</span><strong>$ ${money(deuda.a_vencer)}</strong></div>
        <div><span>Total</span><strong>$ ${money(deuda.total)}</strong></div>
      </div>` : ''}

    <h2>Estado del pago</h2>
    <div id="msg-estado"></div>
    <div class="acciones">
      ${f.estado !== 'pagada' ? `
        <label style="max-width:200px">Fecha de pago <input type="date" id="fecha-pago" value="${new Date().toISOString().slice(0, 10)}"></label>
        <button class="boton" data-estado="pagada" style="align-self:end">Marcar como pagada</button>` : ''}
      ${f.estado !== 'pendiente' ? '<button class="boton secundario" data-estado="pendiente">Volver a pendiente</button>' : ''}
      ${f.estado !== 'anulada' ? '<button class="boton peligro" data-estado="anulada" style="align-self:end">Anular factura</button>' : ''}
    </div>`;

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

  app.querySelectorAll('[data-estado]').forEach((b) => b.addEventListener('click', async () => {
    const estado = b.dataset.estado;
    if (estado === 'anulada' && !confirm('¿Anular esta factura? Queda registrada, pero deja de contar como pendiente.')) return;
    const cambios = { estado, fecha_pago: estado === 'pagada' ? document.getElementById('fecha-pago').value : null };
    try {
      await q(sb.from('facturas').update(cambios).eq('id', f.id));
      router();
    } catch (err) {
      document.getElementById('msg-estado').innerHTML = aviso('error', esc(err.message));
    }
  }));
}

// ---------- Vencimientos ----------
async function vistaVencimientos() {
  const filas = await q(sb.from('v_polizas_vigentes').select('*').order('vigencia_hasta'));
  const pintar = (soloProximas) => {
    const lista = soloProximas ? filas.filter((p) => p.dias_restantes <= 30) : filas;
    document.getElementById('tabla-venc').innerHTML = lista.length ? `
      <div class="tabla-scroll"><table>
        <thead><tr><th>Póliza</th><th>Asegurado</th><th>Riesgo</th><th>Último endoso</th>
          <th>Vigente hasta</th><th class="num">Suma asegurada</th><th class="num">Último premio</th></tr></thead>
        <tbody>${lista.map((p) => {
          const d = p.dias_restantes;
          const chip = d < 0 ? `<span class="chip error">Venció hace ${-d} días</span>`
            : d <= 15 ? `<span class="chip pendiente">Faltan ${d} días</span>`
            : `<span class="secundario-texto">Faltan ${d} días</span>`;
          return `<tr>
            <td><a href="#/factura/${p.factura_id}">${p.numero}</a></td>
            <td class="col-texto">${esc(p.asegurado)}<span class="secundario-texto">${esc(p.objeto || '')}</span></td>
            <td>${esc(p.ramo)}<span class="secundario-texto">${esc(p.subtipo)}</span></td>
            <td>${p.endoso}</td>
            <td>${fmtFecha(p.vigencia_hasta)} ${chip}</td>
            <td class="num">${money(p.suma_asegurada)}</td>
            <td class="num">${money(p.premio)}</td>
          </tr>`;
        }).join('')}</tbody></table></div>`
      : '<div class="vacio"><p>No hay pólizas que venzan en los próximos 30 días.</p></div>';
  };
  app.innerHTML = `
    <div class="encabezado">
      <div>
        <h1>Vencimientos</h1>
        <p class="bajada">Último período facturado de cada póliza. Si no se presenta la baja, la aseguradora refactura automáticamente.</p>
      </div>
      <label style="flex-direction:row;display:flex;align-items:center;gap:.5rem">
        <input type="checkbox" id="solo-proximas" style="width:auto"> Solo los próximos 30 días
      </label>
    </div>
    <div id="tabla-venc"></div>`;
  pintar(false);
  document.getElementById('solo-proximas').addEventListener('change', (e) => pintar(e.target.checked));
}

// ---------- Entidades y productores ----------
async function vistaEntidades() {
  const [entidades, productores] = await Promise.all([
    q(sb.from('entidades').select('*').order('razon_social')),
    q(sb.from('productores').select('*').order('nombre')),
  ]);
  app.innerHTML = `
    <h1>Entidades</h1>
    <p class="bajada">Aseguradoras, clientes y organismos asegurados que figuran en las facturas. Completá los CUIT que faltan: el PDF los trae enmascarados.</p>
    <div class="tabla-scroll"><table>
      <thead><tr><th>Razón social</th><th>CUIT</th><th>Ubicación</th><th>Condición IVA</th></tr></thead>
      <tbody>${entidades.map((e) => `<tr>
        <td>${esc(e.razon_social)}</td>
        <td>${e.cuit ? esc(e.cuit) : `<button class="enlace" style="color:var(--verde)" data-cuit="${e.id}">Cargar CUIT</button>`}</td>
        <td>${esc([e.localidad, e.provincia].filter(Boolean).join(', '))}</td>
        <td>${esc(e.condicion_iva || '')}</td></tr>`).join('')}</tbody>
    </table></div>

    <h2>Productores</h2>
    <p class="bajada">${productores.map((p) => esc(p.nombre)).join('; ') || 'Sin productores cargados.'}</p>
    <div id="msg-ent"></div>
    <h2>Agregar entidad</h2>
    <form id="form-ent">
      <fieldset><div class="grilla">
        <label class="doble">Razón social <input name="razon_social" required></label>
        <label>CUIT <input name="cuit" placeholder="30-12345678-9"></label>
        <label>Condición IVA
          <select name="condicion_iva"><option value=""></option><option>Responsable Inscripto</option>
          <option>Exento</option><option>Monotributo</option><option>Consumidor Final</option></select></label>
        <label class="doble">Domicilio <input name="domicilio"></label>
        <label>Localidad <input name="localidad"></label>
        <label>Código postal <input name="codigo_postal"></label>
        <label>Provincia <input name="provincia"></label>
        <label>Código de cliente <input name="codigo_cliente"></label>
      </div></fieldset>
      <button class="boton" type="submit">Guardar entidad</button>
    </form>

    <h3>Agregar productor</h3>
    <form id="form-prod" class="acciones">
      <label style="flex:1;min-width:240px">Nuevo productor <input name="nombre" required placeholder="APELLIDO, Nombre"></label>
      <button class="boton secundario" type="submit" style="align-self:end">Agregar productor</button>
    </form>`;

  const msg = (tipo, texto) => { document.getElementById('msg-ent').innerHTML = aviso(tipo, esc(texto)); };

  const prepararCuit = (valor) => {
    if (!valor) return null;
    const cuit = normalizarCuit(valor);
    if (!cuit) throw new Error('El CUIT debe tener 11 dígitos.');
    if (!cuitValido(cuit)) throw new Error(`El CUIT ${cuit} no es válido: el dígito verificador no coincide.`);
    return cuit;
  };

  document.getElementById('form-ent')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const datos = Object.fromEntries([...new FormData(e.target)].map(([k, v]) => [k, v.trim() || null]));
    try {
      datos.cuit = prepararCuit(datos.cuit);
      await q(sb.from('entidades').insert(datos));
      router();
    } catch (err) { msg('error', err.message); }
  });

  document.getElementById('form-prod')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await q(sb.from('productores').insert({ nombre: new FormData(e.target).get('nombre').trim() }));
      router();
    } catch (err) { msg('error', err.message); }
  });

  app.querySelectorAll('[data-cuit]').forEach((b) => b.addEventListener('click', async () => {
    const valor = prompt('CUIT (11 dígitos):');
    if (!valor) return;
    try {
      await q(sb.from('entidades').update({ cuit: prepararCuit(valor) }).eq('id', b.dataset.cuit));
      router();
    } catch (err) { msg('error', err.message); }
  }));
}

// ---------- Alta de factura ----------
const CAMPOS_IMPORTE = ['suma_asegurada', 'prima', 'gastos_notariales', 'impuestos', 'perc_iibb', 'iva', 'iva_rg'];

async function vistaNueva() {
  const [entidades, productores, riesgos] = await Promise.all([
    q(sb.from('entidades').select('id, razon_social').order('razon_social')),
    q(sb.from('productores').select('id, nombre').order('nombre')),
    q(sb.from('riesgos').select('*').order('ramo').order('subtipo')),
  ]);
  if (!entidades.length || !riesgos.length) {
    app.innerHTML = `<h1>Cargar factura</h1>
      <div class="vacio"><p>Primero cargá la aseguradora, el cliente y los asegurados.</p>
      <a class="boton" href="#/entidades">Ir a entidades</a></div>`;
    return;
  }

  const opcionesEnt = (sel) => `<option value="">Elegir…</option>` + entidades.map((e) =>
    `<option value="${e.id}" ${e.id === sel ? 'selected' : ''}>${esc(e.razon_social)}</option>`).join('');
  const opcionesRiesgo = riesgos.map((r) => `<option value="${r.id}">${esc(r.ramo)}, ${esc(r.subtipo)}</option>`).join('');
  const hoy = new Date().toISOString().slice(0, 10);

  app.innerHTML = `
    <h1>Cargar factura</h1>
    <p class="bajada">Copiá los datos tal como figuran en el PDF. Los importes aceptan formato argentino (1.234,56).
      El premio de cada póliza se calcula solo y el sistema avisa si algo no cuadra.</p>
    <div id="msg-nueva"></div>
    <form id="form-factura" novalidate>
      <fieldset>
        <legend>Comprobante</legend>
        <div class="grilla">
          <label>Tipo <select name="tipo"><option>A</option><option>B</option><option>C</option><option>M</option></select></label>
          <label>Punto de venta <input name="punto_venta" inputmode="numeric" required placeholder="0004"></label>
          <label>Número <input name="numero" inputmode="numeric" required placeholder="00259740"></label>
          <label>Fecha <input type="date" name="fecha" required value="${hoy}"></label>
          <label class="doble">Emisor (aseguradora) <select name="emisor_id" required>${opcionesEnt()}</select></label>
          <label class="doble">Cliente <select name="cliente_id" required>${opcionesEnt()}</select></label>
          <label class="doble">Productor <select name="productor_id"><option value="">Sin productor</option>
            ${productores.map((p) => `<option value="${p.id}">${esc(p.nombre)}</option>`).join('')}</select></label>
          <label>CAE <input name="cae" inputmode="numeric"></label>
          <label>Vencimiento del CAE <input type="date" name="cae_vencimiento"></label>
        </div>
      </fieldset>

      <div id="items"></div>
      <div class="acciones" style="margin-bottom:1.5rem">
        <button type="button" class="boton secundario" id="agregar-item">Agregar póliza</button>
      </div>

      <fieldset>
        <legend>Totales y deuda informada</legend>
        <div class="grilla">
          <label>Otros gastos <input name="otros_gastos" inputmode="decimal" value="0,00"></label>
          <label>Premio total impreso <input name="premio_total" inputmode="decimal" required></label>
          <label>Deuda vencida <input name="deuda_vencido" inputmode="decimal"></label>
          <label>Deuda a vencer <input name="deuda_a_vencer" inputmode="decimal"></label>
          <label>Deuda total <input name="deuda_total" inputmode="decimal"></label>
        </div>
        <p id="control-total" class="premio-calculado" aria-live="polite"></p>
      </fieldset>

      <button class="boton" type="submit">Guardar factura</button>
    </form>`;

  const contenedor = document.getElementById('items');
  const form = document.getElementById('form-factura');

  const leerItem = (el) => {
    const it = Object.fromEntries(CAMPOS_IMPORTE.map((k) => [k, parseAR(el.querySelector(`[data-k="${k}"]`).value)]));
    ['poliza_numero', 'endoso', 'vigencia_desde', 'vigencia_hasta', 'asegurado_id', 'riesgo_id', 'objeto']
      .forEach((k) => { it[k] = el.querySelector(`[data-k="${k}"]`).value.trim(); });
    it.premio = premioDeItem(it);
    return it;
  };

  const actualizarTotales = () => {
    const items = [...contenedor.children].map(leerItem);
    [...contenedor.children].forEach((el, i) => {
      el.querySelector('.premio-calculado').textContent = `Premio: $ ${money(items[i].premio)}`;
      el.querySelector('legend').textContent = `Póliza ${i + 1}`;
    });
    const calculado = round2(sumar(items, 'premio') + parseAR(form.otros_gastos.value));
    const impreso = parseAR(form.premio_total.value);
    const nodo = document.getElementById('control-total');
    nodo.textContent = !form.premio_total.value
      ? `Suma de las pólizas: $ ${money(calculado)}`
      : Math.abs(calculado - impreso) <= TOLERANCIA
        ? `Cuadra: las pólizas suman $ ${money(calculado)}.`
        : `No cuadra: las pólizas suman $ ${money(calculado)} y el total impreso es $ ${money(impreso)}.`;
    nodo.style.color = form.premio_total.value && Math.abs(calculado - impreso) > TOLERANCIA ? 'var(--rojo)' : '';
  };

  const agregarItem = () => {
    const el = document.createElement('fieldset');
    el.className = 'item-poliza';
    el.innerHTML = `
      <legend>Póliza</legend>
      <div class="grilla">
        <label>Número de póliza <input data-k="poliza_numero" inputmode="numeric" required></label>
        <label>Endoso <input data-k="endoso" inputmode="numeric" required></label>
        <label>Vigencia desde <input type="date" data-k="vigencia_desde" required></label>
        <label>Vigencia hasta <input type="date" data-k="vigencia_hasta" required></label>
        <label class="doble">Asegurado <select data-k="asegurado_id" required>${opcionesEnt()}</select></label>
        <label class="doble">Riesgo <select data-k="riesgo_id" required>${opcionesRiesgo}</select></label>
        <label class="ancho">Objeto (licitación, expediente, nota de pedido) <input data-k="objeto"></label>
        <label>Suma asegurada <input data-k="suma_asegurada" inputmode="decimal" required></label>
        <label>Prima <input data-k="prima" inputmode="decimal" required></label>
        <label>Gastos notariales <input data-k="gastos_notariales" inputmode="decimal" value="0,00"></label>
        <label>Impuestos <input data-k="impuestos" inputmode="decimal"></label>
        <label>Percepción IIBB <input data-k="perc_iibb" inputmode="decimal" value="0,00"></label>
        <label>IVA <input data-k="iva" inputmode="decimal"></label>
        <label>IVA RG 3337 <input data-k="iva_rg" inputmode="decimal" value="0,00"></label>
      </div>
      <div class="pie-item">
        <span class="premio-calculado"></span>
        <div class="acciones">
          <button type="button" class="boton secundario" data-accion="sugerir"
            title="Prima 1 ‰ de la suma asegurada, impuestos 12,7 % e IVA 21 %">Sugerir importes</button>
          <button type="button" class="boton peligro" data-accion="quitar">Quitar</button>
        </div>
      </div>`;
    el.addEventListener('click', (e) => {
      const accion = e.target.dataset.accion;
      if (accion === 'quitar' && contenedor.children.length > 1) { el.remove(); actualizarTotales(); }
      if (accion === 'sugerir') {
        const suma = parseAR(el.querySelector('[data-k="suma_asegurada"]').value);
        const primaActual = parseAR(el.querySelector('[data-k="prima"]').value) || 0;
        const s = sugerirImportes(suma, primaActual);
        ['prima', 'impuestos', 'iva'].forEach((k) => { el.querySelector(`[data-k="${k}"]`).value = money(s[k]); });
        actualizarTotales();
      }
    });
    // Vigencia trimestral por defecto
    el.querySelector('[data-k="vigencia_desde"]').addEventListener('change', (e) => {
      const hasta = el.querySelector('[data-k="vigencia_hasta"]');
      if (!hasta.value && e.target.value) {
        const d = new Date(`${e.target.value}T12:00:00`);
        d.setMonth(d.getMonth() + 3);
        hasta.value = d.toISOString().slice(0, 10);
      }
    });
    contenedor.appendChild(el);
    actualizarTotales();
  };

  form.addEventListener('input', actualizarTotales);
  document.getElementById('agregar-item').addEventListener('click', agregarItem);
  agregarItem();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('msg-nueva');
    const faltan = [...form.querySelectorAll('[required]')].filter((c) => !c.value.trim());
    if (faltan.length) {
      msg.innerHTML = aviso('error', `Faltan ${faltan.length} datos obligatorios. El primero quedó seleccionado.`);
      faltan[0].focus();
      return;
    }
    const items = [...contenedor.children].map(leerItem);
    const errores = items.flatMap((it, i) => validarItem(it).filter((p) => p.nivel === 'error')
      .map((p) => `Póliza ${i + 1}: ${p.texto}`));
    if (items.some((it) => CAMPOS_IMPORTE.some((k) => Number.isNaN(it[k])))) errores.push('Hay importes con formato inválido.');
    if (errores.length) {
      msg.innerHTML = aviso('error', `Revisá antes de guardar:<ul>${errores.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`);
      msg.scrollIntoView({ behavior: 'smooth' });
      return;
    }

    const datos = new FormData(form);
    const hayDeuda = ['deuda_vencido', 'deuda_a_vencer', 'deuda_total'].some((k) => datos.get(k));
    const payload = {
      tipo: datos.get('tipo'),
      punto_venta: parseInt(datos.get('punto_venta'), 10),
      numero: parseInt(datos.get('numero'), 10),
      fecha: datos.get('fecha'),
      emisor_id: Number(datos.get('emisor_id')),
      cliente_id: Number(datos.get('cliente_id')),
      productor_id: datos.get('productor_id') || null,
      cae: datos.get('cae') || null,
      cae_vencimiento: datos.get('cae_vencimiento') || null,
      otros_gastos: parseAR(datos.get('otros_gastos')),
      premio_total: parseAR(datos.get('premio_total')),
      deuda: hayDeuda ? {
        vencido: parseAR(datos.get('deuda_vencido')),
        a_vencer: parseAR(datos.get('deuda_a_vencer')),
        total: datos.get('deuda_total') ? parseAR(datos.get('deuda_total')) : null,
      } : null,
      items: items.map((it) => ({
        ...it,
        poliza_numero: Number(it.poliza_numero),
        endoso: Number(it.endoso),
        asegurado_id: Number(it.asegurado_id),
        riesgo_id: Number(it.riesgo_id),
      })),
    };

    const boton = form.querySelector('button[type="submit"]');
    boton.disabled = true;
    try {
      const id = await q(sb.rpc('crear_factura', { p: payload }));
      location.hash = `#/factura/${id}`;
    } catch (err) {
      msg.innerHTML = aviso('error', esc(err.message));
      msg.scrollIntoView({ behavior: 'smooth' });
    } finally {
      boton.disabled = false;
    }
  });
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
        ${aviso('error', `No se pudo leer este PDF. ${esc(l.error)} Podés cargarla con la <a href="#/nueva">carga manual</a>.`)}`;
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
      l.id = await q(sb.rpc('importar_factura', { p: armarPayload(f, null) }));
      try {
        await archivarPdf(l.id, l.archivo);
      } catch (err) {
        l.errorGuardado = `La factura se guardó, pero no el PDF original: ${err.message}`;
      }
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
