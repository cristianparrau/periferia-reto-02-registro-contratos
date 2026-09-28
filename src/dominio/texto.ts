import { readFile } from "node:fs/promises"

export async function leerTexto(ruta: string): Promise<string | null> {
  return readFile(ruta, "utf8").catch(() => null)
}

/** "Industrias Delta S.A.S." → "industrias-delta" (mismo formato de carpetas que el maestro). */
export function slug(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\s+(sas|sac|sa|ltda|s de rl)\s*$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
}
