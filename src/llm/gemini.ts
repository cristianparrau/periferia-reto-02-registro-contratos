import { ErrorLLM, type DeclaracionHerramienta, type Mensaje, type ProveedorLLM, type RespuestaLLM } from "./adapter.ts"

type Parte = { text?: string; functionCall?: { name: string; args?: Record<string, unknown> }; functionResponse?: { name: string; response: Record<string, unknown> }; thoughtSignature?: string }
type Contenido = { role: "user" | "model"; parts: Parte[] }
type RespuestaGemini = { candidates?: { content?: { parts?: Parte[] } }[]; usageMetadata?: { totalTokenCount?: number }; error?: { message?: string; details?: { retryDelay?: string; violations?: { quotaId?: string }[] }[] } }

const ESPERA_MAXIMA_MS = 30_000

/** Cuota diaria agotada: esperar no sirve, se pasa directo al siguiente modelo. */
export function esCuotaDiaria(json: RespuestaGemini): boolean {
  return (json.error?.details ?? []).some((d) => (d.violations ?? []).some((v) => /PerDay/i.test(v.quotaId ?? "")))
}

/** Espera que sugiere Google en un 429 (RetryInfo.retryDelay, ej. "23s"), acotada; si no la hay, la del plan de reintentos. */
export function esperaSugerida(json: RespuestaGemini, porDefecto: number): number {
  const texto = json.error?.details?.find((d) => d.retryDelay)?.retryDelay
  const segundos = texto ? Number.parseFloat(texto) : Number.NaN
  return Number.isFinite(segundos) ? Math.min(Math.ceil(segundos * 1000), ESPERA_MAXIMA_MS) : porDefecto
}

/** Gemini acepta un subconjunto de OpenAPI: se quitan claves no soportadas y "null" se expresa como nullable. */
export function limpiarEsquema(nodo: unknown): unknown {
  if (Array.isArray(nodo)) return nodo.map(limpiarEsquema)
  if (typeof nodo !== "object" || nodo === null) return nodo
  const salida: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(nodo)) {
    if (k === "$schema" || k === "additionalProperties" || k === "pattern") continue
    salida[k] = limpiarEsquema(v)
  }
  if (Array.isArray(salida.type)) {
    const tipos = salida.type.filter((t) => t !== "null")
    if (tipos.length < salida.type.length) salida.nullable = true
    salida.type = tipos[0]
  }
  const opciones = salida.anyOf
  if (Array.isArray(opciones) && opciones.some((o) => (o as { type?: string }).type === "null")) {
    salida.anyOf = opciones.filter((o) => (o as { type?: string }).type !== "null")
    salida.nullable = true
  }
  return salida
}

function aContenidos(mensajes: Mensaje[]): Contenido[] {
  const salida: Contenido[] = []
  for (const m of mensajes) {
    if (m.rol === "usuario") salida.push({ role: "user", parts: [{ text: m.texto }] })
    if (m.rol === "asistente") {
      // Se reenvían las partes originales para conservar firmas de razonamiento del modelo.
      const crudo = Array.isArray(m.crudo) ? (m.crudo as Parte[]) : null
      const partes: Parte[] = crudo ?? [...(m.texto ? [{ text: m.texto }] : []), ...m.llamadas.map((l) => ({ functionCall: { name: l.nombre, args: l.argumentos } }))]
      salida.push({ role: "model", parts: partes })
    }
    if (m.rol === "herramienta") {
      salida.push({ role: "user", parts: m.resultados.map((r) => ({ functionResponse: { name: r.nombre, response: { resultado: r.contenido } } })) })
    }
  }
  return salida
}

/** Códigos transitorios de Google (saturación o cuota momentánea): se reintentan con espera creciente. */
const REINTENTABLES = new Set([429, 500, 503])
class ErrorSaturacion extends ErrorLLM {}
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class Gemini implements ProveedorLLM {
  readonly nombre = "gemini"
  constructor(
    private readonly clave: string,
    readonly modelo: string,
    private readonly timeoutMs: number,
    private readonly esperasReintentoMs: number[] = [2000, 5000],
    private readonly modelosRespaldo: string[] = [],
  ) {}

  /** Modelo principal con reintentos; si sigue saturado o sin cuota, un intento con cada modelo de respaldo en orden. */
  async enviar(mensajes: Mensaje[], herramientas: DeclaracionHerramienta[]): Promise<RespuestaLLM> {
    const modelos = [this.modelo, ...this.modelosRespaldo]
    for (const [i, modelo] of modelos.entries()) {
      try {
        return await this.enviarCon(modelo, mensajes, herramientas, i === 0 ? this.esperasReintentoMs : [])
      } catch (e) {
        if (!(e instanceof ErrorSaturacion) || i === modelos.length - 1) throw e
      }
    }
    throw new ErrorLLM("Sin modelos disponibles.")
  }

  private async enviarCon(modelo: string, mensajes: Mensaje[], herramientas: DeclaracionHerramienta[], esperas: number[]): Promise<RespuestaLLM> {
    const sistema = mensajes.filter((m) => m.rol === "sistema").map((m) => (m.rol === "sistema" ? m.texto : "")).join("\n\n")
    const cuerpo = {
      systemInstruction: { parts: [{ text: sistema }] },
      contents: aContenidos(mensajes),
      tools: [{ functionDeclarations: herramientas.map((h) => ({ name: h.nombre, description: h.descripcion, parameters: limpiarEsquema(h.parametros) })) }],
      generationConfig: { temperature: 0 },
    }
    let res: Response | null = null
    let json: RespuestaGemini = {}
    for (let intento = 0; intento <= esperas.length; intento++) {
      if (intento > 0) await esperar(esperaSugerida(json, esperas[intento - 1] ?? 0))
      try {
        res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`, {
          method: "POST",
          // La clave va en cabecera (no en la URL) para que no quede en logs de proxies.
          headers: { "content-type": "application/json", "x-goog-api-key": this.clave },
          body: JSON.stringify(cuerpo),
          signal: AbortSignal.timeout(this.timeoutMs),
        })
      } catch (e) {
        const timeout = e instanceof Error && e.name === "TimeoutError"
        throw new ErrorLLM(timeout ? `El modelo no respondió en ${this.timeoutMs / 1000} s.` : "No fue posible conectar con el proveedor del modelo.")
      }
      json = (await res.json().catch(() => ({}))) as RespuestaGemini
      if (!REINTENTABLES.has(res.status) || esCuotaDiaria(json)) break
    }
    if (!res?.ok) {
      if (res && REINTENTABLES.has(res.status)) throw new ErrorSaturacion(esCuotaDiaria(json) ? "Se agotó la cuota diaria del modelo (capa gratuita de Gemini) en todos los modelos configurados. Intenta más tarde o amplía la cuota del proyecto." : `El modelo está saturado en este momento (HTTP ${res.status})${this.modelosRespaldo.length ? ", también con los modelos de respaldo" : `; se reintentó ${esperas.length} veces`}. Intenta de nuevo en un minuto.`)
      throw new ErrorLLM(`El proveedor del modelo respondió ${res?.status}: ${json.error?.message ?? "error sin detalle"}`)
    }
    const partes = json.candidates?.[0]?.content?.parts ?? []
    return {
      texto: partes.map((p) => p.text ?? "").join("").trim(),
      llamadas: partes.filter((p) => p.functionCall).map((p, i) => ({ id: `llamada-${i}`, nombre: p.functionCall?.name ?? "", argumentos: p.functionCall?.args ?? {} })),
      tokens: json.usageMetadata?.totalTokenCount ?? 0,
      crudo: partes,
    }
  }
}
