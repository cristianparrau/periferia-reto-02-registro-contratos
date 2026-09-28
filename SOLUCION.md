# SOLUCIÓN — Reto 02 · Registro de Contratos Vigentes

## 1. Problema en una frase
Desde mayo nadie alimenta el maestro de contratos, y solo llegan a administración los que requieren póliza. La dirección no sabe qué contratos están vigentes ni qué pólizas vencen, y el proceso depende de una persona que ya no está. Le duele a la analista administrativa (dueña del maestro) y a la gerencia (visibilidad de riesgo).

## 2. Arquitectura
```
web/index.html (chat) ──HTTP──▶ src/server.ts ──▶ src/agente.ts (ciclo) ──▶ src/llm/adapter.ts ◀── gemini.ts
                                                        ▼
                                      src/core/registro-herramientas.ts (valida con zod)
                                                        ▼
                                      src/tools/contratos.ts ──▶ src/dominio/* (buzón, extracción, clasificación, maestro, alertas)
                                                        │
                             fixtures/reto-02 (solo lectura)      out/ (sharepoint/, procesados.json, alertas.md, log.jsonl)
```
- **Comportamiento**: `agent/prompt.md`.
- **Conocimiento**: `src/knowledge/registro-contratos.md`.
- **Ejecución**: `src/tools/contratos.ts` delega en `src/dominio/`.
- El núcleo (ciclo, servidor, adaptador LLM, front) es el mismo de los otros retos; solo cambia `src/config.ts`.

## 3. Ciclo del agente
- Bucle modelo → herramientas con tope de 25 iteraciones, tope de tokens por sesión y timeout.
- Todas las llamadas quedan en el chat y en `out/log.jsonl` con `{ ts, herramienta, mensaje_id, ok, resumen }`.
- **Confirmación con doble candado**:
  - El agente termina con `[CONFIRMAR]` y el front lo resalta.
  - `contratos_registrar` exige `confirmado: true` **y** que el servidor haya verificado que el mensaje inmediatamente siguiente del usuario es una confirmación.
  - Solo se aceptan correcciones del humano para los campos que estaban en revisión. Cualquier otro valor enviado por el modelo se ignora y se reporta.

## 4. Elección del modelo
- **Gemini 2.5 Flash** por REST, temperatura 0. La extracción P0 es determinista; el modelo orquesta el lote, presenta la tabla y conduce la revisión.
- **Costo estimado**: el buzón de 6 mensajes necesita ~15–20 llamadas × ~8 k tokens ≈ 150 k tokens. Son **~USD 0,05 por lote**, menos de USD 0,01 por contrato con precios de lista de Flash (verificar la tarifa vigente).

## 5. Estrategia de extracción
Todo en `src/dominio/extraccion.ts`, sin LLM:

| Campo | Cómo se encuentra | Confianza |
|---|---|---|
| id_contrato | `CONTRATO … No. X`; en otrosí, `AL CONTRATO … No. X` (el contrato que modifica) | 0.95 |
| cliente | Primera parte ("Entre … , identificada con NIT/RUC"). Se prefiere la razón social del bloque de firmas (mayúsculas correctas) | 0.95 firmas / 0.85 encabezado |
| nit_cliente | Número tras NIT/RUC/RTN, sin puntos ni dígito de verificación | 0.95 |
| país | Domicilio (Quito → EC, Lima → PE…); si no, tipo y longitud del identificador | 0.9 / 0.8 |
| objeto | Cláusula OBJETO, máx. 200 caracteres | 0.9 |
| valor y moneda | Línea de la cláusula VALOR, patrón `(COP $265.000.000)` / `(USD 120,000.00)`. El separador decimal se detecta (formato CO o US). "No tiene un valor determinado" → 0 e indeterminado | 0.95 / 0.5 |
| fechas | "desde el (1) de agosto de 2026 hasta …" (se usa el número entre paréntesis). Plazo en meses → fin = inicio + meses − 1 día. Firma con solo mes y año → día 1 | 0.95 / 0.8 inicio / 0.6 fin derivado |
| pólizas | "póliza de cumplimiento / responsabilidad civil / …". Un otrosí que dice que las garantías "deberán ampliarse" pasa la póliza a pendiente | 0.9 |

- Un campo ausente es `null` con confianza 0, nunca inventado. Moneda fuera de la lista, texto vacío o fecha inválida → `{ ok: false, error }` legible.
- **Dónde entra el modelo**: presentar resultados, explicar la evidencia de cada campo dudoso y trasladar la decisión del humano (valores confirmados) a `contratos_registrar`.
- **Dónde no entra**: el modelo no extrae ni decide valores. Lo que se registra sale del documento o de la confirmación explícita del usuario.

## 6. Regla de gobierno (propuesta de una página)
1. **Canal único**: `contratos@periferia-ficticia.com`. Lo administra la analista administrativa (dueña del maestro), con un respaldo designado por la gerencia administrativa. El agente lo procesa a diario.
2. **Obligación del comercial**:
   - Enviar todo contrato firmado, **requiera póliza o no**, con sus otrosíes, actas de inicio y de terminación.
   - Formato: PDF firmado con texto seleccionable, dentro de **3 días hábiles** desde la firma.
   - Asunto: `[CONTRATO|OTROSI|ACTA] <cliente> - <número>`.
3. **Acuse automático**: el mismo día, el agente responde al comercial con el número registrado, la clasificación (nuevo, actualización, duplicado) y los campos pendientes de revisión, o el motivo de rechazo.
4. **Excepciones y escalamiento**:
   - Contrato sin firmar: se rechaza con acuse y se pide la versión firmada.
   - Contrato sin valor (por demanda) o con datos dudosos: queda en revisión de la analista.
   - Si el comercial no responde en 5 días hábiles, se escala a la gerencia comercial.
   - Remitentes no registrados (ej. practicantes) se registran igual y se informa a su líder.
   - Dueño del maestro ante dudas contractuales: gerencia administrativa (no hay área legal).
5. **Cierre del gap (junio–agosto 2026)**: una campaña de dos semanas.
   - Contabilidad extrae la lista de clientes facturados en el periodo.
   - Se cruza con el maestro.
   - Cada comercial reenvía al buzón los contratos faltantes con asunto `[MIGRACION]`.
   - El agente los registra con `fuente = migracion`.
6. **Indicador mensual**: **% de contratos facturados que existen en el maestro** (meta ≥ 98 %). Complementos: tiempo medio firma → registro (meta ≤ 3 días) y número de pólizas exigidas en estado pendiente por más de 15 días.

## 7. Decisiones y trade-offs
| Decisión | Alternativa descartada | Por qué |
|---|---|---|
| Extracción determinista con confianza por campo | Extracción con el LLM | Reproducible y auditable: la evidencia de cada campo es un fragmento del texto. El LLM puede "redondear" un valor o inferir una fecha (riesgo del PRD). |
| Dedupe por id y luego por NIT + objeto (Jaccard ≥ 0.9), nunca por nombre | Coincidencia por nombre del cliente | Evita falsos duplicados por variaciones del nombre. msg-002 (mismo RUC, otro objeto) queda correctamente como nuevo. |
| Las herramientas re-extraen desde el documento en cada paso; `registrar` solo acepta correcciones de campos en revisión | Pasar el objeto `contrato` completo del modelo | El modelo no puede alterar un valor que no estaba en duda. |
| CSV propio (RFC 4180) sin dependencias | Librería CSV | Son ~30 líneas y el objeto trae comas; se prueba que todas las filas mantienen 16 columnas. |
| Firma sin día → día 1, con confianza baja en el fin | Rechazar el contrato | El contrato es válido; se registra tras confirmación humana en lugar de perderlo. |

## 8. Supuestos
- Un otrosí sin contrato original en el maestro se rechaza con el motivo "registrar primero el original".
- La póliza condicional del contrato marco (por orden de servicio > COP 100 M) se registra como requerida y pendiente; es preferible alertar de más.
- En un contrato marco sin moneda, un contrato colombiano se asume en COP (confianza 0.85).
- `fecha_registro` es la fecha de ejecución. La demo la fija en 2026-09-03 para que coincida con la fecha de las alertas.
- Los otrosíes se archivan como `<id>-<mensaje>.txt` junto al contrato; la fila conserva la ruta del contrato original.
- Una sección extra informativa en `alertas.md` lista contratos con fecha fin pasada sin acta de terminación.

## 9. Cobertura
Pruebas automatizadas: `npm test` (node:test) cubre el entorno, el ciclo del agente, el adaptador, el servidor con distintos `.env` y el dominio; ver README.

| HU | Estado | Falta para producción |
|---|---|---|
| HU-1 Leer buzón | Hecho | Conexión real a Exchange / Graph API. |
| HU-2 Extraer | Hecho (P0 determinista) | Lectura de PDF nativo (P1) y OCR para escaneos. |
| HU-3 Validar | Hecho | Revisión de umbrales con datos reales. |
| HU-4 Registrar y archivar | Hecho | SharePoint real (Graph API) y control de concurrencia en el maestro. |
| HU-5 Alertar | Hecho | Envío programado semanal a gerencia. |
| HU-6 Errores | Hecho | — |

Resultados de la demo:
- **msg-001**: nuevo, póliza pendiente.
- **msg-002**: nuevo, no_aplica.
- **msg-003**: actualización de valor 350.000 → 520.000 PEN y fin 2027-05-01 → 2027-11-01; póliza a pendiente (ampliación).
- **msg-004**: duplicado.
- **msg-005**: rechazado (cotización).
- **msg-006**: en revisión (valor, fecha_fin); tras la confirmación queda registrado.
- **Alertas al 2026-09-03**: 2 contratos por vencer, 4 pólizas no vigentes, 3 registros desde el corte.

## 10. Uso de IA
- **Asistente**: Claude (Anthropic) en modo agente sobre la carpeta del proyecto.
- **Para qué**: análisis de fixtures y trampas (otrosí con id del contrato original, mismo cliente con otro objeto, formatos numéricos CO/US, firma sin día), generación de código, pruebas y redacción de este documento.
- **Decisiones propias**: Node, Gemini y validar cada bloque antes de avanzar.
- **Corregido durante la revisión**:
  - La primera versión no extraía el valor del otrosí, porque su cláusula tiene otro formato.
  - Un adjunto vacío se reportaba como "sin contrato".
  - `fecha_registro` no coincidía con la fecha de las alertas en la demo.
  - Todo se detectó con las pruebas y se corrigió.
- En la instalación desde cero se detectó que un valor no numérico en `.env` (ej. `MAX_ITERACIONES=abc`) dejaba el tope en `NaN` y el agente nunca llamaba al modelo. Se agregó la validación del entorno con zod al arrancar, `npm run verificar` y la suite `npm test`.

## 11. Riesgos para producción
| Riesgo | Mitigación |
|---|---|
| PDF escaneados o formatos muy distintos | OCR y extracción asistida por LLM **solo como propuesta**, siempre con revisión humana si la confianza es baja. |
| Comerciales que no envían | Regla de gobierno + indicador mensual contra facturación. |
| Concurrencia sobre el CSV | Migrar a lista de SharePoint o base de datos con bloqueo optimista. |
| Falsos duplicados o actualizaciones | Dedupe por identificador fiscal + objeto; toda actualización queda en el historial con valores antes y después. |
| Datos contractuales sensibles | Permisos de SharePoint por rol; el agente no envía el texto completo al modelo, solo los resultados de las herramientas. |
