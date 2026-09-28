/**
 * Verifica que el entorno está listo para levantar la aplicación.
 * Uso: npm run verificar            (validación local)
 *      npm run verificar:conexion   (además prueba la clave contra la API de Gemini)
 */
import { existsSync, readFileSync } from "node:fs"
import { cargarEntorno, enmascarar } from "../src/core/entorno.ts"

let errores = 0
const ok = (m: string) => console.log(`  ✓ ${m}`)
const mal = (m: string) => { errores++; console.log(`  ✗ ${m}`) }
const aviso = (m: string) => console.log(`  ! ${m}`)
const claves = (texto: string) => texto.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => l.split("=")[0]?.trim() ?? "")

console.log("Verificación del entorno\n")
const [mayor] = process.versions.node.split(".").map(Number)
if ((mayor ?? 0) >= 20) ok(`Node ${process.versions.node}`)
else mal(`Node ${process.versions.node}: se requiere 20 o superior`)

if (!existsSync("node_modules")) mal("Faltan dependencias: ejecuta npm install")
else ok("Dependencias instaladas")

if (!existsSync(".env")) {
  mal("No existe .env: cópialo desde .env.example y completa GEMINI_API_KEY")
} else {
  ok(".env encontrado")
  process.loadEnvFile(".env")
  const faltantes = claves(readFileSync(".env.example", "utf8")).filter((k) => !claves(readFileSync(".env", "utf8")).includes(k))
  if (faltantes.length) aviso(`Variables de .env.example ausentes en .env (se usará su valor por defecto): ${faltantes.join(", ")}`)
}
const gitignore = existsSync(".gitignore") ? readFileSync(".gitignore", "utf8") : ""
if (/^\.env$/m.test(gitignore)) ok(".env está excluido de git")
else mal(".env NO está en .gitignore: la clave podría subirse al repositorio")

const r = cargarEntorno()
if (!r.ok) {
  for (const e of r.errores) mal(e)
} else {
  const e = r.entorno
  ok(`Proveedor ${e.LLM_PROVIDER} · modelo ${e.GEMINI_MODEL} · clave ${enmascarar(e.GEMINI_API_KEY)}`)
  ok(`Límites: ${e.MAX_ITERACIONES} iteraciones/turno · ${e.MAX_TOKENS_SESION} tokens/sesión · timeout ${e.LLM_TIMEOUT_MS} ms`)
  ok(`Puerto ${e.PORT} · fecha de referencia ${e.FECHA_REFERENCIA ?? "hoy (America/Bogota)"}`)
  for (const a of r.avisos) aviso(a)

  if (process.argv.includes("--conectar") && e.GEMINI_API_KEY) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${e.GEMINI_MODEL}`, { headers: { "x-goog-api-key": e.GEMINI_API_KEY }, signal: AbortSignal.timeout(15000) })
      if (res.ok) ok(`Conexión con Gemini: la clave es válida y el modelo ${e.GEMINI_MODEL} está disponible`)
      else if (res.status === 400 || res.status === 401 || res.status === 403) mal(`Gemini rechazó la clave (HTTP ${res.status}). Revisa GEMINI_API_KEY en Google AI Studio.`)
      else if (res.status === 404) mal(`El modelo ${e.GEMINI_MODEL} no existe o no está disponible para esta clave (HTTP 404).`)
      else mal(`Gemini respondió HTTP ${res.status}.`)
    } catch {
      mal("No hay conexión con generativelanguage.googleapis.com (red, proxy o firewall).")
    }
  }
}
console.log(errores ? `\n${errores} problema(s) por corregir.` : "\nEntorno listo.")
process.exitCode = errores ? 1 : 0
