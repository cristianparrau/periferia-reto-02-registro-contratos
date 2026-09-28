import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { leerJson } from "../core/archivos.ts"
import { fallo, ok, type Resultado } from "../core/tipos.ts"
import { leerTexto } from "./texto.ts"
import { RUTAS } from "./maestro.ts"

export const CorreoSchema = z.object({ id: z.string(), de: z.string(), para: z.string(), asunto: z.string(), fecha: z.string(), cuerpo: z.string(), adjuntos: z.array(z.string()) })
export type Correo = z.infer<typeof CorreoSchema>
const ComercialSchema = z.array(z.object({ email: z.string(), nombre: z.string(), region: z.string() }))

export type Mensaje = { correo: Correo; adjunto: string | null; texto: string | null; tiene_contrato: boolean }

/** Un adjunto es contrato si su contenido empieza como contrato u otrosí (no basta el nombre del archivo). */
function esContrato(texto: string): boolean {
  return /^\s*(CONTRATO|OTROS[IÍ])/i.test(texto)
}

export async function leerMensaje(dir: string, id: string): Promise<Resultado<Mensaje>> {
  const carpeta = join(RUTAS.buzon(dir), id)
  const correo = await leerJson(join(carpeta, "correo.json"), CorreoSchema, `correo.json de ${id}`)
  if (!correo.ok) return fallo(`Mensaje "${id}": ${correo.error}`)
  for (const adjunto of correo.data.adjuntos) {
    const texto = await leerTexto(join(carpeta, adjunto))
    if (texto !== null && texto.trim() === "") return fallo(`El adjunto ${adjunto} del mensaje ${id} está vacío. Pide al comercial reenviar el documento.`)
    if (texto !== null && esContrato(texto)) return ok({ correo: correo.data, adjunto, texto, tiene_contrato: true })
  }
  return ok({ correo: correo.data, adjunto: null, texto: null, tiene_contrato: false })
}

export async function listarMensajes(dir: string): Promise<string[]> {
  return (await readdir(RUTAS.buzon(dir), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort()
}

export async function resolverComercial(dir: string, email: string): Promise<{ nombre: string | null; aviso: string | null }> {
  const lista = await leerJson(RUTAS.comerciales(dir), ComercialSchema, "comerciales.json")
  const c = lista.ok ? lista.data.find((x) => x.email.toLowerCase() === email.toLowerCase()) : undefined
  return c ? { nombre: c.nombre, aviso: null } : { nombre: null, aviso: `Remitente ${email} no está en comerciales.json (no bloquea; informar a gerencia comercial).` }
}
