import { join } from "node:path"
import { agregarLinea } from "./archivos.ts"

type EntradaLog = { herramienta: string; ok: boolean; resumen: string; caso?: string; sessionId?: string }

/**
 * Registro de auditoría. Global en out/log.jsonl (CA4) y por caso en out/<caso>/log.jsonl (RN5).
 * Nunca registra valores sensibles ni claves: solo un resumen.
 */
export async function registrar(directorio: string, entrada: EntradaLog): Promise<void> {
  const ts = new Date().toISOString()
  const base = { ts, herramienta: entrada.herramienta, ok: entrada.ok, resumen: entrada.resumen }
  try {
    await agregarLinea(join(directorio, "out", "log.jsonl"), JSON.stringify({ ...base, caso: entrada.caso, sessionId: entrada.sessionId }))
    if (entrada.caso) await agregarLinea(join(directorio, "out", entrada.caso, "log.jsonl"), JSON.stringify(base))
  } catch {
    // El log nunca debe tumbar una herramienta.
  }
}
