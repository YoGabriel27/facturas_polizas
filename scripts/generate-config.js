// Genera public/js/config.js a partir de variables de entorno.
// En Vercel se ejecuta en cada deploy; en local lee el archivo .env si existe.
const fs = require("fs");
const path = require("path");

const archivoEnv = path.join(__dirname, "..", ".env");
if (fs.existsSync(archivoEnv)) {
  for (const linea of fs.readFileSync(archivoEnv, "utf8").split(/\r?\n/)) {
    const m = linea.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["\x27]|["\x27]$/g, "");
  }
}

const { SUPABASE_URL, SUPABASE_ANON_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("Faltan SUPABASE_URL o SUPABASE_ANON_KEY. Definilas en .env (local) o en Vercel > Settings > Environment Variables.");
  process.exit(1);
}
const cuerpo = Buffer.from(SUPABASE_ANON_KEY.split(".")[1] || "", "base64").toString();
if (/service_role/.test(cuerpo) || SUPABASE_ANON_KEY.startsWith("sb_secret_")) {
  console.error("SUPABASE_ANON_KEY contiene una clave secreta. Usá la clave pública (anon o publishable).");
  process.exit(1);
}

const destino = path.join(__dirname, "..", "public", "js", "config.js");
fs.writeFileSync(destino, `window.APP_CONFIG = ${JSON.stringify({ SUPABASE_URL, SUPABASE_ANON_KEY })};\n`);
console.log("Configuración generada en public/js/config.js");
