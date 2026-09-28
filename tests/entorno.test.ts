import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { cargarEntorno, enmascarar } from "../src/core/entorno.ts"

describe("entorno (.env)", () => {
  it("aplica valores por defecto cuando no hay variables", () => {
    const r = cargarEntorno({})
    assert.ok(r.ok)
    assert.equal(r.entorno.MAX_ITERACIONES, 25)
    assert.equal(r.entorno.PORT, 3000)
    assert.equal(r.entorno.GEMINI_MODEL, "gemini-2.5-flash")
    assert.match(r.avisos[0] ?? "", /GEMINI_API_KEY no está definida/)
  })

  it("acepta un .env completo y convierte números", () => {
    const r = cargarEntorno({ GEMINI_API_KEY: "A".repeat(39), MAX_ITERACIONES: "10", MAX_TOKENS_SESION: "5000", LLM_TIMEOUT_MS: "3000", PORT: "8080", FECHA_REFERENCIA: "2026-09-03" })
    assert.ok(r.ok)
    assert.equal(r.entorno.MAX_ITERACIONES, 10)
    assert.equal(r.entorno.PORT, 8080)
    assert.equal(r.entorno.FECHA_REFERENCIA, "2026-09-03")
    assert.equal(r.avisos.length, 0)
  })

  it("trata las variables vacías como no definidas", () => {
    const r = cargarEntorno({ FECHA_REFERENCIA: "", GEMINI_API_KEY: "", PORT: " " })
    assert.ok(r.ok)
    assert.equal(r.entorno.FECHA_REFERENCIA, undefined)
    assert.equal(r.entorno.PORT, 3000)
  })

  it("rechaza valores inválidos con mensajes claros (un NaN no llega al ciclo del agente)", () => {
    const r = cargarEntorno({ MAX_ITERACIONES: "abc", PORT: "70000", FECHA_REFERENCIA: "03/09/2026", LLM_PROVIDER: "otro", GEMINI_API_KEY: "corta" })
    assert.ok(!r.ok)
    const texto = r.errores.join("\n")
    for (const v of ["MAX_ITERACIONES", "PORT", "FECHA_REFERENCIA", "LLM_PROVIDER", "GEMINI_API_KEY"]) assert.match(texto, new RegExp(v))
  })

  it("enmascara la clave al mostrarla", () => {
    const m = enmascarar("AQ.secreto-muy-largo-123")
    assert.ok(!m.includes("secreto"))
    assert.equal(enmascarar(undefined), "(no definida)")
  })
})
