import { cp, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ContextoHerramienta } from "../src/core/tipos.ts"

export const RAIZ = join(import.meta.dirname, "..")

/** Proyecto aislado en una carpeta temporal (fixtures + conocimiento): las pruebas no tocan out/ real y pueden correr en paralelo. */
export async function proyectoTemporal(): Promise<{ dir: string; ctx: ContextoHerramienta; limpiar: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "reto-test-"))
  await cp(join(RAIZ, "fixtures"), join(dir, "fixtures"), { recursive: true })
  await cp(join(RAIZ, "src", "knowledge"), join(dir, "src", "knowledge"), { recursive: true })
  await cp(join(RAIZ, "agent"), join(dir, "agent"), { recursive: true })
  return { dir, ctx: { directory: dir, sessionId: "test" }, limpiar: () => rm(dir, { recursive: true, force: true }) }
}

export type Respuesta<T = Record<string, unknown>> = { ok: boolean; data: T; error?: string }
export const parse = <T = Record<string, unknown>>(s: string) => JSON.parse(s) as Respuesta<T>
