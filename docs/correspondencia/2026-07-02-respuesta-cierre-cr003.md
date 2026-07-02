# Borrador · Respuesta a Cardoc — Cierre técnico de las decisiones §10 (CR-003)

**Para:** Cardoc — Marcel Carella
**De:** Unicorp Systems — Nestor Toñanez
**Asunto:** CR-003 · Cierre de decisiones §10 — validaciones y últimas definiciones técnicas
**Fecha:** 2026-07-02

---

Estimado Marcel,

Gracias por las definiciones sobre las decisiones pendientes del punto 10 del CR-003. Las revisamos contra la implementación actual del backend y la mayoría ya está resuelta o implementada. Detallamos el estado y planteamos las últimas definiciones técnicas necesarias para cerrar el contrato de forma clara y ejecutable.

## Definiciones confirmadas e implementadas

- **Etapa de la Oportunidad:** la Oportunidad se crea en **"Nueva Solicitud"** (funnel B2B), tal como se acordó. Ya implementado y verificado contra el CRM real.
- **Nomenclatura del PDF:** adoptamos `NombreCliente_IDInterno_Fecha.pdf` con la fecha en ISO 8601 (AAAA-MM-DD). Ya implementado (con una consulta técnica más abajo sobre el "ID interno").
- **Límites de consumo (cap):** configurados en **POST 60/h · consulta de informes 120/h · descarga de PDF 100/h**. Al superarse, la API responde con un error estándar de límite excedido (429).
- **Respuesta cross-tenant:** confirmamos **404 (No encontrado)** como política de no divulgación; ya es el comportamiento del backend. El resto de errores usa terminología estándar de API.
- **"Portal solicitante":** de acuerdo con mantener el módulo de Informes de Revisión y agregar el campo técnico; el backend lo poblará automáticamente al crear la operación.

## Punto de atención — clave de deduplicación de Contactos

Sugirieron el **número de teléfono** como clave para reutilizar Contactos. Al revisarlo contra el **JSON de contrato que ya venían utilizando, éste identifica al Contacto por Cédula**, y sobre esa base el backend hoy deduplica por **Cédula** (campo ya creado en el CRM).

Recomendamos **mantener la Cédula** como clave: es un identificador estable y único, mientras que el teléfono es opcional, mutable y admite formatos distintos (p. ej. `+598…` vs `09…`), lo que puede generar duplicados o fallos de deduplicación. Quedamos a la espera de su confirmación para dejarlo cerrado; si prefieren teléfono, coordinamos el ajuste y la normalización del número.

## Alcance — consulta de informes por filtros (Endpoint 2)

Las definiciones de filtros (ID de informe, fecha, estado Open/Completed) corresponden al endpoint de **consulta/listado de informes**, que quedó **fuera del alcance vigente** (el CR-003 es previo a esa decisión). No las implementamos por ahora; las conservamos como contrato a honrar si el endpoint se reactiva en un CR futuro.

## Definiciones técnicas que necesitamos para completar el cierre

1. **Consumo del PDF por N.º de Solicitud (nueva variante).** Además del acceso por ID de Análisis, sumaremos una variante que reciba el **N.º de Solicitud** (external ID) y resuelva el informe buscando en el módulo **Informes Revisión** del CRM. Para implementarla necesitamos los **nombres técnicos (api_name)** de:
   - el campo del módulo *Informes Revisión* que almacena el **N.º de Solicitud**, y
   - el campo que referencia el **ID del Análisis** (registro en Zoho Creator) asociado.
2. **"ID interno" del nombre del PDF.** El ejemplo usa `INF12345` / `INFREV-4248`. El detalle que hoy entrega la API de Creator expone un código propio del informe, **no** el número del CRM. ¿Aceptan ese código como "ID interno", o requieren que el backend exponga el **número del CRM (INFREV-xxxx)** en el detalle? En el segundo caso necesitaríamos que dicho número venga en la respuesta del detalle.
3. **Campo "Portal solicitante".** Confirmar el **nombre técnico (api_name)** definitivo del campo una vez creado, para cablearlo.
4. **Ventanas de cap adicionales.** Los valores acordados son por **hora**. ¿Desean fijar también límites **diarios/semanales** por endpoint, o los dejamos como guardrail por defecto?

Con estas definiciones cerramos el contrato técnico y avanzamos con la implementación pendiente sin retrabajos.

Quedamos atentos.

Saludos,
**Nestor Toñanez** — Unicorp Systems
