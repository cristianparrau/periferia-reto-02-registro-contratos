# Reto 02 — Agente "Registro de Contratos Vigentes"

Agente conversacional que actúa como punto único de recepción de contratos: lee el buzón, extrae los datos con nivel de confianza, detecta nuevos, actualizaciones (otrosíes) y duplicados, archiva en una estructura tipo SharePoint, alimenta el maestro y genera alertas de vencimiento y pólizas. Pide revisión humana para campos de baja confianza.

## Requisitos
- Node.js 20 o superior (probado con 22).
- Una API key de Google Gemini (solo para el chat; la demo y los tests no la necesitan).

## Levantar en local (un comando)
```bash
cp .env.example .env      # y colocar GEMINI_API_KEY
npm install && npm start  # http://localhost:3000
```
`npm run dev` levanta con recarga automática.

## Variables de entorno
| Variable | Uso | Default |
|---|---|---|
| `GEMINI_API_KEY` | Clave del modelo. Solo backend. | — |
| `GEMINI_MODEL` | Modelo | `gemini-3.5-flash-lite` |
| `GEMINI_MODEL_RESPALDO` | Modelos alternos separados por comas, si el principal está saturado o sin cuota | — (`render.yaml`: `gemini-3.1-flash-lite`) |
| `MAX_ITERACIONES` | Tope herramienta→modelo por turno | 25 |
| `MAX_TOKENS_SESION` | Tope de tokens por sesión | 200000 |
| `LLM_TIMEOUT_MS` | Timeout al proveedor | 60000 |
| `LIMITE_CHAT_POR_MINUTO` | Mensajes de chat por IP por minuto (protege la clave en el link público) | 10 |
| `MAX_SESIONES` | Sesiones en memoria (se descarta la más antigua) | 200 |
| `CONFIAR_PROXY` | `true` detrás de un proxy (Render) para identificar la IP real | false |
| `FECHA_REFERENCIA` | Fecha de registro de los contratos (YYYY-MM-DD) | hoy (Bogotá) |
| `PORT` | Puerto HTTP | 3000 |

## Verificar el entorno
```bash
npm run verificar             # Node, dependencias, .env (valores y formato), .env excluido de git
npm run verificar:conexion    # además prueba la clave y el modelo contra la API de Gemini
```
El servidor también valida el `.env` al arrancar: un valor inválido (por ejemplo `MAX_ITERACIONES=abc`) lo detiene con un mensaje que indica qué corregir. Sin `GEMINI_API_KEY` levanta con un aviso y el chat informa que no hay modelo.

## Demo sin modelo
```bash
npm run demo
```

## Pruebas automatizadas
```bash
npm test          # node:test, sin clave de API ni red
npm run typecheck
```
Cada prueba corre sobre una copia temporal de los fixtures (no toca `out/`). Suites:
- `entorno.test.ts`: validación del `.env`: defaults, conversión, errores y enmascarado de la clave.
- `agente.test.ts`: ciclo del agente con un modelo simulado: confirmación humana (doble candado), topes de iteraciones y tokens, errores de herramientas y del proveedor.
- `gemini.test.ts`: adaptador con `fetch` simulado: clave en cabecera, *function calling*, errores HTTP, timeout y adaptación de esquemas.
- `servidor.test.ts`: servidor real levantado con distintos `.env` (válido, sin clave, inválido): health sin exponer la clave, rutas y *path traversal*.
- `contratos.test.ts`: extracción (formatos CO/US, fechas en letras, otrosí), clasificación §7.4, registro con confirmación, maestro sin duplicados, fixture intacto, historial, alertas y errores.

## API
| Método | Ruta | Descripción |
|---|---|---|
| POST | `/api/chat` | `{ sessionId?, message }` → `{ sessionId, reply, toolCalls[], needsConfirmation }` |
| GET | `/api/sessions/:id` | Historial de la sesión |
| GET | `/api/health` | `{ ok, provider, model }` (sin claves) |
| GET | `/out/<ruta>` | Descarga de archivos generados (solo lectura, dentro de `out/`) |

## Link de prueba
**https://periferia-reto-02-registro-contratos.onrender.com** (plan gratuito: si estuvo inactivo, la primera carga tarda ~1 min)

### Capa gratuita de Gemini
El link público usa la capa gratuita de la API de Gemini, que tiene límites diarios y por minuto por proyecto y picos de demanda (HTTP 429/503). El agente reintenta, respeta el tiempo de espera que indica Google y pasa a los modelos de respaldo. Si aun así no hay cuota, el chat lo informa en lenguaje claro y la sesión sigue activa. En ese caso, la lógica completa se puede verificar sin modelo con `npm run demo` y `npm test`, o localmente con una clave propia (`.env`).

## Despliegue (Render)
El repositorio incluye `render.yaml` (Blueprint):
1. En [render.com](https://render.com): **New → Blueprint** → conectar `cristianparrau/periferia-reto-02-registro-contratos`.
2. Render lee `render.yaml` (Node 22, `npm ci`, `npm start`, health check en `/api/health`) y pide el valor de `GEMINI_API_KEY`: se pega en el panel y nunca queda en el repositorio.
3. Al terminar, Render entrega la URL pública (`https://<servicio>.onrender.com`).

Notas del plan gratuito: el servicio se duerme tras ~15 min sin tráfico (la primera petición tarda ~1 min en despertar; abrir el link unos minutos antes de la defensa) y el disco es efímero (`out/` se reinicia en cada despliegue).

## Estructura
```
agent/prompt.md                 comportamiento del agente
src/knowledge/                  conocimiento del proceso
src/tools/contratos.ts          herramientas (contratos_<export>)
src/dominio/                    buzón, extracción con confianza, clasificación, maestro CSV, alertas
src/core/                       contrato de herramientas, registro, logs, archivos
src/llm/                        adaptador del proveedor (interfaz + Gemini)
src/agente.ts                   ciclo del agente
src/server.ts                   API HTTP + archivos estáticos
web/index.html                  chat
demo.ts                         verificación sin modelo
scripts/                        pruebas
```

## Salidas
- `out/sharepoint/maestro-contratos.csv`: copia viva del maestro (el fixture no se modifica).
- `out/sharepoint/Contratos/<año>/<cliente>/<id>.txt`: documentos archivados.
- `out/sharepoint/historial.jsonl`: inserciones y cambios con valores antes y después.
- `out/procesados.json`: mensajes procesados y su resultado.
- `out/alertas.md`: reporte de riesgos.
