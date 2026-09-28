import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { z } from "zod"
import { Agente, esConfirmacion, type Sesion } from "../src/agente.ts"
import { RegistroHerramientas } from "../src/core/registro-herramientas.ts"
import { definirHerramienta } from "../src/core/tipos.ts"
import { ErrorLLM, type ProveedorLLM, type RespuestaLLM } from "../src/llm/adapter.ts"

/** Modelo guionizado: devuelve respuestas predefinidas para probar el ciclo sin API. */
class Guion implements ProveedorLLM {
  readonly nombre = "guion"
  readonly modelo = "test"
  recibidas = 0
  constructor(private readonly pasos: RespuestaLLM[]) {}
  async enviar(): Promise<RespuestaLLM> {
    return this.pasos[this.recibidas++] ?? { texto: "fin", llamadas: [], tokens: 1 }
  }
}
const llamar = (nombre: string, argumentos: Record<string, unknown>): RespuestaLLM => ({ texto: "", llamadas: [{ id: "1", nombre, argumentos }], tokens: 10 })
const texto = (t: string): RespuestaLLM => ({ texto: t, llamadas: [], tokens: 5 })

// Herramientas de prueba: una accion externa que exige confirmación humana (igual contrato que las reales).
const accion = definirHerramienta({
  description: "Acción externa de prueba",
  args: { id: z.string().regex(/^[a-z0-9-]+$/).describe("id"), confirmado: z.boolean().optional().describe("confirmado") },
  async execute({ confirmado }, ctx) {
    if (!confirmado || ctx.confirmacionHumana === false) return JSON.stringify({ ok: false, error: "requiere confirmación explícita" })
    return JSON.stringify({ ok: true, data: { hecho: true } })
  },
})
const falla = definirHerramienta({ description: "Lanza", args: {}, async execute() { throw new Error("boom") } })
const registro = () => new RegistroHerramientas().agregar("prueba", { accion, falla })
const sesion = (): Sesion => ({ id: "s", mensajes: [], tokens: 0, esperandoConfirmacion: false })
const config = { directorio: ".", maxIteraciones: 25, maxTokensSesion: 100000 }

describe("ciclo del agente", () => {
  it("marca needsConfirmation y quita la marca [CONFIRMAR] del texto", async () => {
    const r = await new Agente(new Guion([texto("¿Envío?\n[CONFIRMAR]")]), registro(), "sistema", config).turno(sesion(), "prepara")
    assert.equal(r.needsConfirmation, true)
    assert.ok(!r.reply.includes("[CONFIRMAR]"))
  })

  it("ejecuta la acción solo si el turno anterior pidió confirmación y el usuario confirma", async () => {
    const s = sesion()
    const a = new Agente(new Guion([texto("¿Confirmas?\n[CONFIRMAR]"), llamar("prueba_accion", { id: "x", confirmado: true }), texto("Hecho")]), registro(), "sistema", config)
    await a.turno(s, "prepara")
    const r = await a.turno(s, "Sí, confirmo")
    assert.equal(r.toolCalls[0]?.ok, true)
  })

  it("bloquea la acción si el modelo se auto-confirma sin pregunta previa", async () => {
    const r = await new Agente(new Guion([llamar("prueba_accion", { id: "x", confirmado: true }), texto("ok")]), registro(), "sistema", config).turno(sesion(), "hazlo ya")
    assert.equal(r.toolCalls[0]?.ok, false)
    assert.match(r.toolCalls[0]?.resumen ?? "", /confirmación/)
  })

  it("bloquea la acción si el usuario responde con una negación", async () => {
    const s = sesion()
    const a = new Agente(new Guion([texto("¿Confirmas?\n[CONFIRMAR]"), llamar("prueba_accion", { id: "x", confirmado: true }), texto("ok")]), registro(), "sistema", config)
    await a.turno(s, "prepara")
    const r = await a.turno(s, "no, espera")
    assert.equal(r.toolCalls[0]?.ok, false)
  })

  it("valida argumentos con zod y devuelve el error al modelo (sin excepción)", async () => {
    const r = await new Agente(new Guion([llamar("prueba_accion", { id: "../../etc" }), texto("ok")]), registro(), "sistema", config).turno(sesion(), "x")
    assert.match(r.toolCalls[0]?.resumen ?? "", /Argumentos inválidos/)
  })

  it("una herramienta que lanza o no existe no rompe la sesión", async () => {
    const r = await new Agente(new Guion([llamar("prueba_falla", {}), llamar("no_existe", {}), texto("sigo vivo")]), registro(), "sistema", config).turno(sesion(), "x")
    assert.equal(r.toolCalls.length, 2)
    assert.ok(r.toolCalls.every((t) => !t.ok))
    assert.equal(r.reply, "sigo vivo")
  })

  it("respeta el tope de iteraciones por turno", async () => {
    const infinito = new Guion(Array.from({ length: 50 }, () => llamar("prueba_falla", {})))
    const r = await new Agente(infinito, registro(), "sistema", { ...config, maxIteraciones: 3 }).turno(sesion(), "x")
    assert.equal(infinito.recibidas, 3)
    assert.match(r.reply, /tope de 3 pasos/)
  })

  it("respeta el tope de tokens por sesión", async () => {
    const g = new Guion([texto("no debería llamarse")])
    const r = await new Agente(g, registro(), "sistema", config).turno({ ...sesion(), tokens: 100000 }, "x")
    assert.equal(g.recibidas, 0)
    assert.match(r.reply, /tope de tokens/)
  })

  it("un error del proveedor se informa en lenguaje claro y la sesión sigue", async () => {
    const roto: ProveedorLLM = { nombre: "x", modelo: "x", enviar: async () => { throw new ErrorLLM("El modelo no respondió en 60 s.") } }
    const s = sesion()
    const r = await new Agente(roto, registro(), "sistema", config).turno(s, "x")
    assert.match(r.reply, /no respondió en 60 s.*sesión sigue activa/s)
    assert.equal(s.mensajes.length, 2)
  })

  it("si el modelo falla en el turno de confirmación, la pregunta sigue vigente y el usuario puede repetir 'confirmo'", async () => {
    let fallar = false
    const pasos = [texto("¿Confirmas?\n[CONFIRMAR]"), llamar("prueba_accion", { id: "x", confirmado: true }), texto("Hecho")]
    let i = 0
    const inestable: ProveedorLLM = { nombre: "x", modelo: "x", enviar: async () => { if (fallar) { fallar = false; throw new ErrorLLM("saturado") } return pasos[i++] ?? texto("fin") } }
    const s = sesion()
    const a = new Agente(inestable, registro(), "sistema", config)
    await a.turno(s, "prepara")
    fallar = true
    const caido = await a.turno(s, "confirmo")
    assert.match(caido.reply, /saturado/)
    assert.equal(s.esperandoConfirmacion, true)
    const r = await a.turno(s, "confirmo")
    assert.equal(r.toolCalls[0]?.ok, true)
  })

  it("sin modelo configurado responde con un mensaje claro", async () => {
    const r = await new Agente(null, registro(), "sistema", config).turno(sesion(), "hola")
    assert.match(r.reply, /No hay un modelo configurado/)
  })
})

describe("detección de confirmación humana", () => {
  const casos: [string, boolean][] = [["Sí, confirmo", true], ["si", true], ["Confirmo", true], ["envía", true], ["Envíalo por favor", true], ["ok", true], ["¡Sí!", true], ["dale", true], ["No, cancela", false], ["no", false], ["sí pero todavía no", false], ["espera", false], ["qué soportes faltan?", false], ["sinceramente no sé", false], ["okey", false], ["confirmo que no", false]]
  for (const [t, esperado] of casos) it(`"${t}" → ${esperado}`, () => assert.equal(esConfirmacion(t), esperado))
})
