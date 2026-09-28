import { readFile, writeFile, mkdir, copyFile, appendFile } from "node:fs/promises"
import { dirname } from "node:path"
import type { z } from "zod"
import { fallo, ok, type Resultado } from "./tipos.ts"

/** Lee y valida un JSON con zod. Devuelve un error legible, nunca una traza cruda. */
export async function leerJson<T>(ruta: string, esquema: z.ZodType<T>, nombre: string): Promise<Resultado<T>> {
  let texto: string
  try {
    texto = await readFile(ruta, "utf8")
  } catch {
    return fallo(`No se encontró ${nombre}.`)
  }
  let crudo: unknown
  try {
    crudo = JSON.parse(texto)
  } catch {
    return fallo(`${nombre} está corrupto (JSON inválido).`)
  }
  const validado = esquema.safeParse(crudo)
  if (!validado.success) return fallo(`${nombre} no tiene la estructura esperada: ${validado.error.issues[0]?.message ?? "formato inválido"}.`)
  return ok(validado.data)
}

export async function escribirTexto(ruta: string, contenido: string | Uint8Array): Promise<void> {
  await mkdir(dirname(ruta), { recursive: true })
  await writeFile(ruta, contenido)
}

export async function copiarArchivo(origen: string, destino: string): Promise<void> {
  await mkdir(dirname(destino), { recursive: true })
  await copyFile(origen, destino)
}

export async function agregarLinea(ruta: string, linea: string): Promise<void> {
  await mkdir(dirname(ruta), { recursive: true })
  await appendFile(ruta, linea + "\n")
}
