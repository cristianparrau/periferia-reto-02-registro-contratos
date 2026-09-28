import type { z } from "zod"

/** Resultado tipado: ninguna función de dominio lanza excepciones hacia el agente. */
export type Resultado<T> = { ok: true; data: T } | { ok: false; error: string }

/** Contexto que el backend (o demo.ts) entrega a cada herramienta. */
export type ContextoHerramienta = {
  directory: string
  sessionId: string
  /** true solo si el usuario confirmó en el turno inmediatamente anterior. undefined = invocación directa (demo). */
  confirmacionHumana?: boolean
}

/** Contrato de herramienta exigido por el PRD: description + args (zod) + execute → string JSON. */
export type Herramienta<S extends z.ZodRawShape> = {
  description: string
  args: S
  execute(args: z.infer<z.ZodObject<S>>, ctx: ContextoHerramienta): Promise<string>
}

export function definirHerramienta<S extends z.ZodRawShape>(h: Herramienta<S>): Herramienta<S> {
  return h
}

export function ok<T>(data: T): Resultado<T> {
  return { ok: true, data }
}

export function fallo<T = never>(error: string): Resultado<T> {
  return { ok: false, error }
}
