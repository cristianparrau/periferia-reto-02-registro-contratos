/**
 * Verificación sin modelo: procesa los 6 mensajes del buzón en orden llamando a las herramientas.
 * Los mensajes con campos en revisión quedan sin registrar en la primera pasada; luego se confirma msg-006.
 */
import { rm } from "node:fs/promises"
import { join } from "node:path"
import * as contratos from "./src/tools/contratos.ts"
import type { ContextoHerramienta } from "./src/core/tipos.ts"

const directory = process.cwd()
const ctx: ContextoHerramienta = { directory, sessionId: "demo" }
type Respuesta = { ok: boolean; data?: Record<string, unknown>; error?: string }
const parse = (s: string) => JSON.parse(s) as Respuesta
const HOY = "2026-09-03"
process.env.FECHA_REFERENCIA = HOY // fecha_registro y alertas coherentes y deterministas

async function procesar(id: string): Promise<void> {
  console.log(`\n=== ${id} ===`)
  const v = parse(await contratos.validar.execute({ mensaje_id: id }, ctx))
  if (!v.ok || !v.data) return void console.log(`  ✗ ${v.error}`)
  console.log(`  Clasificación: ${v.data.clasificacion}${v.data.motivo ? ` — ${v.data.motivo}` : ""}`)
  const revision = v.data.requiere_revision as string[]
  const detalle = v.data.detalle_revision as Record<string, { propuesto: unknown; confianza: number; evidencia: string | null }>
  for (const campo of revision) console.log(`  Revisar ${campo}: propuesto ${JSON.stringify(detalle[campo]?.propuesto)} (confianza ${detalle[campo]?.confianza}) — ${detalle[campo]?.evidencia ?? ""}`)
  for (const d of (v.data.diferencias as { campo: string; antes: string; despues: string }[])) console.log(`  Cambio ${d.campo}: ${d.antes} → ${d.despues}`)
  for (const a of (v.data.avisos as string[])) console.log(`  Aviso: ${a}`)
  const r = parse(await contratos.registrar.execute({ mensaje_id: id }, ctx))
  console.log(`  Acción: ${r.ok && r.data ? `${String(r.data.accion)} ${String(r.data.id_contrato ?? "")} ${r.data.ruta_archivo ? `→ ${String(r.data.ruta_archivo)}` : ""}` : `NO registrado → ${r.error}`}`)
}

async function main(): Promise<void> {
  await rm(join(directory, "out"), { recursive: true, force: true })
  const buzon = parse(await contratos.leer_buzon.execute({}, ctx))
  const mensajes = (buzon.data?.mensajes as { id: string; tiene_contrato: boolean }[]) ?? []
  console.log(`Buzón: ${mensajes.length} mensajes pendientes (${mensajes.filter((m) => !m.tiene_contrato).length} sin contrato)`)
  for (const m of mensajes) await procesar(m.id)

  console.log("\n=== Segunda pasada: confirmación humana de msg-006 ===")
  console.log('  Usuario: "confirmo el valor 0 y la fecha fin 2027-08-31"')
  const r = parse(await contratos.registrar.execute({ mensaje_id: "msg-006", confirmado: true, contrato: { valor: 0, fecha_fin: "2027-08-31" } }, ctx))
  console.log(`  Acción: ${r.ok && r.data ? `${String(r.data.accion)} ${String(r.data.id_contrato)} (confirmados: ${(r.data.confirmados as string[]).join(", ")})` : r.error}`)

  const pendientes = parse(await contratos.leer_buzon.execute({}, ctx))
  console.log(`\nBuzón tras procesar: ${(pendientes.data?.mensajes as unknown[]).length} pendientes`)
  const a = parse(await contratos.alertas.execute({ hoy: HOY }, ctx))
  if (a.ok && a.data) {
    console.log(`\n=== Alertas al ${HOY} (${String(a.data.ruta)}) ===`)
    for (const [k, t] of [["vencen", "Vencen ≤ 60 días"], ["polizas_pendientes", "Pólizas no vigentes"], ["registrados_desde_corte", "Registrados desde el corte"]] as const) {
      console.log(`  ${t}: ${(a.data[k] as { id_contrato: string; detalle: string }[]).map((i) => `${i.id_contrato} (${i.detalle})`).join("; ") || "ninguno"}`)
    }
  }
}

main().catch(() => {
  console.error("La demo falló de forma inesperada.")
  process.exitCode = 1
})
