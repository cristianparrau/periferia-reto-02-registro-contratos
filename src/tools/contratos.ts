import { extname, join, relative } from "node:path"
import { z } from "zod"
import { agregarLinea, copiarArchivo, escribirTexto } from "../core/archivos.ts"
import { fechaReferencia } from "../core/fechas.ts"
import { registrar as log } from "../core/log.ts"
import { definirHerramienta, fallo, ok, type ContextoHerramienta, type Resultado } from "../core/tipos.ts"
import { alertasMarkdown, calcularAlertas } from "../dominio/alertas.ts"
import { leerMensaje, listarMensajes, resolverComercial } from "../dominio/buzon.ts"
import { clasificar, valoresPresentes, type Resultado as Clasif } from "../dominio/clasificacion.ts"
import { extraer as extraerTexto, MONEDAS, type Contrato } from "../dominio/extraccion.ts"
import { guardarMaestro, leerMaestro, leerProcesados, marcarProcesado, RUTAS, type Fila } from "../dominio/maestro.ts"
import { slug } from "../dominio/texto.ts"

const argMensaje = z.string().regex(/^[a-z0-9-]+$/, "mensaje_id inválido").describe("Id del mensaje en el buzón, ej. msg-001")

async function responder<T>(ctx: ContextoHerramienta, herramienta: string, mensajeId: string | null, r: Resultado<T>, resumen: (d: T) => string): Promise<string> {
  await log(ctx.directory, { herramienta, sessionId: ctx.sessionId, ok: r.ok, resumen: `${mensajeId ? `[${mensajeId}] ` : ""}${r.ok ? resumen(r.data) : r.error}` })
  return JSON.stringify(r)
}

async function seguro<T>(fn: () => Promise<Resultado<T>>): Promise<Resultado<T>> {
  try {
    return await fn()
  } catch (e) {
    return fallo(`Error inesperado: ${e instanceof Error ? e.message : "desconocido"}`)
  }
}

type Analisis = { contrato: Contrato; clasificacion: Clasif; comercial: string | null; avisos: string[]; adjunto: string | null }

/** Extrae y clasifica siempre desde el documento: el modelo no transporta valores entre herramientas. */
async function analizar(dir: string, mensajeId: string): Promise<Resultado<Analisis>> {
  const m = await leerMensaje(dir, mensajeId)
  if (!m.ok) return m
  const comercial = await resolverComercial(dir, m.data.correo.de)
  const avisos = comercial.aviso ? [comercial.aviso] : []
  if (!m.data.tiene_contrato || !m.data.texto) {
    const vacio = extraerTexto(" ", "").contrato
    return ok({ contrato: vacio, comercial: comercial.nombre, avisos, adjunto: null, clasificacion: { clasificacion: "rechazado", id_contrato_existente: null, diferencias: [], requiere_revision: [], motivo: `Sin adjunto de contrato (adjuntos: ${m.data.correo.adjuntos.join(", ") || "ninguno"}).` } })
  }
  const e = extraerTexto(m.data.texto, m.data.correo.fecha.slice(0, 10))
  if (e.errores.length) return fallo(e.errores.join(" "))
  return ok({ contrato: e.contrato, comercial: comercial.nombre, avisos, adjunto: m.data.adjunto, clasificacion: clasificar(e.contrato, await leerMaestro(dir)) })
}

export const leer_buzon = definirHerramienta({
  description: "Lista los mensajes del buzón de contratos que aún no se han procesado, indicando si traen un contrato adjunto.",
  args: {},
  async execute(_args, ctx) {
    const r = await seguro(async () => {
      const procesados = await leerProcesados(ctx.directory)
      const mensajes = []
      for (const id of (await listarMensajes(ctx.directory)).filter((x) => !procesados[x])) {
        const m = await leerMensaje(ctx.directory, id)
        if (!m.ok) { mensajes.push({ id, error: m.error }); continue }
        const c = m.data.correo
        mensajes.push({ id, de: c.de, asunto: c.asunto, fecha: c.fecha, adjuntos: c.adjuntos, tiene_contrato: m.data.tiene_contrato, ...(m.data.tiene_contrato ? {} : { clasificacion: "rechazado", motivo: "El mensaje no trae un contrato adjunto." }) })
      }
      return ok({ mensajes })
    })
    return responder(ctx, "contratos_leer_buzon", null, r, (d) => `${d.mensajes.length} mensaje(s) pendiente(s)`)
  },
})

export const extraer = definirHerramienta({
  description: "Extrae los datos del contrato adjunto a un mensaje (partes, valor, moneda, fechas, pólizas) con un nivel de confianza por campo.",
  args: { mensaje_id: argMensaje },
  async execute({ mensaje_id }, ctx) {
    const r = await seguro(async () => {
      const a = await analizar(ctx.directory, mensaje_id)
      if (!a.ok) return a
      if (!a.data.adjunto) return fallo(`El mensaje ${mensaje_id} no trae contrato: ${a.data.clasificacion.motivo}`)
      return ok({ ...a.data.contrato, comercial: a.data.comercial, avisos: a.data.avisos })
    })
    return responder(ctx, "contratos_extraer", mensaje_id, r, (d) => `${d.id_contrato.valor ?? "sin id"} · ${d.cliente.valor} · ${d.valor.valor} ${d.moneda.valor ?? ""}`)
  },
})

export const validar = definirHerramienta({
  description: "Clasifica el contrato de un mensaje como nuevo, actualizacion, duplicado o rechazado frente al maestro y lista los campos que requieren revisión humana.",
  args: { mensaje_id: argMensaje },
  async execute({ mensaje_id }, ctx) {
    const r = await seguro(async () => {
      const a = await analizar(ctx.directory, mensaje_id)
      if (!a.ok) return a
      const c = a.data.clasificacion
      const detalle = Object.fromEntries(c.requiere_revision.map((campo) => {
        const f = a.data.contrato[campo as keyof Contrato]
        return [campo, typeof f === "object" && f !== null && "valor" in f ? { propuesto: f.valor, confianza: f.confianza, evidencia: f.evidencia } : { propuesto: null, confianza: 0, evidencia: null }]
      }))
      return ok({ ...c, detalle_revision: detalle, comercial: a.data.comercial, avisos: a.data.avisos })
    })
    return responder(ctx, "contratos_validar", mensaje_id, r, (d) => `${d.clasificacion}${d.requiere_revision.length ? `, revisar: ${d.requiere_revision.join(", ")}` : ""}`)
  },
})

const Correcciones = z.object({
  valor: z.number().nonnegative().optional().describe("Valor confirmado por el usuario"),
  moneda: z.enum(MONEDAS).optional().describe("Moneda confirmada"),
  fecha_inicio: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Fecha de inicio confirmada YYYY-MM-DD"),
  fecha_fin: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Fecha de fin confirmada YYYY-MM-DD"),
  cliente: z.string().optional().describe("Razón social confirmada"),
  nit_cliente: z.string().optional().describe("Identificador tributario confirmado, sin DV"),
  objeto: z.string().max(200).optional().describe("Objeto confirmado"),
})
type Correcciones = z.infer<typeof Correcciones>

function nuevaFila(k: Contrato, valores: Partial<Record<string, string>>, comercial: string | null, ruta: string, hoy: string, id: string): Fila {
  const requiere = valores.requiere_poliza === "true"
  return {
    id_contrato: id, cliente: valores.cliente ?? "", nit_cliente: valores.nit_cliente ?? "", pais: valores.pais ?? "", objeto: (valores.objeto ?? "").slice(0, 200),
    valor: valores.valor ?? "0", moneda: valores.moneda ?? "", fecha_inicio: valores.fecha_inicio ?? "", fecha_fin: valores.fecha_fin ?? "",
    requiere_poliza: String(requiere), tipo_poliza: requiere ? (valores.tipo_poliza ?? "") : "", estado_poliza: requiere ? "pendiente" : "no_aplica",
    comercial: comercial ?? "", ruta_sharepoint: ruta, fecha_registro: hoy, fuente: "buzon",
  }
}

/** Aplica solo las correcciones de campos que estaban en revisión; el resto sale del documento. */
function aplicarCorrecciones(valores: Partial<Record<string, string>>, correcciones: Correcciones | undefined, enRevision: string[]): { valores: Partial<Record<string, string>>; aplicadas: string[]; ignoradas: string[] } {
  const salida = { ...valores }
  const aplicadas: string[] = [], ignoradas: string[] = []
  for (const [campo, v] of Object.entries(correcciones ?? {})) {
    if (v === undefined) continue
    if (enRevision.includes(campo)) { salida[campo] = String(v); aplicadas.push(`${campo}=${v}`) } else ignoradas.push(campo)
  }
  return { valores: salida, aplicadas, ignoradas }
}

type Registro = { id_contrato: string | null; accion: string; ruta_archivo: string | null; motivo?: string | null; confirmados?: string[]; ignorados?: string[]; cambios?: unknown[] }

export const registrar = definirHerramienta({
  description: "Registra o actualiza el contrato en el maestro y lo archiva en SharePoint; si hay campos en revisión exige confirmado=true tras confirmación explícita del usuario.",
  args: {
    mensaje_id: argMensaje,
    contrato: Correcciones.optional().describe("Solo valores corregidos o confirmados por el usuario para campos en revisión"),
    confirmado: z.boolean().optional().describe("true solo si el usuario confirmó explícitamente los campos en revisión en su último mensaje"),
  },
  async execute({ mensaje_id, contrato: correcciones, confirmado }, ctx) {
    const r = await seguro<Registro>(async () => {
      const a = await analizar(ctx.directory, mensaje_id)
      if (!a.ok) return a
      const { clasificacion: c, contrato: k } = a.data
      if (c.clasificacion === "rechazado" || c.clasificacion === "duplicado") {
        await marcarProcesado(ctx.directory, mensaje_id, c.clasificacion, c.id_contrato_existente, c.motivo)
        return ok({ id_contrato: c.id_contrato_existente, accion: c.clasificacion === "duplicado" ? "sin_cambios (duplicado)" : "rechazado", ruta_archivo: null, motivo: c.motivo })
      }
      if (c.requiere_revision.length > 0 && !(confirmado === true && ctx.confirmacionHumana !== false)) {
        return fallo(`requiere revisión: ${c.requiere_revision.join(", ")}. Confirma o corrige esos campos antes de registrar.`)
      }
      const corr = aplicarCorrecciones(valoresPresentes(k), correcciones, c.requiere_revision)
      const hoy = fechaReferencia()
      const maestro = await leerMaestro(ctx.directory)
      const ext = extname(a.data.adjunto ?? ".txt")
      if (c.clasificacion === "nuevo") {
        const anio = (corr.valores.fecha_inicio ?? hoy).slice(0, 4)
        const id = corr.valores.id_contrato ?? `AUTO-${anio}-${String(maestro.filter((f) => f.id_contrato.startsWith(`AUTO-${anio}`)).length + 1).padStart(3, "0")}`
        const ruta = `Contratos/${anio}/${slug(corr.valores.cliente ?? "sin-cliente")}/${id}${ext}`
        await copiarArchivo(join(RUTAS.buzon(ctx.directory), mensaje_id, a.data.adjunto ?? ""), join(RUTAS.sharepoint(ctx.directory), ruta))
        await guardarMaestro(ctx.directory, [...maestro, nuevaFila(k, corr.valores, a.data.comercial, ruta, hoy, id)])
        await agregarLinea(RUTAS.historial(ctx.directory), JSON.stringify({ ts: new Date().toISOString(), id_contrato: id, accion: "insercion", cambios: { confirmado_por_humano: corr.aplicadas }, mensaje_id }))
        await marcarProcesado(ctx.directory, mensaje_id, "nuevo", id, null)
        return ok({ id_contrato: id, accion: "insertado", ruta_archivo: `out/sharepoint/${ruta}`, confirmados: corr.aplicadas, ignorados: corr.ignoradas })
      }
      const fila = maestro.find((f) => f.id_contrato === c.id_contrato_existente)
      if (!fila) return fallo("El contrato a actualizar ya no está en el maestro.")
      const cambios = c.diferencias.map((d) => ({ ...d, despues: (corr.valores as Record<string, string | undefined>)[d.campo] ?? d.despues }))
      for (const d of cambios) (fila as Record<string, string>)[d.campo] = d.despues
      const ruta = `Contratos/${fila.fecha_inicio.slice(0, 4)}/${slug(fila.cliente)}/${fila.id_contrato}-${mensaje_id}${ext}`
      await copiarArchivo(join(RUTAS.buzon(ctx.directory), mensaje_id, a.data.adjunto ?? ""), join(RUTAS.sharepoint(ctx.directory), ruta))
      await guardarMaestro(ctx.directory, maestro)
      await agregarLinea(RUTAS.historial(ctx.directory), JSON.stringify({ ts: new Date().toISOString(), id_contrato: fila.id_contrato, accion: k.es_otrosi ? "otrosi" : "actualizacion", cambios, documento: ruta, mensaje_id }))
      await marcarProcesado(ctx.directory, mensaje_id, "actualizacion", fila.id_contrato, null)
      return ok({ id_contrato: fila.id_contrato, accion: "actualizado", ruta_archivo: `out/sharepoint/${ruta}`, cambios })
    })
    return responder(ctx, "contratos_registrar", mensaje_id, r, (d) => `${d.accion} ${d.id_contrato ?? ""}`)
  },
})

export const alertas = definirHerramienta({
  description: "Genera el reporte de alertas (contratos que vencen en 60 días o menos, pólizas no vigentes y registros desde el corte) a una fecha dada.",
  args: { hoy: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "fecha inválida, use YYYY-MM-DD").describe("Fecha de referencia YYYY-MM-DD") },
  async execute({ hoy }, ctx) {
    const r = await seguro(async () => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(hoy) || Number.isNaN(Date.parse(hoy))) return fallo(`Fecha inválida "${hoy}": use el formato YYYY-MM-DD.`)
      const a = calcularAlertas(await leerMaestro(ctx.directory), hoy)
      await escribirTexto(RUTAS.alertas(ctx.directory), alertasMarkdown(a, hoy))
      return ok({ ruta: relative(ctx.directory, RUTAS.alertas(ctx.directory)).replaceAll("\\", "/"), ...a })
    })
    return responder(ctx, "contratos_alertas", null, r, (d) => `${d.vencen.length} por vencer, ${d.polizas_pendientes.length} pólizas pendientes, ${d.registrados_desde_corte.length} desde el corte`)
  },
})
