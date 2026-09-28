# Proceso de registro de contratos vigentes

## Contexto
- El maestro de contratos estuvo congelado desde el 2026-05-30. El buzón único `contratos@` es ahora el único canal de entrada.
- Se registra **todo** contrato, requiera póliza o no.
- No hay área legal interna: el agente no interpreta cláusulas, solo extrae datos.

## Clasificación
- **Duplicado**: mismo número de contrato y mismos valor, fecha de inicio y fecha de fin. No se escribe nada.
- **Actualización**: mismo número de contrato (o mismo NIT del cliente y objeto casi idéntico) con algún dato distinto, o un otrosí. Se actualiza la fila y se guarda el historial.
- **Nuevo**: sin coincidencia. Se inserta. Mismo cliente con otro objeto es un contrato nuevo.
- **Rechazado**: sin adjunto de contrato (por ejemplo, una cotización) o sin partes ni objeto identificables.

## Revisión humana
Un campo con confianza menor a 0,8 detiene el registro hasta que una persona lo confirme o corrija. Casos típicos: contratos por demanda (sin valor), fechas de firma sin día, plazos expresados en meses con prórroga automática.

## Pólizas
- Nuevo contrato con póliza → estado `pendiente` hasta que el corredor la expida.
- Un otrosí que amplía el plazo exige ampliar la vigencia de las pólizas: el estado pasa a `pendiente`.

## Archivo
`Contratos/<año de inicio>/<cliente>/<número de contrato>`. Los otrosíes se archivan junto al contrato.

## Alertas
Se revisan contratos que vencen en 60 días o menos, pólizas exigidas que no están vigentes y lo registrado desde el corte del 2026-05-30.
