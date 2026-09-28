import type { Contrato } from "./extraccion.ts"
import type { Fila } from "./maestro.ts"

export type Clasificacion = "nuevo" | "actualizacion" | "duplicado" | "rechazado"
export type Diferencia = { campo: string; antes: string; despues: string }
export type Resultado = { clasificacion: Clasificacion; id_contrato_existente: string | null; diferencias: Diferencia[]; requiere_revision: string[]; motivo: string | null }

export const UMBRAL = 0.8
const CAMPOS_REVISABLES = ["id_contrato", "cliente", "nit_cliente", "pais", "objeto", "valor", "moneda", "fecha_inicio", "fecha_fin", "requiere_poliza", "tipo_poliza"] as const

/** Similitud de Jaccard por palabras (≥ 4 letras) para comparar objetos de contrato. */
export function similitudObjeto(a: string, b: string): number {
  const palabras = (t: string) => new Set(t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().split(/\W+/).filter((w) => w.length >= 4))
  const x = palabras(a), y = palabras(b)
  const comunes = [...x].filter((w) => y.has(w)).length
  return x.size + y.size === 0 ? 0 : comunes / (x.size + y.size - comunes)
}

/** Valores del contrato como texto de maestro (solo los campos presentes en el documento). */
export function valoresPresentes(k: Contrato): Partial<Record<string, string>> {
  const salida: Partial<Record<string, string>> = {}
  for (const campo of CAMPOS_REVISABLES) {
    const v = k[campo].valor
    if (v !== null) salida[campo] = String(v)
  }
  return salida
}

/** RN5: confianza < 0.8. En un otrosí, los campos ausentes no se revisan: se conservan del maestro. */
function camposEnRevision(k: Contrato): string[] {
  return CAMPOS_REVISABLES.filter((campo) => {
    const f = k[campo]
    if (k.es_otrosi && f.valor === null) return false
    return f.confianza < UMBRAL
  })
}

function diferencias(k: Contrato, fila: Fila): Diferencia[] {
  const presentes = valoresPresentes(k)
  const salida: Diferencia[] = []
  for (const campo of ["valor", "moneda", "fecha_inicio", "fecha_fin"] as const) {
    const nuevo = presentes[campo]
    if (nuevo !== undefined && nuevo !== fila[campo]) salida.push({ campo, antes: fila[campo], despues: nuevo })
  }
  if (k.ampliar_polizas && fila.requiere_poliza === "true" && fila.estado_poliza !== "pendiente") {
    salida.push({ campo: "estado_poliza", antes: fila.estado_poliza, despues: "pendiente" })
  }
  return salida
}

/** RN1–RN4. Dedupe por id y luego por NIT + objeto (nunca por nombre del cliente). */
export function clasificar(k: Contrato, maestro: Fila[]): Resultado {
  const revision = camposEnRevision(k)
  if (!k.cliente.valor || (!k.objeto.valor && !k.es_otrosi)) {
    return { clasificacion: "rechazado", id_contrato_existente: null, diferencias: [], requiere_revision: [], motivo: "El texto no contiene partes u objeto identificables." }
  }
  const porId = k.id_contrato.valor ? maestro.find((f) => f.id_contrato === k.id_contrato.valor) : undefined
  const porObjeto = !porId && k.nit_cliente.valor && k.objeto.valor ? maestro.find((f) => f.nit_cliente === k.nit_cliente.valor && similitudObjeto(f.objeto, k.objeto.valor ?? "") >= 0.9) : undefined
  const existente = porId ?? porObjeto
  if (!existente) {
    if (k.es_otrosi) return { clasificacion: "rechazado", id_contrato_existente: null, diferencias: [], requiere_revision: revision, motivo: `Otrosí de un contrato (${k.id_contrato.valor}) que no está en el maestro: registrar primero el contrato original.` }
    return { clasificacion: "nuevo", id_contrato_existente: null, diferencias: [], requiere_revision: revision, motivo: null }
  }
  const difs = diferencias(k, existente)
  if (difs.length === 0 && !k.es_otrosi) return { clasificacion: "duplicado", id_contrato_existente: existente.id_contrato, diferencias: [], requiere_revision: [], motivo: "Mismo contrato, valor y fechas que el registro existente." }
  const conflicto = porObjeto && !porId ? [`id_contrato (el documento dice ${k.id_contrato.valor ?? "sin número"}; coincide por NIT+objeto con ${existente.id_contrato})`] : []
  return { clasificacion: "actualizacion", id_contrato_existente: existente.id_contrato, diferencias: difs, requiere_revision: [...revision, ...conflicto], motivo: k.es_otrosi ? "Otrosí de un contrato existente." : null }
}
