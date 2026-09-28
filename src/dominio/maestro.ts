import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { copiarArchivo, escribirTexto } from "../core/archivos.ts"

export const COLUMNAS = ["id_contrato", "cliente", "nit_cliente", "pais", "objeto", "valor", "moneda", "fecha_inicio", "fecha_fin", "requiere_poliza", "tipo_poliza", "estado_poliza", "comercial", "ruta_sharepoint", "fecha_registro", "fuente"] as const
export type Columna = (typeof COLUMNAS)[number]
export type Fila = Record<Columna, string>

export const RUTAS = {
  buzon: (dir: string) => join(dir, "fixtures", "reto-02", "buzon"),
  fixtureMaestro: (dir: string) => join(dir, "fixtures", "reto-02", "maestro-contratos.csv"),
  comerciales: (dir: string) => join(dir, "fixtures", "reto-02", "comerciales.json"),
  sharepoint: (dir: string) => join(dir, "out", "sharepoint"),
  maestro: (dir: string) => join(dir, "out", "sharepoint", "maestro-contratos.csv"),
  historial: (dir: string) => join(dir, "out", "sharepoint", "historial.jsonl"),
  procesados: (dir: string) => join(dir, "out", "procesados.json"),
  alertas: (dir: string) => join(dir, "out", "alertas.md"),
}

/** Parser CSV (RFC 4180): respeta comillas y comas dentro de un campo (el objeto puede tener comas). */
export function parsearCsv(texto: string): string[][] {
  const filas: string[][] = []
  let fila: string[] = []
  let campo = ""
  let comillas = false
  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i]
    if (comillas) {
      if (ch === '"' && texto[i + 1] === '"') { campo += '"'; i++ }
      else if (ch === '"') comillas = false
      else campo += ch
    } else if (ch === '"') comillas = true
    else if (ch === ",") { fila.push(campo); campo = "" }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && texto[i + 1] === "\n") i++
      fila.push(campo); campo = ""
      if (fila.some((x) => x !== "")) filas.push(fila)
      fila = []
    } else campo += ch
  }
  if (campo || fila.length) { fila.push(campo); filas.push(fila) }
  return filas
}

const celda = (v: string) => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v)

/** RN6: el fixture es de solo lectura; la primera ejecución lo copia a out/sharepoint/. */
export async function leerMaestro(dir: string): Promise<Fila[]> {
  let texto = await readFile(RUTAS.maestro(dir), "utf8").catch(() => null)
  if (texto === null) {
    await copiarArchivo(RUTAS.fixtureMaestro(dir), RUTAS.maestro(dir))
    texto = await readFile(RUTAS.maestro(dir), "utf8")
  }
  const [encabezado, ...filas] = parsearCsv(texto)
  const cols = encabezado ?? []
  return filas.map((f) => Object.fromEntries(COLUMNAS.map((c) => [c, f[cols.indexOf(c)] ?? ""])) as Fila)
}

export async function guardarMaestro(dir: string, filas: Fila[]): Promise<void> {
  const lineas = [COLUMNAS.join(","), ...filas.map((f) => COLUMNAS.map((c) => celda(f[c])).join(","))]
  await escribirTexto(RUTAS.maestro(dir), lineas.join("\n") + "\n")
}

export async function leerProcesados(dir: string): Promise<Record<string, { accion: string; id_contrato: string | null; motivo: string | null }>> {
  const t = await readFile(RUTAS.procesados(dir), "utf8").catch(() => "{}")
  return JSON.parse(t) as Record<string, { accion: string; id_contrato: string | null; motivo: string | null }>
}

export async function marcarProcesado(dir: string, mensajeId: string, accion: string, idContrato: string | null, motivo: string | null): Promise<void> {
  const actual = await leerProcesados(dir)
  actual[mensajeId] = { accion, id_contrato: idContrato, motivo }
  await escribirTexto(RUTAS.procesados(dir), JSON.stringify(actual, null, 2))
}
