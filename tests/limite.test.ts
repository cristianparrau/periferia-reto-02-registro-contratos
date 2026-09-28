import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { LimitadorPorIp } from "../src/core/limite.ts"

describe("límite de peticiones por IP", () => {
  it("permite hasta el máximo en la ventana y luego indica cuándo reintentar", () => {
    const l = new LimitadorPorIp(2, 60_000)
    assert.ok(l.permitir("a", 0).ok)
    assert.ok(l.permitir("a", 1000).ok)
    const r = l.permitir("a", 2000)
    assert.ok(!r.ok && r.reintentarEnSeg === 58)
  })
  it("la ventana es deslizante y las IPs son independientes", () => {
    const l = new LimitadorPorIp(1, 60_000)
    assert.ok(l.permitir("a", 0).ok)
    assert.ok(l.permitir("b", 0).ok)
    assert.ok(!l.permitir("a", 59_999).ok)
    assert.ok(l.permitir("a", 60_000).ok)
  })
})
