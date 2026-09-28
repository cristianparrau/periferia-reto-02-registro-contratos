/** Límite de peticiones por IP en ventana deslizante (en memoria). Protege la clave del modelo en un link público. */
export class LimitadorPorIp {
  private readonly registro = new Map<string, number[]>()

  constructor(
    private readonly maximo: number,
    private readonly ventanaMs = 60_000,
  ) {}

  permitir(ip: string, ahora = Date.now()): { ok: true } | { ok: false; reintentarEnSeg: number } {
    const recientes = (this.registro.get(ip) ?? []).filter((t) => ahora - t < this.ventanaMs)
    if (recientes.length >= this.maximo) {
      this.registro.set(ip, recientes)
      return { ok: false, reintentarEnSeg: Math.ceil((this.ventanaMs - (ahora - (recientes[0] ?? ahora))) / 1000) }
    }
    recientes.push(ahora)
    this.registro.set(ip, recientes)
    if (this.registro.size > 10_000) this.limpiar(ahora)
    return { ok: true }
  }

  private limpiar(ahora: number): void {
    for (const [ip, tiempos] of this.registro) if (tiempos.every((t) => ahora - t >= this.ventanaMs)) this.registro.delete(ip)
  }
}
