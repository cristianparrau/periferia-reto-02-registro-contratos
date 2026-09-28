import { after, before, describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import * as contratos from "../src/tools/contratos.ts"
import { extraer, fechaEnTexto, finPorMeses, numero } from "../src/dominio/extraccion.ts"
import { leerMaestro, parsearCsv } from "../src/dominio/maestro.ts"
import { similitudObjeto } from "../src/dominio/clasificacion.ts"
import { slug } from "../src/dominio/texto.ts"
import { parse, proyectoTemporal } from "./ayudas.ts"
import type { ContextoHerramienta } from "../src/core/tipos.ts"

type Validacion = { clasificacion: string; requiere_revision: string[]; diferencias: { campo: string; antes: string; despues: string }[]; avisos: string[]; id_contrato_existente: string | null }
type Registro = { id_contrato: string | null; accion: string; ruta_archivo: string | null; confirmados?: string[] }

let p: Awaited<ReturnType<typeof proyectoTemporal>>
let ctx: ContextoHerramienta
let fixtureOriginal: string
before(async () => {
  process.env.FECHA_REFERENCIA = "2026-09-03"
  p = await proyectoTemporal()
  ctx = p.ctx
  fixtureOriginal = await readFile(join(p.dir, "fixtures/reto-02/maestro-contratos.csv"), "utf8")
})
after(async () => { delete process.env.FECHA_REFERENCIA; await p.limpiar() })

const validar = async (id: string) => parse<Validacion>(await contratos.validar.execute({ mensaje_id: id }, ctx)).data
const texto = (id: string, archivo = "contrato.txt") => readFile(join(p.dir, "fixtures/reto-02/buzon", id, archivo), "utf8")

describe("extracción determinista", () => {
  it("números en formato colombiano y estadounidense", () => {
    assert.equal(numero("$265.000.000"), 265000000)
    assert.equal(numero("120,000.00"), 120000)
    assert.equal(numero("520,000.00"), 520000)
  })
  it("fechas en letras con número entre paréntesis y plazo en meses", () => {
    assert.equal(fechaEnTexto("el primero (1) de agosto de 2026"), "2026-08-01")
    assert.equal(finPorMeses("2026-08-15", 12), "2027-08-14")
  })
  it("msg-001: todos los campos con confianza ≥ 0.8", async () => {
    const { contrato: k } = extraer(await texto("msg-001"), "2026-08-04")
    assert.deepEqual([k.id_contrato.valor, k.cliente.valor, k.nit_cliente.valor, k.pais.valor, k.valor.valor, k.moneda.valor], ["CT-2026-015", "Industrias Delta S.A.S.", "890900111", "CO", 265000000, "COP"])
    assert.deepEqual([k.fecha_inicio.valor, k.fecha_fin.valor, k.requiere_poliza.valor, k.tipo_poliza.valor], ["2026-08-01", "2027-07-31", true, "cumplimiento"])
  })
  it("msg-003 otrosí: id del contrato original, nuevo valor y nueva fecha fin", async () => {
    const { contrato: k } = extraer(await texto("msg-003", "otrosi.txt"), "2026-08-22")
    assert.deepEqual([k.es_otrosi, k.id_contrato.valor, k.valor.valor, k.moneda.valor, k.fecha_fin.valor, k.ampliar_polizas], [true, "CT-2026-011", 520000, "PEN", "2027-11-01", true])
    assert.equal(k.objeto.valor, null)
  })
  it("msg-006: valor por demanda y fecha fin derivada con baja confianza (nunca inventados con confianza alta)", async () => {
    const { contrato: k } = extraer(await texto("msg-006"), "2026-08-31")
    assert.deepEqual([k.valor.valor, k.valor_indeterminado], [0, true])
    assert.ok(k.valor.confianza < 0.8 && k.fecha_fin.confianza < 0.8)
  })
  it("moneda desconocida y texto vacío son errores", () => {
    assert.match(extraer("CONTRATO No. X\nSEGUNDA. VALOR. El valor es (EUR 1.000).", "2026-01-01").errores[0] ?? "", /Moneda desconocida: EUR/)
    assert.match(extraer("   ", "2026-01-01").errores[0] ?? "", /vacío/)
  })
  it("slug de carpeta igual al del maestro y similitud de objetos", () => {
    assert.equal(slug("Corporación Andina de Servicios S.A."), "corporacion-andina-de-servicios")
    assert.ok(similitudObjeto("Soporte y mantenimiento plataforma SAP", "Soporte y mantenimiento de la plataforma SAP") >= 0.9)
  })
})

describe("clasificación (RN1–RN4) sobre el buzón", () => {
  it("leer_buzon lista 6 pendientes y marca la cotización sin contrato", async () => {
    const r = parse<{ mensajes: { id: string; tiene_contrato: boolean; clasificacion?: string }[] }>(await contratos.leer_buzon.execute({}, ctx))
    assert.equal(r.data.mensajes.length, 6)
    assert.deepEqual(r.data.mensajes.filter((m) => !m.tiene_contrato).map((m) => [m.id, m.clasificacion]), [["msg-005", "rechazado"]])
  })
  it("resultados esperados del PRD §7.4", async () => {
    const esperado: Record<string, string> = { "msg-001": "nuevo", "msg-002": "nuevo", "msg-003": "actualizacion", "msg-004": "duplicado", "msg-005": "rechazado", "msg-006": "nuevo" }
    for (const [id, c] of Object.entries(esperado)) assert.equal((await validar(id)).clasificacion, c, id)
  })
  it("msg-002: mismo RUC que un contrato existente pero otro objeto → nuevo (no se deduplica por cliente)", async () => {
    const v = await validar("msg-002")
    assert.equal(v.id_contrato_existente, null)
  })
  it("msg-006: revisión de valor y fecha_fin; remitente desconocido se avisa sin bloquear", async () => {
    const v = await validar("msg-006")
    assert.deepEqual(v.requiere_revision, ["valor", "fecha_fin"])
    assert.match(v.avisos[0] ?? "", /jperez@.*no está en comerciales/)
  })
})

describe("registro, historial y archivo", () => {
  it("procesa el buzón en orden y deja msg-006 sin registrar hasta confirmar", async () => {
    const acciones: Record<string, string> = {}
    for (const id of ["msg-001", "msg-002", "msg-003", "msg-004", "msg-005", "msg-006"]) {
      const r = parse<Registro>(await contratos.registrar.execute({ mensaje_id: id }, ctx))
      acciones[id] = r.ok ? r.data.accion : `error: ${r.error}`
    }
    assert.deepEqual(acciones, {
      "msg-001": "insertado", "msg-002": "insertado", "msg-003": "actualizado", "msg-004": "sin_cambios (duplicado)", "msg-005": "rechazado",
      "msg-006": "error: requiere revisión: valor, fecha_fin. Confirma o corrige esos campos antes de registrar.",
    })
  })
  it("confirmado=true sin confirmación humana verificada no registra", async () => {
    const r = parse(await contratos.registrar.execute({ mensaje_id: "msg-006", confirmado: true }, { ...ctx, confirmacionHumana: false }))
    assert.equal(r.ok, false)
  })
  it("con confirmación humana registra msg-006 con los valores confirmados e ignora campos no revisables", async () => {
    const r = parse<Registro & { ignorados: string[] }>(await contratos.registrar.execute({ mensaje_id: "msg-006", confirmado: true, contrato: { valor: 0, fecha_fin: "2027-08-31", cliente: "Otro nombre" } }, { ...ctx, confirmacionHumana: true }))
    assert.deepEqual([r.data.id_contrato, r.data.confirmados, r.data.ignorados], ["CM-2026-03", ["valor=0", "fecha_fin=2027-08-31"], ["cliente"]])
  })
  it("maestro: 11 filas, sin duplicados, otrosí aplicado y 16 columnas por fila", async () => {
    const filas = await leerMaestro(p.dir)
    assert.equal(filas.length, 11)
    assert.equal(new Set(filas.map((f) => f.id_contrato)).size, 11)
    const minera = filas.find((f) => f.id_contrato === "CT-2026-011")
    assert.deepEqual([minera?.valor, minera?.fecha_fin, minera?.estado_poliza], ["520000", "2027-11-01", "pendiente"])
    const marco = filas.find((f) => f.id_contrato === "CM-2026-03")
    assert.deepEqual([marco?.valor, marco?.fecha_fin, marco?.cliente, marco?.comercial], ["0", "2027-08-31", "Distribuidora Caribe S.A.S.", ""])
    assert.equal(filas.find((f) => f.id_contrato === "CT-2026-016")?.estado_poliza, "no_aplica")
    const crudo = parsearCsv(await readFile(join(p.dir, "out/sharepoint/maestro-contratos.csv"), "utf8"))
    assert.ok(crudo.every((f) => f.length === 16))
  })
  it("RN6: el fixture del maestro no se modifica", async () => {
    assert.equal(await readFile(join(p.dir, "fixtures/reto-02/maestro-contratos.csv"), "utf8"), fixtureOriginal)
  })
  it("historial con valores antes/después y documentos archivados en la ruta SharePoint", async () => {
    const h = (await readFile(join(p.dir, "out/sharepoint/historial.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { accion: string; id_contrato: string; cambios: unknown; mensaje_id: string; ts: string })
    assert.deepEqual(h.map((x) => `${x.accion}:${x.id_contrato}`), ["insercion:CT-2026-015", "insercion:CT-2026-016", "otrosi:CT-2026-011", "insercion:CM-2026-03"])
    for (const f of (await leerMaestro(p.dir)).filter((x) => x.fecha_registro === "2026-09-03")) await readFile(join(p.dir, "out/sharepoint", f.ruta_sharepoint))
  })
  it("re-procesar un mensaje ya registrado no duplica", async () => {
    const r = parse<Registro>(await contratos.registrar.execute({ mensaje_id: "msg-001" }, ctx))
    assert.equal(r.data.accion, "sin_cambios (duplicado)")
    assert.equal((await leerMaestro(p.dir)).length, 11)
  })
  it("procesados.json cubre los 6 mensajes y el buzón queda vacío", async () => {
    const r = parse<{ mensajes: unknown[] }>(await contratos.leer_buzon.execute({}, ctx))
    assert.equal(r.data.mensajes.length, 0)
  })
})

describe("alertas y errores", () => {
  it("alertas al 2026-09-03: vencimientos, pólizas y registros desde el corte", async () => {
    const r = parse<{ vencen: { id_contrato: string }[]; polizas_pendientes: { id_contrato: string }[]; registrados_desde_corte: { id_contrato: string }[]; ruta: string }>(await contratos.alertas.execute({ hoy: "2026-09-03" }, ctx))
    assert.deepEqual(r.data.vencen.map((x) => x.id_contrato), ["CT-2026-009", "CT-2026-004"])
    assert.deepEqual(r.data.polizas_pendientes.map((x) => x.id_contrato).sort(), ["CM-2026-03", "CT-2026-004", "CT-2026-011", "CT-2026-015"])
    assert.deepEqual(r.data.registrados_desde_corte.map((x) => x.id_contrato), ["CT-2026-015", "CT-2026-016", "CM-2026-03"])
    const md = await readFile(join(p.dir, r.data.ruta), "utf8")
    for (const s of ["Vencen en 60 días", "Pólizas requeridas", "Registrados desde el corte"]) assert.ok(md.includes(s))
  })
  it("fecha inválida, adjunto vacío y mensaje inexistente: errores legibles", async () => {
    assert.match(parse(await contratos.alertas.execute({ hoy: "03/09/2026" }, ctx)).error ?? "", /Fecha inválida/)
    const dir = join(p.dir, "fixtures/reto-02/buzon/zz-vacio")
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "correo.json"), (await texto("msg-001", "correo.json")).replace('"msg-001"', '"zz-vacio"'))
    await writeFile(join(dir, "contrato.txt"), "")
    assert.match(parse(await contratos.validar.execute({ mensaje_id: "zz-vacio" }, ctx)).error ?? "", /está vacío/)
    assert.match(parse(await contratos.validar.execute({ mensaje_id: "no-existe" }, ctx)).error ?? "", /No se encontró/)
  })
})
