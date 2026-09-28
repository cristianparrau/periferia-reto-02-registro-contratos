/** Formato de mensajes neutral: el ciclo del agente no conoce al proveedor. */
export type LlamadaHerramienta = { id: string; nombre: string; argumentos: Record<string, unknown> }

export type Mensaje =
  | { rol: "sistema"; texto: string }
  | { rol: "usuario"; texto: string }
  | { rol: "asistente"; texto: string; llamadas: LlamadaHerramienta[]; crudo?: unknown }
  | { rol: "herramienta"; resultados: { id: string; nombre: string; contenido: string }[] }

/** Declaración que ve el modelo: nombre, descripción y JSON Schema de argumentos. */
export type DeclaracionHerramienta = { nombre: string; descripcion: string; parametros: Record<string, unknown> }

export type RespuestaLLM = { texto: string; llamadas: LlamadaHerramienta[]; tokens: number; crudo?: unknown }

export interface ProveedorLLM {
  readonly nombre: string
  readonly modelo: string
  enviar(mensajes: Mensaje[], herramientas: DeclaracionHerramienta[]): Promise<RespuestaLLM>
}

export class ErrorLLM extends Error {}
