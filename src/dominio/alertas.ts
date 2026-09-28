import { diasEntre } from "../core/fechas.ts"
import type { Fila } from "./maestro.ts"

export const FECHA_CORTE = "2026-05-30"
type Item = { id_contrato: string; cliente: string; detalle: string }

export function calcularAlertas(filas: Fila[], hoy: string): { vencen: Item[]; polizas_pendientes: Item[]; registrados_desde_corte: Item[]; vencidos: Item[] } {
  const vencen = filas
    .filter((f) => f.fecha_fin && diasEntre(hoy, f.fecha_fin) >= 0 && diasEntre(hoy, f.fecha_fin) <= 60)
    .sort((a, b) => a.fecha_fin.localeCompare(b.fecha_fin))
    .map((f) => ({ id_contrato: f.id_contrato, cliente: f.cliente, detalle: `vence ${f.fecha_fin} (en ${diasEntre(hoy, f.fecha_fin)} días)` }))
  const polizas_pendientes = filas
    .filter((f) => f.requiere_poliza === "true" && f.estado_poliza !== "vigente")
    .map((f) => ({ id_contrato: f.id_contrato, cliente: f.cliente, detalle: `${f.tipo_poliza || "póliza"}: ${f.estado_poliza}` }))
  const registrados_desde_corte = filas
    .filter((f) => f.fecha_registro > FECHA_CORTE)
    .map((f) => ({ id_contrato: f.id_contrato, cliente: f.cliente, detalle: `registrado ${f.fecha_registro} (${f.fuente})` }))
  const vencidos = filas
    .filter((f) => f.fecha_fin && f.fecha_fin < hoy)
    .map((f) => ({ id_contrato: f.id_contrato, cliente: f.cliente, detalle: `venció ${f.fecha_fin}` }))
  return { vencen, polizas_pendientes, registrados_desde_corte, vencidos }
}

export function alertasMarkdown(a: ReturnType<typeof calcularAlertas>, hoy: string): string {
  const seccion = (titulo: string, items: Item[]) => [`## ${titulo} (${items.length})`, "", ...(items.length ? items.map((i) => `- **${i.id_contrato}** — ${i.cliente}: ${i.detalle}`) : ["- Ninguno"]), ""]
  return [
    `# Alertas de contratos — ${hoy}`,
    "",
    ...seccion("Vencen en 60 días o menos", a.vencen),
    ...seccion("Pólizas requeridas no vigentes", a.polizas_pendientes),
    ...seccion(`Registrados desde el corte (${FECHA_CORTE}) — gap cubierto`, a.registrados_desde_corte),
    ...seccion("Informativo: vencidos sin acta de terminación registrada", a.vencidos),
  ].join("\n")
}
