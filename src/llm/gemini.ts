import { ErrorLLM, type DeclaracionHerramienta, type Mensaje, type ProveedorLLM, type RespuestaLLM } from "./adapter.ts"

type Parte = { text?: string; functionCall?: { name: string; args?: Record<string, unknown> }; functionResponse?: { name: string; response: Record<string, unknown> }; thoughtSignature?: string }
type Contenido = { role: "user" | "model"; parts: Parte[] }
type RespuestaGemini = { candidates?: { content?: { parts?: Parte[] } }[]; usageMetadata?: { totalTokenCount?: number }; error?: { message?: string } }

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

export class Gemini implements ProveedorLLM {
  readonly nombre = "gemini"
  constructor(
    private readonly clave: string,
    readonly modelo: string,
    private readonly timeoutMs: number,
  ) {}

  async enviar(mensajes: Mensaje[], herramientas: DeclaracionHerramienta[]): Promise<RespuestaLLM> {
    const sistema = mensajes.filter((m) => m.rol === "sistema").map((m) => (m.rol === "sistema" ? m.texto : "")).join("\n\n")
    const cuerpo = {
      systemInstruction: { parts: [{ text: sistema }] },
      contents: aContenidos(mensajes),
      tools: [{ functionDeclarations: herramientas.map((h) => ({ name: h.nombre, description: h.descripcion, parameters: limpiarEsquema(h.parametros) })) }],
      generationConfig: { temperature: 0 },
    }
    let res: Response
    try {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${this.modelo}:generateContent`, {
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
    const json = (await res.json().catch(() => ({}))) as RespuestaGemini
    if (!res.ok) throw new ErrorLLM(`El proveedor del modelo respondió ${res.status}: ${json.error?.message ?? "error sin detalle"}`)
    const partes = json.candidates?.[0]?.content?.parts ?? []
    return {
      texto: partes.map((p) => p.text ?? "").join("").trim(),
      llamadas: partes.filter((p) => p.functionCall).map((p, i) => ({ id: `llamada-${i}`, nombre: p.functionCall?.name ?? "", argumentos: p.functionCall?.args ?? {} })),
      tokens: json.usageMetadata?.totalTokenCount ?? 0,
      crudo: partes,
    }
  }
}
