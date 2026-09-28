/** Fecha de referencia YYYY-MM-DD: FECHA_REFERENCIA si existe (demos deterministas), si no la fecha de hoy en Bogotá. */
export function fechaReferencia(): string {
  const fija = process.env.FECHA_REFERENCIA?.trim()
  if (fija && /^\d{4}-\d{2}-\d{2}$/.test(fija)) return fija
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(new Date())
}

export function diasEntre(desde: string, hasta: string): number {
  const ms = Date.parse(hasta + "T00:00:00Z") - Date.parse(desde + "T00:00:00Z")
  return Math.round(ms / 86_400_000)
}
