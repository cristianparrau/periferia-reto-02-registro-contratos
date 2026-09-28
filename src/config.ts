import * as contratos from "./tools/contratos.ts"

/** Nombre que ve el modelo: "contratos_<export>". */
export const APLICACION = {
  nombre: "Registro de contratos",
  ejemplo: "Procesa el buzón con fecha de hoy 2026-09-03. No registres nada dudoso sin preguntarme.",
  prefijo: "contratos",
  herramientas: contratos,
}
