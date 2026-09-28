import { z } from "zod"
import type { DeclaracionHerramienta } from "../llm/adapter.ts"
import type { ContextoHerramienta, Herramienta } from "./tipos.ts"
import { registrar } from "./log.ts"

type HerramientaGenerica = Herramienta<z.ZodRawShape>

/** Registra los exports de un módulo de herramientas con el nombre "<archivo>_<export>". */
export class RegistroHerramientas {
  private readonly mapa = new Map<string, HerramientaGenerica>()

  agregar(prefijo: string, modulo: Record<string, HerramientaGenerica>): this {
    for (const [nombre, h] of Object.entries(modulo)) this.mapa.set(`${prefijo}_${nombre}`, h)
    return this
  }

  declaraciones(): DeclaracionHerramienta[] {
    return [...this.mapa].map(([nombre, h]) => ({ nombre, descripcion: h.description, parametros: z.toJSONSchema(z.object(h.args)) as Record<string, unknown> }))
  }

  /** Valida con zod antes de ejecutar; un argumento inválido vuelve al modelo como error, no como excepción. */
  async ejecutar(nombre: string, argumentos: unknown, ctx: ContextoHerramienta): Promise<string> {
    const h = this.mapa.get(nombre)
    if (!h) return JSON.stringify({ ok: false, error: `Herramienta desconocida: ${nombre}` })
    const validado = z.object(h.args).safeParse(argumentos)
    if (!validado.success) {
      const error = `Argumentos inválidos para ${nombre}: ${validado.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`
      await registrar(ctx.directory, { herramienta: nombre, ok: false, resumen: error, sessionId: ctx.sessionId })
      return JSON.stringify({ ok: false, error })
    }
    try {
      return await h.execute(validado.data, ctx)
    } catch {
      return JSON.stringify({ ok: false, error: `La herramienta ${nombre} falló de forma inesperada.` })
    }
  }
}
