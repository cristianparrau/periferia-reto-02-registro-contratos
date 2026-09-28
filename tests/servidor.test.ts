import { after, describe, it } from "node:test"
import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RAIZ } from "./ayudas.ts"

const CLAVE = "AQ.clave-ficticia-solo-para-pruebas-123456"
const temporales: string[] = []
after(async () => { for (const d of temporales) await rm(d, { recursive: true, force: true }) })

/** Levanta el servidor real con un .env dado (mismo mecanismo que npm start) y entorno limpio. */
async function levantar(contenidoEnv: string): Promise<{ proceso: ChildProcess; salida: () => string; base: string; codigo: Promise<number | null> }> {
  const dir = await mkdtemp(join(tmpdir(), "env-test-"))
  temporales.push(dir)
  const archivo = join(dir, ".env")
  await writeFile(archivo, contenidoEnv)
  const puerto = String(40000 + Math.floor(Math.random() * 20000))
  const proceso = spawn(process.execPath, [`--env-file=${archivo}`, "--import", "tsx", "src/server.ts"], { cwd: RAIZ, env: { PATH: process.env.PATH, PORT: puerto, SystemRoot: process.env.SystemRoot } })
  let salida = ""
  proceso.stdout?.on("data", (d) => (salida += String(d)))
  proceso.stderr?.on("data", (d) => (salida += String(d)))
  const codigo = new Promise<number | null>((r) => proceso.on("exit", r))
  const base = `http://127.0.0.1:${puerto}`
  for (let i = 0; i < 60 && !salida.includes("escuchando") && proceso.exitCode === null; i++) await new Promise((r) => setTimeout(r, 250))
  return { proceso, salida: () => salida, base, codigo }
}

describe("servidor con .env", { timeout: 60000 }, () => {
  it("levanta con un .env válido y /api/health refleja su configuración sin exponer la clave", async () => {
    const s = await levantar(`GEMINI_API_KEY=${CLAVE}\nGEMINI_MODEL=gemini-2.5-flash-lite\nMAX_ITERACIONES=5\n`)
    try {
      assert.match(s.salida(), /escuchando/)
      const texto = await (await fetch(`${s.base}/api/health`)).text()
      const h = JSON.parse(texto) as { ok: boolean; provider: string; model: string; app: string }
      assert.deepEqual([h.ok, h.provider, h.model], [true, "gemini", "gemini-2.5-flash-lite"])
      assert.ok(h.app)
      assert.ok(!texto.includes(CLAVE), "la clave no debe aparecer en health")
      assert.ok(!s.salida().includes(CLAVE), "la clave no debe aparecer en la consola")
    } finally { s.proceso.kill() }
  })

  it("rutas de la API: front, chat inválido, sesión inexistente y path traversal", async () => {
    const s = await levantar(`GEMINI_API_KEY=${CLAVE}\n`)
    try {
      assert.equal((await fetch(`${s.base}/`)).status, 200)
      assert.equal((await fetch(`${s.base}/api/chat`, { method: "POST", body: "{}" })).status, 400)
      assert.equal((await fetch(`${s.base}/api/chat`, { method: "POST", body: "{malo" })).status, 400)
      assert.equal((await fetch(`${s.base}/api/sessions/no-existe`)).status, 404)
      assert.equal((await fetch(`${s.base}/out/..%2F.env`)).status, 403)
      assert.equal((await fetch(`${s.base}/..%2Fpackage.json`)).status, 403)
    } finally { s.proceso.kill() }
  })

  it("sin clave levanta con aviso y el chat explica que no hay modelo", async () => {
    const s = await levantar("MAX_ITERACIONES=10\n")
    try {
      assert.match(s.salida(), /Aviso: GEMINI_API_KEY no está definida/)
      const r = (await (await fetch(`${s.base}/api/chat`, { method: "POST", body: JSON.stringify({ sessionId: "s1", message: "hola" }) })).json()) as { reply: string }
      assert.match(r.reply, /No hay un modelo configurado/)
      const sesion = (await (await fetch(`${s.base}/api/sessions/s1`)).json()) as { mensajes: unknown[] }
      assert.equal(sesion.mensajes.length, 2)
    } finally { s.proceso.kill() }
  })

  it("con un .env inválido no levanta y explica qué corregir", async () => {
    const s = await levantar("MAX_ITERACIONES=abc\nPORT=99999\n")
    const codigo = await s.codigo
    assert.equal(codigo, 1)
    assert.match(s.salida(), /Configuración inválida en \.env/)
    assert.match(s.salida(), /MAX_ITERACIONES debe ser un número/)
  })
})
