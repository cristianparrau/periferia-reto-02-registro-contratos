import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { ErrorLLM, type Mensaje, type ProveedorLLM } from "./llm/adapter.ts"
import type { RegistroHerramientas } from "./core/registro-herramientas.ts"

export const MARCA_CONFIRMACION = "[CONFIRMAR]"

export type Sesion = { id: string; mensajes: Mensaje[]; tokens: number; esperandoConfirmacion: boolean }

export type LlamadaVisible = { nombre: string; argumentos: Record<string, unknown>; ok: boolean; resumen: string }

export type ResultadoTurno = { reply: string; toolCalls: LlamadaVisible[]; needsConfirmation: boolean }

export type ConfigAgente = { directorio: string; maxIteraciones: number; maxTokensSesion: number }

/** Comportamiento (agent/prompt.md) + conocimiento (todos los .md de src/knowledge) forman la instrucción de sistema. */
export async function cargarInstrucciones(directorio: string): Promise<string> {
  const prompt = await readFile(join(directorio, "agent", "prompt.md"), "utf8")
  const carpeta = join(directorio, "src", "knowledge")
  const archivos = (await readdir(carpeta)).filter((f) => f.endsWith(".md")).sort()
  const conocimiento = await Promise.all(archivos.map((f) => readFile(join(carpeta, f), "utf8")))
  return `${prompt}\n\n---\n# Conocimiento del proceso\n\n${conocimiento.join("\n\n")}`
}

/** Afirmación explícita del humano. Cualquier negación o duda anula la confirmación. */
export function esConfirmacion(texto: string): boolean {
  const t = texto.trim().toLowerCase()
  // Sin \b: en JavaScript \b no reconoce letras con tilde ("sí"), así que se delimita con espacios/puntuación.
  const fin = "(?=$|[\\s,.;:!?])"
  if (new RegExp(`(^|[\\s,.;:¡¿])(no|todav[ií]a|espera|cancela|cancelar)${fin}`).test(t)) return false
  return new RegExp(`^[¡¿]?(s[ií]|confirmo|confirmado|env[ií]a|env[ií]alo|adelante|procede|ok|de acuerdo|dale)${fin}`).test(t)
}

function resumir(contenido: string): { ok: boolean; resumen: string } {
  try {
    const r = JSON.parse(contenido) as { ok: boolean; error?: string; data?: unknown }
    return { ok: r.ok, resumen: r.ok ? JSON.stringify(r.data).slice(0, 300) : (r.error ?? "error") }
  } catch {
    return { ok: false, resumen: "respuesta no JSON" }
  }
}

export class Agente {
  constructor(
    private readonly llm: ProveedorLLM | null,
    private readonly herramientas: RegistroHerramientas,
    private readonly instrucciones: string,
    private readonly config: ConfigAgente,
  ) {}

  async turno(sesion: Sesion, texto: string): Promise<ResultadoTurno> {
    // CA3/RN4: la confirmación solo vale si el turno anterior la pidió y este mensaje la da.
    const confirmacionHumana = sesion.esperandoConfirmacion && esConfirmacion(texto)
    sesion.esperandoConfirmacion = false
    sesion.mensajes.push({ rol: "usuario", texto })
    const visibles: LlamadaVisible[] = []
    if (!this.llm) return this.cerrar(sesion, "No hay un modelo configurado (falta GEMINI_API_KEY en el servidor).", visibles)

    for (let i = 0; i < this.config.maxIteraciones; i++) {
      if (sesion.tokens >= this.config.maxTokensSesion) return this.cerrar(sesion, "Se alcanzó el tope de tokens de esta sesión. Abre una sesión nueva para continuar.", visibles)
      let respuesta
      try {
        respuesta = await this.llm.enviar([{ rol: "sistema", texto: this.instrucciones }, ...sesion.mensajes], this.herramientas.declaraciones())
      } catch (e) {
        const detalle = e instanceof ErrorLLM ? e.message : "Error desconocido del proveedor."
        return this.cerrar(sesion, `No pude completar la respuesta: ${detalle} Tu sesión sigue activa; intenta de nuevo.`, visibles)
      }
      sesion.tokens += respuesta.tokens
      sesion.mensajes.push({ rol: "asistente", texto: respuesta.texto, llamadas: respuesta.llamadas, crudo: respuesta.crudo })
      if (respuesta.llamadas.length === 0) return this.finalizar(sesion, respuesta.texto, visibles)

      const resultados = []
      for (const l of respuesta.llamadas) {
        const ctx = { directory: this.config.directorio, sessionId: sesion.id, confirmacionHumana }
        const contenido = await this.herramientas.ejecutar(l.nombre, l.argumentos, ctx)
        visibles.push({ nombre: l.nombre, argumentos: l.argumentos, ...resumir(contenido) })
        resultados.push({ id: l.id, nombre: l.nombre, contenido })
      }
      sesion.mensajes.push({ rol: "herramienta", resultados })
    }
    const hechas = visibles.map((v) => v.nombre).join(", ")
    return this.cerrar(sesion, `Alcancé el tope de ${this.config.maxIteraciones} pasos en este turno. Alcancé a ejecutar: ${hechas}. Pídeme continuar para completar lo que falta.`, visibles)
  }

  private finalizar(sesion: Sesion, texto: string, visibles: LlamadaVisible[]): ResultadoTurno {
    const needsConfirmation = texto.includes(MARCA_CONFIRMACION)
    sesion.esperandoConfirmacion = needsConfirmation
    return { reply: texto.replaceAll(MARCA_CONFIRMACION, "").trim(), toolCalls: visibles, needsConfirmation }
  }

  private cerrar(sesion: Sesion, texto: string, visibles: LlamadaVisible[]): ResultadoTurno {
    sesion.mensajes.push({ rol: "asistente", texto, llamadas: [] })
    return { reply: texto, toolCalls: visibles, needsConfirmation: false }
  }
}
