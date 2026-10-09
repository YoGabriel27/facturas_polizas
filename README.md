# Facturas de seguros de caución

Aplicación web para registrar y controlar las facturas de seguros de caución: cada factura, sus pólizas, los vencimientos y la deuda informada por la aseguradora. Es HTML, CSS y JavaScript sin framework. Los datos se guardan en Supabase (Postgres) y la app se publica en Vercel.

## Qué hace

- **Facturas:** listado con estado de pago y un control que indica si las pólizas suman el premio total impreso.
- **Detalle de factura:** emisor y cliente, las pólizas con su vigencia, el desglose de importes, el importe en letras y la deuda informada al pie. Cada póliza se valida:
  - premio = subtotal + impuestos + IVA;
  - IVA al 21 %;
  - prima ≥ 1 ‰ de la suma asegurada.
- **Importar PDF:** se eligen uno o varios PDF de la aseguradora (o se arrastran). La app lee cabecera, pólizas, totales, deuda y CAE, controla que todo cuadre y muestra un resumen antes de guardar. Crea sola los asegurados, riesgos y productores nuevos, detecta facturas ya cargadas y archiva el PDF original, que después se abre desde el detalle.
- **Carga manual:** formulario con cálculo automático del premio. El botón "Sugerir importes" propone prima, impuestos e IVA. El alta es atómica: si algo no cuadra, no se guarda nada.
- **Vencimientos:** el último período facturado de cada póliza y los días que faltan para su vencimiento.
- **Entidades:** aseguradoras, clientes y organismos asegurados, con validación del dígito verificador del CUIT.

## Estructura

```
public/                  Sitio estático que publica Vercel
  index.html
  css/styles.css
  js/app.js              Vistas, login y conexión con Supabase
  js/calc.js             Cálculos, formatos argentinos, CUIT, importe en letras
  js/pdf-factura.js      Lectura del PDF de la aseguradora (pdf.js, por coordenadas)
  js/config.js           Se genera en el build (no se sube a GitHub)
scripts/generate-config.js
supabase/
  migrations/
    20261009000001_esquema.sql     Tablas, vistas y función crear_factura
    20261009000002_seguridad.sql   Row Level Security inicial
    20261009000003_importar_pdf.sql  Importación desde PDF
    20261009000004_acceso_por_enlace.sql  Acceso por enlace y PDF dentro de la base
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
| `enlaces_acceso` | Enlaces de acceso (solo el hash de cada clave) |

Vistas: `v_facturas_resumen` (control de totales) y `v_polizas_vigentes` (último endoso de cada póliza).

## Puesta en marcha

### 1. Supabase

1. Creá un proyecto en [supabase.com](https://supabase.com).
2. En **SQL Editor**, ejecutá en este orden:
   1. `supabase/migrations/20261009000001_esquema.sql`
   2. `supabase/migrations/20261009000002_seguridad.sql`
   3. `supabase/migrations/20261009000003_importar_pdf.sql`
   4. `supabase/migrations/20261009000004_acceso_por_enlace.sql`
   5. `supabase/seed.sql` (opcional: carga la factura de ejemplo; también se puede importar su PDF desde la app)

   Si usás la CLI de Supabase, alcanza con `supabase link` y `supabase db push`.
3. Generá el enlace de acceso (ver "Enlaces de acceso").
4. En **Project Settings > API Keys**, copiá la **Project URL** y la clave **anon / publishable**.

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

## Enlaces de acceso

La app no usa usuario ni contraseña: se entra con un enlace que lleva una clave.

```
https://TU-APP.vercel.app/?acceso=CLAVE
```

Al abrirlo, la app guarda la clave en ese navegador y la quita de la barra de direcciones; las próximas veces alcanza con la dirección sola. Quien tenga el enlace puede consultar, importar facturas y marcar pagos. Sin la clave no se ve nada, aunque se conozca la dirección.

En la base solo se guarda el hash de la clave, así que una clave perdida no se puede recuperar: se genera otra. Todo se hace desde el **SQL Editor** de Supabase.

```sql
-- Crear un enlace nuevo (la clave se muestra una sola vez)
select public.crear_enlace('Descripción, por ejemplo: equipo de obra');

-- Ver los enlaces existentes
select id, descripcion, activo, created_at from public.enlaces_acceso;

-- Dar de baja un enlace (por ejemplo, si circuló de más)
update public.enlaces_acceso set activo = false where id = 1;
```

Se pueden tener varios enlaces activos a la vez, uno por grupo de personas, para poder dar de baja uno sin afectar a los demás.

### Desarrollo local

```bash
cp .env.example .env    # completá la URL y la clave
npm run dev             # http://localhost:3000
```

## Seguridad

- Todas las tablas tienen RLS activado. Cada consulta debe traer una clave de enlace válida en el encabezado `x-acceso`; sin ella no se lee ni se escribe nada.
- La clave anon de Supabase es pública por diseño: lo que protege los datos es la clave del enlace más el RLS.
- El enlace funciona como una llave: quien lo reciba, aunque sea reenviado, tiene acceso completo. Si circula de más, dalo de baja y generá otro.
- Los enlaces solo se crean desde el SQL Editor; nadie puede generarse uno desde la app.

## Cómo se lee el PDF

El lector (`public/js/pdf-factura.js`) usa la capa de texto del PDF con las coordenadas de cada dato, igual que la lee una persona: cada póliza ocupa tres renglones y los importes se asignan a la columna según su alineación. Se probó contra la factura A 0004-00259740 y coincidieron los 247 campos con la carga manual.

Antes de guardar, se controla que:

- el premio de cada póliza sea subtotal + impuestos + IVA;
- las pólizas sumen el premio total impreso;
- el importe en letras coincida con el número.

Si algo no cuadra, la factura no se guarda y se indica qué revisar. Ese control protege contra cambios de diseño del PDF: si la aseguradora modifica el formato, la lectura falla de forma visible en vez de cargar datos erróneos. En ese caso hay que ajustar los bordes de columna en `BORDES_POR_DEFECTO`.

Los PDF originales se guardan dentro de la base, en la tabla `factura_pdfs` (hasta 5 MB cada uno), con la misma protección que el resto de los datos.

## Notas sobre los datos de la factura

- Los CUIT del PDF vienen enmascarados ("30-,714,838-0"), por eso la carga inicial los deja vacíos. Completalos desde **Entidades**.
- La deuda del pie viene con otro formato (16,477,101, sin decimales). El parser acepta ambos formatos.
- Muchas obras tienen dos pólizas consecutivas: Ejecución de Contrato y Fondo de Reparo. Se pueden ver juntas en **Vencimientos**.
- Las reglas de prima (1 ‰ con mínimos de 8.000 a 22.000), impuestos (12,7 %) e IVA (21 %) surgen de esta factura. Si la aseguradora cambia alícuotas, ajustalas en `public/js/calc.js`.

## Próximos pasos posibles

- Importar el PDF directamente: leer la capa de texto y precargar el formulario.
- Agrupar las pólizas por contrato u obra.
- Generar un reporte mensual de primas por asegurado.
