import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { readFile } from "node:fs/promises"
import { extname, join, normalize, sep } from "node:path"
import { randomUUID } from "node:crypto"
import { Agente, cargarInstrucciones, type Sesion } from "./agente.ts"
import { RegistroHerramientas } from "./core/registro-herramientas.ts"
import { crearProveedor } from "./llm/index.ts"
import { cargarEntorno } from "./core/entorno.ts"
import { APLICACION } from "./config.ts"

const directorio = process.cwd()
const resultadoEntorno = cargarEntorno()
if (!resultadoEntorno.ok) {
  console.error(`Configuración inválida en .env:\n  - ${resultadoEntorno.errores.join("\n  - ")}`)
  process.exit(1)
}
const entorno = resultadoEntorno.entorno
for (const aviso of resultadoEntorno.avisos) console.warn(`Aviso: ${aviso}`)
if (entorno.FECHA_REFERENCIA) process.env.FECHA_REFERENCIA = entorno.FECHA_REFERENCIA
const llm = crearProveedor(entorno)
const herramientas = new RegistroHerramientas().agregar(APLICACION.prefijo, APLICACION.herramientas)
const agente = new Agente(llm, herramientas, await cargarInstrucciones(directorio), {
  directorio,
  maxIteraciones: entorno.MAX_ITERACIONES,
  maxTokensSesion: entorno.MAX_TOKENS_SESION,
})
const sesiones = new Map<string, Sesion>()

const TIPOS: Record<string, string> = { ".html": "text/html; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".json": "application/json", ".pdf": "application/pdf", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".txt": "text/plain; charset=utf-8" }

function json(res: ServerResponse, estado: number, cuerpo: unknown): void {
  res.writeHead(estado, { "content-type": "application/json; charset=utf-8" })
  res.end(JSON.stringify(cuerpo))
}

async function leerCuerpo(req: IncomingMessage): Promise<unknown> {
  let texto = ""
  for await (const trozo of req) {
    texto += String(trozo)
    if (texto.length > 20_000) throw new Error("cuerpo demasiado grande")
  }
  return JSON.parse(texto || "{}")
}

function obtenerSesion(id: string): Sesion {
  const existente = sesiones.get(id)
  if (existente) return existente
  const nueva: Sesion = { id, mensajes: [], tokens: 0, esperandoConfirmacion: false }
  sesiones.set(id, nueva)
  return nueva
}

async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let cuerpo: unknown
  try {
    cuerpo = await leerCuerpo(req)
  } catch {
    return json(res, 400, { error: "Cuerpo inválido." })
  }
  const { sessionId, message } = (cuerpo ?? {}) as { sessionId?: unknown; message?: unknown }
  if (typeof message !== "string" || !message.trim()) return json(res, 400, { error: "Falta el mensaje." })
  const id = typeof sessionId === "string" && sessionId ? sessionId : randomUUID()
  const resultado = await agente.turno(obtenerSesion(id), message.slice(0, 4000))
  json(res, 200, { sessionId: id, ...resultado })
}

/** Sirve web/ y los archivos generados en out/, sin permitir salir de esas carpetas. */
async function estatico(res: ServerResponse, base: string, rutaRelativa: string): Promise<void> {
  const raiz = join(directorio, base)
  const destino = normalize(join(raiz, decodeURIComponent(rutaRelativa)))
  if (!destino.startsWith(raiz + sep) && destino !== raiz) return json(res, 403, { error: "Ruta no permitida." })
  try {
    const contenido = await readFile(destino)
    res.writeHead(200, { "content-type": TIPOS[extname(destino)] ?? "application/octet-stream" })
    res.end(contenido)
  } catch {
    json(res, 404, { error: "No encontrado." })
  }
}

const servidor = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost")
  try {
    if (req.method === "POST" && url.pathname === "/api/chat") return await chat(req, res)
    if (req.method === "GET" && url.pathname === "/api/health") return json(res, 200, { ok: true, provider: llm?.nombre ?? "sin-configurar", model: llm?.modelo ?? null, app: APLICACION.nombre, ejemplo: APLICACION.ejemplo })
    const sesion = url.pathname.match(/^\/api\/sessions\/([\w-]+)$/)
    if (req.method === "GET" && sesion?.[1]) {
      const s = sesiones.get(sesion[1])
      return s ? json(res, 200, { id: s.id, tokens: s.tokens, mensajes: s.mensajes.map(({ ...m }) => ("crudo" in m ? { ...m, crudo: undefined } : m)) }) : json(res, 404, { error: "Sesión no encontrada." })
    }
    if (req.method === "GET" && url.pathname.startsWith("/out/")) return await estatico(res, "out", url.pathname.slice(5))
    if (req.method === "GET") return await estatico(res, "web", url.pathname === "/" ? "index.html" : url.pathname.slice(1))
    json(res, 404, { error: "No encontrado." })
  } catch {
    json(res, 500, { error: "Error interno. La sesión sigue activa." })
  }
})

const puerto = entorno.PORT
servidor.listen(puerto, () => console.log(`${APLICACION.nombre} escuchando en http://localhost:${puerto} (modelo: ${llm ? `${llm.nombre}/${llm.modelo}` : "no configurado"})`))
