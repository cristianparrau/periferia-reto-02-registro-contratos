import { afterEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import { Gemini, esCuotaDiaria, esperaSugerida, limpiarEsquema } from "../src/llm/gemini.ts"
import { ErrorLLM } from "../src/llm/adapter.ts"

const original = globalThis.fetch
afterEach(() => { globalThis.fetch = original })

function simularFetch(respuesta: unknown, estado = 200): { peticiones: { url: string; init: RequestInit }[] } {
  const registro = { peticiones: [] as { url: string; init: RequestInit }[] }
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    registro.peticiones.push({ url: String(url), init: init ?? {} })
    return new Response(JSON.stringify(respuesta), { status: estado })
  }) as typeof fetch
  return registro
}

const CLAVE = "clave-de-prueba-1234567890"

describe("adaptador Gemini", () => {
  it("envía la clave en cabecera (nunca en la URL), las herramientas y temperatura 0", async () => {
    const r = simularFetch({ candidates: [{ content: { parts: [{ text: "hola" }] } }], usageMetadata: { totalTokenCount: 42 } })
    const g = new Gemini(CLAVE, "gemini-2.5-flash", 5000)
    const res = await g.enviar([{ rol: "sistema", texto: "sé breve" }, { rol: "usuario", texto: "hola" }], [{ nombre: "x_y", descripcion: "d", parametros: { type: "object", properties: {} } }])
    const p = r.peticiones[0]
    assert.ok(p)
    assert.ok(!p.url.includes(CLAVE))
    assert.equal((p.init.headers as Record<string, string>)["x-goog-api-key"], CLAVE)
    const cuerpo = JSON.parse(String(p.init.body)) as { systemInstruction: { parts: { text: string }[] }; tools: { functionDeclarations: { name: string }[] }[]; generationConfig: { temperature: number } }
    assert.equal(cuerpo.systemInstruction.parts[0]?.text, "sé breve")
    assert.equal(cuerpo.tools[0]?.functionDeclarations[0]?.name, "x_y")
    assert.equal(cuerpo.generationConfig.temperature, 0)
    assert.equal(res.texto, "hola")
    assert.equal(res.tokens, 42)
  })

  it("convierte functionCall en llamadas a herramientas", async () => {
    simularFetch({ candidates: [{ content: { parts: [{ functionCall: { name: "a_b", args: { caso: "x" } } }] } }] })
    const res = await new Gemini(CLAVE, "m", 5000).enviar([{ rol: "usuario", texto: "x" }], [])
    assert.deepEqual(res.llamadas[0], { id: "llamada-0", nombre: "a_b", argumentos: { caso: "x" } })
  })

  it("un HTTP de error se convierte en ErrorLLM legible sin exponer la clave", async () => {
    simularFetch({ error: { message: "API key not valid" } }, 400)
    await assert.rejects(new Gemini(CLAVE, "m", 5000).enviar([{ rol: "usuario", texto: "x" }], []), (e: unknown) => e instanceof ErrorLLM && /400/.test(e.message) && !e.message.includes(CLAVE))
  })

  it("reintenta ante 503/429 (saturación) y responde si Google se recupera", async () => {
    const estados = [503, 429, 200]
    let llamadas = 0
    globalThis.fetch = (async () => {
      const estado = estados[llamadas++] ?? 200
      return new Response(JSON.stringify(estado === 200 ? { candidates: [{ content: { parts: [{ text: "ok" }] } }] } : { error: { message: "high demand" } }), { status: estado })
    }) as typeof fetch
    const res = await new Gemini(CLAVE, "m", 5000, [1, 1]).enviar([{ rol: "usuario", texto: "x" }], [])
    assert.equal(llamadas, 3)
    assert.equal(res.texto, "ok")
  })

  it("si la saturación persiste, informa que se reintentó; un 400 no se reintenta", async () => {
    let llamadas = 0
    globalThis.fetch = (async () => { llamadas++; return new Response(JSON.stringify({ error: { message: "high demand" } }), { status: 503 }) }) as typeof fetch
    await assert.rejects(new Gemini(CLAVE, "m", 5000, [1, 1]).enviar([{ rol: "usuario", texto: "x" }], []), /saturado.*reintentó 2 veces/)
    assert.equal(llamadas, 3)
    llamadas = 0
    globalThis.fetch = (async () => { llamadas++; return new Response(JSON.stringify({ error: { message: "API key not valid" } }), { status: 400 }) }) as typeof fetch
    await assert.rejects(new Gemini(CLAVE, "m", 5000, [1, 1]).enviar([{ rol: "usuario", texto: "x" }], []), /400: API key not valid/)
    assert.equal(llamadas, 1)
  })

  it("si el modelo principal sigue saturado, usa el modelo de respaldo", async () => {
    const urls: string[] = []
    globalThis.fetch = (async (url: string | URL) => {
      urls.push(String(url))
      const respaldo = String(url).includes("modelo-respaldo")
      return new Response(JSON.stringify(respaldo ? { candidates: [{ content: { parts: [{ text: "desde respaldo" }] } }] } : { error: { message: "high demand" } }), { status: respaldo ? 200 : 503 })
    }) as typeof fetch
    const res = await new Gemini(CLAVE, "modelo-principal", 5000, [1], ["modelo-respaldo"]).enviar([{ rol: "usuario", texto: "x" }], [])
    assert.equal(res.texto, "desde respaldo")
    assert.deepEqual(urls.map((u) => (u.includes("respaldo") ? "respaldo" : "principal")), ["principal", "principal", "respaldo"])
  })

  it("cuota diaria agotada: no espera ni reintenta el mismo modelo y pasa al siguiente de la lista", async () => {
    const urls: string[] = []
    const diaria = { error: { message: "quota", details: [{ violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }, { retryDelay: "56s" }] } }
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url); urls.push(u.includes("tercero") ? "tercero" : u.includes("segundo") ? "segundo" : "principal")
      return u.includes("tercero") ? new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }), { status: 200 }) : new Response(JSON.stringify(diaria), { status: 429 })
    }) as typeof fetch
    const inicio = Date.now()
    const res = await new Gemini(CLAVE, "principal", 5000, [2000, 5000], ["segundo", "tercero"]).enviar([{ rol: "usuario", texto: "x" }], [])
    assert.equal(res.texto, "ok")
    assert.deepEqual(urls, ["principal", "segundo", "tercero"])
    assert.ok(Date.now() - inicio < 1000, "no debe esperar el retryDelay de una cuota diaria")
    assert.equal(esCuotaDiaria(diaria), true)
  })

  it("si todos los modelos agotaron la cuota diaria, lo explica", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { details: [{ violations: [{ quotaId: "RequestsPerDay" }] }] } }), { status: 429 })) as typeof fetch
    await assert.rejects(new Gemini(CLAVE, "a", 5000, [1], ["b"]).enviar([{ rol: "usuario", texto: "x" }], []), /cuota diaria/)
  })

  it("respeta la espera sugerida por Google en un 429 (acotada a 30 s)", () => {
    assert.equal(esperaSugerida({ error: { details: [{}, { retryDelay: "12.5s" }] } }, 2000), 12500)
    assert.equal(esperaSugerida({ error: { details: [{ retryDelay: "120s" }] } }, 2000), 30000)
    assert.equal(esperaSugerida({ error: { message: "x" } }, 2000), 2000)
  })

  it("un timeout se reporta con un mensaje claro", async () => {
    // Servidor que nunca responde; el temporizador mantiene vivo el proceso hasta que el AbortSignal del adaptador actúe.
    globalThis.fetch = (async (_u: string | URL, init?: RequestInit) =>
      new Promise((_, rechazar) => {
        const vivo = setTimeout(() => rechazar(new Error("el adaptador no abortó")), 5000)
        init?.signal?.addEventListener("abort", () => { clearTimeout(vivo); rechazar(init.signal?.reason) })
      })) as typeof fetch
    await assert.rejects(new Gemini(CLAVE, "m", 50).enviar([{ rol: "usuario", texto: "x" }], []), /no respondió en 0.05 s/)
  })

  it("adapta el JSON Schema de zod al subconjunto que acepta Gemini", () => {
    const limpio = limpiarEsquema({ $schema: "x", type: "object", additionalProperties: false, properties: { a: { type: "string", pattern: "^x$" }, b: { type: ["string", "null"] }, c: { anyOf: [{ type: "number" }, { type: "null" }] } } }) as Record<string, unknown>
    const props = limpio.properties as Record<string, Record<string, unknown>>
    assert.equal(limpio.$schema, undefined)
    assert.equal(limpio.additionalProperties, undefined)
    assert.equal(props.a?.pattern, undefined)
    assert.deepEqual([props.b?.type, props.b?.nullable], ["string", true])
    assert.equal(props.c?.nullable, true)
  })
})
