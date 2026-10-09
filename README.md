# Pólizas de caución

App para revisar las facturas de seguros de caución como quien revisa el resumen de su tarjeta: cada factura muestra su total y, debajo, las pólizas que se están cobrando agrupadas por obra. Está pensada para quienes auditan el estado de las obras y deciden qué pólizas dar de baja. Es HTML, CSS y JavaScript sin framework; los datos están en Supabase (Postgres) y se publica en Vercel. Se puede instalar en el escritorio o en el celular.

## Qué hace

- **Acceso abierto:** cualquiera que tenga la dirección puede ver todo y cargar facturas nuevas. Nadie puede modificar ni eliminar lo que ya está cargado; las correcciones se hacen desde el panel de Supabase.
- **Facturas:** listado de las facturas recibidas, de la más reciente a la más antigua, con su total.
- **Factura (como un resumen de tarjeta):**
  - el total, la aseguradora, el período de cobertura y la deuda informada al emitir la factura;
  - cuánto se va en cada tipo de garantía (fondo de reparo, anticipo, ejecución de contrato, etc.);
  - las pólizas agrupadas por obra (mismo organismo y mismo contrato), con buscador y orden por importe u organismo;
  - al abrir una póliza: su desglose y en qué otras facturas cargadas se cobró, con el total acumulado;
  - el PDF original de la factura.
- **Centros de costo (CC):**
  - el botón **↑ Reporte CC** sube el Excel de centros de costo (columnas CC, Descripción y Habilitado). Antes de cargarlo muestra cuántos CC trae, cuántos son nuevos y cuáles pasan a dados de baja o vuelven a estar habilitados;
  - cada póliza tiene **Asignar CC** / **Cambiar CC**, con sugerencias según el organismo y el contrato, búsqueda por código o descripción, y la opción de asignar el mismo CC a todas las pólizas de la obra;
  - cada factura muestra el **cruce con centros de costo**: cuánto se paga en obras dadas de baja (CC deshabilitado), en obras activas y en pólizas sin CC, con filtro por estado. El listado de facturas avisa cuánto de cada una corresponde a obras dadas de baja;
  - cada cambio de CC queda registrado con la fecha y el CC anterior.
- **Organismos:** consulta de aseguradoras, clientes y organismos comitentes.
- **Importar PDF:** la única forma de cargar facturas. Se eligen uno o varios PDF de la aseguradora (o se arrastran); la app lee cabecera, pólizas, totales, deuda y CAE, controla que todo cuadre y muestra un resumen antes de guardar. La factura y su PDF se guardan en una sola operación.
- **Instalable:** desde Chrome o Edge aparece el botón **Instalar app**; en iPhone y iPad, el mismo botón explica cómo agregarla a la pantalla de inicio desde Safari.

## Estructura

```
public/                  Sitio estático que publica Vercel
  index.html
  manifest.webmanifest   Datos de instalación (nombre, colores, íconos)
  sw.js                  Service worker: instalación y apertura rápida
  icons/                 Íconos de la app en todos los tamaños
  css/styles.css
  js/app.js              Vistas, login y conexión con Supabase
  js/calc.js             Cálculos, formatos argentinos, CUIT, importe en letras
  js/pdf-factura.js      Lectura del PDF de la aseguradora (pdf.js, por coordenadas)
  js/centros-costo.js    Lectura del Reporte CC en Excel (SheetJS) y sugerencias de CC
  js/config.js           Se genera en el build (no se sube a GitHub)
scripts/generate-config.js
supabase/
  migrations/
    20261009000001_esquema.sql     Tablas, vistas y función crear_factura
    20261009000002_seguridad.sql   Row Level Security inicial
    20261009000003_importar_pdf.sql  Importación desde PDF
    20261009000004_acceso_por_enlace.sql  PDF dentro de la base (y acceso por enlace, ya reemplazado)
    20261009000005_lectura_abierta_solo_alta.sql  Lectura abierta, solo alta de facturas
    20261009000006_sin_carga_manual.sql  Las facturas solo se cargan importando el PDF
    20261009000007_centros_costo.sql  Centros de costo, Reporte CC y asignación por póliza
  seed.sql               Factura A 0004-00259740 con sus 19 pólizas
vercel.json
```

## Modelo de datos

| Tabla | Contenido |
|---|---|
| `entidades` | Emisor, clientes y asegurados (razón social única, CUIT validado) |
| `productores` | Productores asesores |
| `riesgos` | Catálogo ramo + subtipo (Obra Pública / Fondo de Reparo, etc.) |
| `polizas` | Número, tomador, asegurado, riesgo y objeto (licitación, expediente) |
| `facturas` | Cabecera, CAE, desglose de totales, premio total impreso y estado de pago |
| `factura_items` | Póliza, endoso, vigencia e importes de cada renglón |
| `deuda_snapshots` | Deuda vencida y a vencer informada al pie de cada factura |
| `factura_pdfs` | PDF original de cada factura |

Vistas: `v_facturas_resumen` (control de totales) y `v_polizas_vigentes` (último endoso de cada póliza).

## Puesta en marcha

### 1. Supabase

1. Creá un proyecto en [supabase.com](https://supabase.com).
2. En **SQL Editor**, ejecutá en este orden:
   1. `supabase/migrations/20261009000001_esquema.sql`
   2. `supabase/migrations/20261009000002_seguridad.sql`
   3. `supabase/migrations/20261009000003_importar_pdf.sql`
   4. `supabase/migrations/20261009000004_acceso_por_enlace.sql`
   5. `supabase/migrations/20261009000005_lectura_abierta_solo_alta.sql`
   6. `supabase/migrations/20261009000006_sin_carga_manual.sql`
   7. `supabase/migrations/20261009000007_centros_costo.sql`
   8. `supabase/seed.sql` (opcional: carga la factura de ejemplo; también se puede importar su PDF desde la app)

   Si usás la CLI de Supabase, alcanza con `supabase link` y `supabase db push`.
3. En **Project Settings > API Keys**, copiá la **Project URL** y la clave **anon / publishable**.

> Nunca uses la clave `service_role` ni `sb_secret_…` en la app. El build se frena si detecta una.

### 2. GitHub

```bash
git init
git add .
git commit -m "App de facturas de seguros de caución"
git branch -M main
git remote add origin https://github.com/TU-USUARIO/facturas-seguros.git
git push -u origin main
```

El archivo `.gitignore` ya excluye `.env` y `public/js/config.js`, así que las claves no se suben al repositorio.

### 3. Vercel

1. En [vercel.com](https://vercel.com), elegí **Add New > Project** e importá el repositorio.
2. Framework preset: **Other**. El build y la carpeta de salida ya están definidos en `vercel.json`.
3. En **Environment Variables**, agregá:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
4. Hacé clic en **Deploy**. Cada `git push` a `main` vuelve a publicar la app.

### Desarrollo local

```bash
cp .env.example .env    # completá la URL y la clave
npm run dev             # http://localhost:3000
```

## Seguridad y permisos

- La app no tiene usuarios ni contraseñas: cualquiera que tenga la dirección puede ver todos los datos, incluidos los PDF.
- Desde la app solo se puede **agregar**: facturas nuevas importadas desde su PDF, y el PDF de una factura que todavía no lo tiene.
- La única excepción son los **centros de costo**: se puede cargar un Reporte CC (que agrega y actualiza CC, sin borrar ninguno) y asignar o cambiar el CC de cada póliza. Cada cambio de CC queda en `polizas_cc_cambios`. Una factura ya cargada no se puede volver a cargar, y un PDF archivado no se puede reemplazar.
- **Nada se modifica ni se elimina desde la app.** Las tablas son de solo lectura para la clave pública de Supabase, así que tampoco se puede hacer saltándose la app. Las únicas escrituras pasan por cuatro funciones de la base: `importar_factura` y `archivar_pdf` (solo insertan registros nuevos), `importar_reporte_cc` y `asignar_cc`.
- Las correcciones (un CUIT, el estado de pago, una factura mal cargada) se hacen desde el **Table Editor** o el **SQL Editor** de Supabase.
- La página le indica a los buscadores que no la indexen.

## Cómo se lee el PDF

El lector (`public/js/pdf-factura.js`) usa la capa de texto del PDF con las coordenadas de cada dato, igual que la lee una persona: cada póliza ocupa tres renglones y los importes se asignan a la columna según su alineación. Se probó contra la factura A 0004-00259740 y coincidieron los 247 campos con los datos cargados a mano para verificarlo.

Antes de guardar, se controla que:

- el premio de cada póliza sea subtotal + impuestos + IVA;
- las pólizas sumen el premio total impreso;
- el importe en letras coincida con el número.

Si algo no cuadra, la factura no se guarda y se indica qué revisar. Como lo cargado no se puede corregir desde la app, este control evita que quede una factura mal leída. Ese control protege contra cambios de diseño del PDF: si la aseguradora modifica el formato, la lectura falla de forma visible en vez de cargar datos erróneos. En ese caso hay que ajustar los bordes de columna en `BORDES_POR_DEFECTO`.

Los PDF originales se guardan dentro de la base, en la tabla `factura_pdfs` (hasta 5 MB cada uno), con la misma protección que el resto de los datos.

## Notas sobre los datos de la factura

- Los CUIT del PDF vienen enmascarados ("30-,714,838-0"), por eso se guardan vacíos. Se completan desde el Table Editor de Supabase, en la tabla `entidades`.
- La deuda del pie viene con otro formato (16,477,101, sin decimales). El parser acepta ambos formatos.
- Muchas obras tienen dos pólizas consecutivas: Ejecución de Contrato y Fondo de Reparo. La app las muestra juntas, dentro de la misma obra.
- Las reglas de prima (1 ‰ con mínimos de 8.000 a 22.000), impuestos (12,7 %) e IVA (21 %) surgen de esta factura. Si la aseguradora cambia alícuotas, ajustalas en `public/js/calc.js`.

## Próximos pasos posibles

- Importar el PDF directamente: leer la capa de texto y precargar el formulario.
- Agrupar las pólizas por contrato u obra.
- Generar un reporte mensual de primas por asegurado.

## Instalación como app

La app cumple los requisitos de una aplicación web instalable: `manifest.webmanifest` con nombre e íconos, y un service worker (`sw.js`). Los archivos propios se piden siempre primero a la red, así que cada publicación nueva se ve enseguida. Los datos de Supabase nunca se guardan en caché.

Para cambiar el ícono, reemplazá los archivos de `public/icons/` manteniendo los mismos nombres y tamaños. Si cambiás archivos de la app y querés forzar que los dispositivos instalados descarten la copia guardada, subí el número de `VERSION` en `sw.js`.

## Reporte CC

El Excel debe tener una hoja (preferentemente llamada `CC`) con las columnas **CC**, **Descripción** y **Habilitado**. Habilitado acepta Verdadero/Falso, TRUE/FALSE, Sí/No o 1/0.

- **Habilitado** = obra activa (verde). **Sin CC asignado**: amarillo. **Deshabilitado** = obra dada de baja (rosa): las pólizas asignadas a ese CC son candidatas a darse de baja.
- Los códigos tienen el formato `NN-NNN` (por ejemplo `01-618`). El listado también trae códigos `NN-N`, `NN-NN` y `NN-NNNNN` (por ejemplo `10-82`), que se aceptan igual.
- La fecha del reporte se toma del nombre del archivo si la incluye (`BASE_de_CC_24-09-2026.xlsx` → 24/09/2026).
- Cargar un reporte nuevo agrega los CC que no existían y actualiza descripción y estado de los existentes. Los CC que no vienen en el reporte se conservan, para no perder asignaciones.
