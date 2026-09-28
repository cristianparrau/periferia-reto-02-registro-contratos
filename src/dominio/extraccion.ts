/** Extracción determinista (regex + heurísticas) del texto de un contrato u otrosí. Cada campo trae su confianza. */

export const MONEDAS = ["COP", "USD", "PEN", "PAB", "HNL"] as const
export type Moneda = (typeof MONEDAS)[number]
export type Pais = "CO" | "EC" | "PE" | "PA" | "HN"

export type Campo<T> = { valor: T | null; confianza: number; evidencia: string | null }

export type Contrato = {
  id_contrato: Campo<string>
  es_otrosi: boolean
  cliente: Campo<string>
  nit_cliente: Campo<string>
  pais: Campo<Pais>
  objeto: Campo<string>
  valor: Campo<number>
  valor_indeterminado: boolean
  moneda: Campo<Moneda>
  fecha_inicio: Campo<string>
  fecha_fin: Campo<string>
  requiere_poliza: Campo<boolean>
  tipo_poliza: Campo<string>
  ampliar_polizas: boolean
}

const MESES: Record<string, number> = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 }

const c = <T>(valor: NoInfer<T> | null, confianza: number, evidencia: string | null = null): Campo<T> => ({ valor, confianza: valor === null ? 0 : confianza, evidencia })

const pad = (n: number) => String(n).padStart(2, "0")

/** "primero (1) de agosto de 2026" → "2026-08-01". Usa el número entre paréntesis. */
export function fechaEnTexto(texto: string): string | null {
  const m = texto.match(/\((\d{1,2})\)\s+de\s+([a-záéíóú]+)\s+de\s+(\d{4})/i)
  const mes = m?.[2] ? MESES[m[2].toLowerCase()] : undefined
  if (!m?.[1] || !m[3] || !mes) return null
  const iso = `${m[3]}-${pad(mes)}-${pad(Number(m[1]))}`
  return Number.isNaN(Date.parse(iso)) ? null : iso
}

/** Suma meses y resta un día: 12 meses desde 2026-08-15 → 2027-08-14 (convención de los contratos). */
export function finPorMeses(inicio: string, meses: number): string {
  const d = new Date(inicio + "T00:00:00Z")
  d.setUTCMonth(d.getUTCMonth() + meses)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

/** Detecta separador decimal: "120,000.00" (US) y "265.000.000" (CO) → número. */
export function numero(texto: string): number | null {
  const limpio = texto.replace(/[^\d.,]/g, "")
  const ultimo = Math.max(limpio.lastIndexOf("."), limpio.lastIndexOf(","))
  const decimales = ultimo >= 0 && limpio.length - ultimo - 1 === 2
  const entero = decimales ? limpio.slice(0, ultimo) : limpio
  const n = Number(entero.replace(/[.,]/g, "") + (decimales ? "." + limpio.slice(ultimo + 1) : ""))
  return Number.isFinite(n) && limpio ? n : null
}

function titulo(texto: string): string {
  return texto.toLowerCase().replace(/(^|\s)(\p{L})/gu, (_, e: string, l: string) => e + l.toUpperCase()).replace(/S\.a\.s\./i, "S.A.S.").replace(/S\.a\.c\./i, "S.A.C.").replace(/S\.a\./, "S.A.")
}

function cliente(texto: string): { nombre: Campo<string>; id: Campo<string>; tipo: string | null } {
  const m = texto.match(/Entre\s+(?:los suscritos,\s*)?(.+?),\s*(?:identificada con\s+)?(NIT|RUC|RTN)\s+([\d.\-]+)/i)
  if (!m?.[1] || !m[2] || !m[3]) return { nombre: c<string>(null, 0), id: c<string>(null, 0), tipo: null }
  const tipo = m[2].toUpperCase()
  const id = tipo === "NIT" ? m[3].split("-")[0]!.replace(/\D/g, "") : m[3].replace(/\D/g, "")
  // El bloque de firmas trae la razón social con mayúsculas correctas: más confiable que el encabezado en MAYÚSCULAS.
  const firma = texto.split("\n").map((l) => l.trim().split(/\s{3,}/)[0] ?? "").find((l) => l && l.toLowerCase() === m[1]!.toLowerCase() && l !== m[1])
  return { nombre: firma ? c(firma, 0.95, "bloque de firmas") : c(titulo(m[1]), 0.85, "encabezado"), id: c(id, 0.95, `${tipo} ${m[3]}`), tipo }
}

function pais(texto: string, tipoId: string | null, id: string | null): Campo<Pais> {
  const dom = texto.match(/domicilio en\s+([^,\n]+(?:,\s*[^,\n]+)?)/i)?.[1] ?? ""
  const porNombre: [RegExp, Pais][] = [[/ecuador/i, "EC"], [/per[uú]/i, "PE"], [/panam[aá]/i, "PA"], [/honduras/i, "HN"], [/colombia|bogot[aá]|medell[ií]n|barranquilla|cali\b/i, "CO"]]
  for (const [re, p] of porNombre) if (re.test(dom)) return c(p, 0.9, `domicilio: ${dom}`)
  if (tipoId === "NIT") return c("CO", 0.85, "identificador NIT")
  if (tipoId === "RTN") return c("HN", 0.85, "identificador RTN")
  if (tipoId === "RUC" && id?.length === 13) return c("EC", 0.8, "RUC de 13 dígitos")
  if (tipoId === "RUC" && id?.length === 11) return c("PE", 0.8, "RUC de 11 dígitos")
  return c(null, 0)
}

function valor(texto: string, paisContrato: Pais | null): { valor: Campo<number>; moneda: Campo<Moneda>; indeterminado: boolean; monedaDesconocida: string | null } {
  // Toda la línea de la cláusula de VALOR: sirve para contratos ("VALOR. El valor…") y otrosíes ("(VALOR), la cual quedará así: …").
  const clausula = texto.split("\n").find((l) => /\bVALOR\b/.test(l)) ?? ""
  if (/no tiene un valor determinado|valor indeterminado|por demanda/i.test(clausula)) {
    const moneda = paisContrato === "CO" ? c<Moneda>("COP", 0.85, "contrato colombiano") : c<Moneda>(null, 0)
    return { valor: c(0, 0.5, "contrato sin valor determinado (por demanda)"), moneda, indeterminado: true, monedaDesconocida: null }
  }
  const m = clausula.match(/\(\s*([A-Z]{3})\s*\$?\s*([\d.,]+)\s*\)/)
  if (!m?.[1] || !m[2]) return { valor: c(null, 0), moneda: c(null, 0), indeterminado: false, monedaDesconocida: null }
  const moneda = MONEDAS.find((x) => x === m[1]) ?? null
  return { valor: c(numero(m[2]), 0.95, m[0]), moneda: c(moneda, 0.95, m[1]), indeterminado: false, monedaDesconocida: moneda ? null : m[1] }
}

function plazo(texto: string, esOtrosi: boolean, fechaCorreo: string): { inicio: Campo<string>; fin: Campo<string> } {
  const clausula = texto.match(/PLAZO[^\n]*/i)?.[0] ?? ""
  if (esOtrosi) {
    const fin = fechaEnTexto(clausula.split(/hasta/i)[1] ?? "")
    return { inicio: c(null, 0), fin: c(fin, 0.9, clausula.slice(0, 160)) }
  }
  const desde = clausula.match(/desde\s+(.+?)\s+hasta\s+(.+)/i)
  if (desde?.[1] && desde[2]) return { inicio: c(fechaEnTexto(desde[1]), 0.95, clausula.slice(0, 160)), fin: c(fechaEnTexto(desde[2]), 0.95, clausula.slice(0, 160)) }
  const meses = Number(clausula.match(/\((\d+)\)\s*meses/i)?.[1] ?? NaN)
  // Sin fecha de inicio explícita: se toma la fecha de firma; si solo hay mes y año, el día 1 con baja confianza.
  const firma = texto.match(/se firma[^\n]*/i)?.[0] ?? ""
  const exacta = fechaEnTexto(firma)
  const mesAnio = firma.match(/mes de\s+([a-záéíóú]+)\s+de\s+(\d{4})/i)
  const mesNum = mesAnio?.[1] ? MESES[mesAnio[1].toLowerCase()] : undefined
  // Mes y año conocidos: el inicio es confiable en el mes (0.8); el fin derivado hereda la duda del día y la prórroga automática (0.6).
  const inicio: Campo<string> = exacta ? c<string>(exacta, 0.85, "fecha de firma") : mesNum && mesAnio?.[2] ? c<string>(`${mesAnio[2]}-${pad(mesNum)}-01`, 0.8, `firma sin día exacto: "${firma.trim()}" (se asume día 1)`) : c<string>(fechaCorreo, 0.3, "fecha del correo")
  if (!Number.isFinite(meses) || !inicio.valor) return { inicio, fin: c(null, 0) }
  const prorroga = /prorrogable/i.test(clausula)
  const confianza = exacta ? 0.85 : 0.6
  return { inicio, fin: c(finPorMeses(inicio.valor, meses), confianza, `${meses} meses desde ${inicio.valor}${prorroga ? "; prorrogable automáticamente" : ""}`) }
}

function polizas(texto: string, esOtrosi: boolean): { requiere: Campo<boolean>; tipos: Campo<string>; ampliar: boolean } {
  const tipos = [...texto.matchAll(/p[oó]liza de\s+(cumplimiento|responsabilidad civil|calidad|salarios y prestaciones|anticipo)/gi)].map((m) => m[1]!.toLowerCase().replace(/ /g, "_"))
  const ampliar = esOtrosi && /garant[ií]as?[^.]*ampliarse/i.test(texto)
  if (esOtrosi) return { requiere: c(null, 0), tipos: c(null, 0), ampliar }
  if (tipos.length === 0) return { requiere: c(false, 0.9, "sin cláusula de póliza"), tipos: c("", 0.9), ampliar }
  const condicional = /cuyo valor supere|para cada orden/i.test(texto)
  const unicos = [...new Set(tipos)].join(";")
  return { requiere: c(true, 0.9, condicional ? "póliza condicional por orden de servicio" : "cláusula de garantías"), tipos: c(unicos, 0.9), ampliar }
}

export type Extraccion = { contrato: Contrato; errores: string[] }

export function extraer(texto: string, fechaCorreo: string): Extraccion {
  const errores: string[] = []
  if (!texto.trim()) return { contrato: vacio(), errores: ["El documento está vacío."] }
  const esOtrosi = /^\s*OTROS[IÍ]/i.test(texto)
  const idTexto = esOtrosi ? texto.match(/AL CONTRATO[^\n]*?No\.\s*([\w-]+)/i)?.[1] : texto.match(/CONTRATO[^\n]*?No\.\s*([\w-]+)/i)?.[1]
  const cli = cliente(texto)
  const paisContrato = pais(texto, cli.tipo, cli.id.valor)
  const val = valor(texto, paisContrato.valor)
  if (val.monedaDesconocida) errores.push(`Moneda desconocida: ${val.monedaDesconocida}.`)
  const pl = plazo(texto, esOtrosi, fechaCorreo)
  const po = polizas(texto, esOtrosi)
  const objeto = texto.match(/OBJETO\.\s*([^\n]+)/i)?.[1]?.trim() ?? null
  return {
    errores,
    contrato: {
      id_contrato: c(idTexto ?? null, 0.95, idTexto ? `No. ${idTexto}` : null),
      es_otrosi: esOtrosi,
      cliente: cli.nombre,
      nit_cliente: cli.id,
      pais: paisContrato,
      objeto: c(objeto ? objeto.slice(0, 200) : null, 0.9),
      valor: val.valor,
      valor_indeterminado: val.indeterminado,
      moneda: val.moneda,
      fecha_inicio: pl.inicio,
      fecha_fin: pl.fin,
      requiere_poliza: po.requiere,
      tipo_poliza: po.tipos,
      ampliar_polizas: po.ampliar,
    },
  }
}

function vacio(): Contrato {
  const n = c<string>(null, 0)
  return { id_contrato: n, es_otrosi: false, cliente: n, nit_cliente: n, pais: c<Pais>(null, 0), objeto: n, valor: c<number>(null, 0), valor_indeterminado: false, moneda: c<Moneda>(null, 0), fecha_inicio: n, fecha_fin: n, requiere_poliza: c<boolean>(null, 0), tipo_poliza: n, ampliar_polizas: false }
}
