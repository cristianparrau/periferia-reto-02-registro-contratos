import { z } from "zod"

const entero = (nombre: string, def: number, min: number, max: number) =>
  z.preprocess(
    (v) => (v === undefined || String(v).trim() === "" ? def : Number(String(v).trim())),
    z.number({ error: `${nombre} debe ser un número` }).int(`${nombre} debe ser entero`).min(min, `${nombre} debe ser ≥ ${min}`).max(max, `${nombre} debe ser ≤ ${max}`),
  )

const opcional = (s: z.ZodString) => z.string().trim().optional().transform((v) => (v ? v : undefined)).pipe(s.optional())

/** Variables de entorno validadas al arrancar: un valor inválido detiene el servidor con un mensaje claro. */
export const EntornoSchema = z.object({
  LLM_PROVIDER: z.string().trim().optional().transform((v) => v || "gemini").pipe(z.enum(["gemini"], { error: "LLM_PROVIDER no soportado (use gemini)" })),
  GEMINI_API_KEY: opcional(z.string().min(20, "GEMINI_API_KEY parece incompleta (muy corta)").regex(/^\S+$/, "GEMINI_API_KEY no debe tener espacios")),
  GEMINI_MODEL: z.string().trim().optional().transform((v) => v || "gemini-2.5-flash").pipe(z.string().regex(/^[\w.-]+$/, "GEMINI_MODEL inválido")),
  MAX_ITERACIONES: entero("MAX_ITERACIONES", 25, 1, 100),
  MAX_TOKENS_SESION: entero("MAX_TOKENS_SESION", 200000, 1000, 10_000_000),
  LLM_TIMEOUT_MS: entero("LLM_TIMEOUT_MS", 60000, 1000, 600000),
  PORT: entero("PORT", 3000, 1, 65535),
  FECHA_REFERENCIA: opcional(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "FECHA_REFERENCIA debe tener formato YYYY-MM-DD").refine((v) => !Number.isNaN(Date.parse(v)), "FECHA_REFERENCIA no es una fecha válida")),
})
export type Entorno = z.infer<typeof EntornoSchema>

export type ResultadoEntorno = { ok: true; entorno: Entorno; avisos: string[] } | { ok: false; errores: string[] }

export function cargarEntorno(fuente: Record<string, string | undefined> = process.env): ResultadoEntorno {
  const r = EntornoSchema.safeParse(fuente)
  if (!r.success) return { ok: false, errores: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }
  const avisos = r.data.GEMINI_API_KEY ? [] : ["GEMINI_API_KEY no está definida: el chat responderá que no hay modelo configurado (demo y tests funcionan sin ella)."]
  return { ok: true, entorno: r.data, avisos }
}

/** Para mostrar en consola sin exponer la clave: primeros 4 caracteres y longitud. */
export function enmascarar(clave: string | undefined): string {
  return clave ? `${clave.slice(0, 4)}…(${clave.length} caracteres)` : "(no definida)"
}
