import { Gemini } from "./gemini.ts"
import type { ProveedorLLM } from "./adapter.ts"
import type { Entorno } from "../core/entorno.ts"

/** Fábrica: agregar un proveedor = una clase nueva + un case aquí. El ciclo del agente no cambia. */
export function crearProveedor(entorno: Entorno): ProveedorLLM | null {
  if (entorno.LLM_PROVIDER === "gemini" && entorno.GEMINI_API_KEY) return new Gemini(entorno.GEMINI_API_KEY, entorno.GEMINI_MODEL, entorno.LLM_TIMEOUT_MS)
  return null
}
