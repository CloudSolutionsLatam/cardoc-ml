**U N I C O R P S Y S T E M S** ·    C H A N G E R E Q U E S T 0 0 3 · A P I C A T A L Y S T B 2 B 

## UNICORP _S Y S T E M S_ Z O H O P A R T N E R A U T O R I Z A D O · M A N A G E E N G I N E S P E C I A L I S T 

**E S P E C I F I C A C I Ó N T É C N I C A · C O N F I D E N C I A L** 

## CHANGE REQUEST 003 

_A C I - C D C - B 2 B - 0 0 1 - C R - 0 0 3  ·  A l c a n c e  t é c n i c o_ 

## API B2B sobre Zoho Catalyst Tres endpoints seguros 

Cliente: **CARDOC** 

Proyecto:  Implementación Canal B2B Corporativo Fecha de emisión:  15 de junio de 2026 

_Emitido por: Unicorp Systems · Zoho Partner Autorizado_ 

_“Postergar es perder.”_ 

**— Séneca** 

Página 1 de 17 

**Confidencial · Unicorp Systems** 

ACI-CDC-B2B-001-CR-003 

**U N I C O R P S Y S T E M S** ·    C H A N G E R E Q U E S T 0 0 3 · A P I C A T A L Y S T B 2 B 

## _1  ·_ Identificación del cambio 

|_1  ·_Identifcación|del cambio|
|---|---|
|**ID del Change Request**|ACI-CDC-B2B-001-CR-003|
|**Proyecto vinculado**|ACI-CDC-B2B-001 · Canal B2B Corporativo Cardoc|
|**Solicitante (Cardoc)**|Marcel Carella|
|**Emitido por**|Unicorp Systems · Chris Drège, CEO|
|**Fecha de emisión**|15 de junio de 2026|
|**Vigencia de la oferta**|30 días calendario desde fecha de emisión|
|**Base técnica**|Especificación funcional del equipo de desarrollo Cardoc, v1.0|
|**Estado**|**PROPUESTO**|



Página 2 de 17 

**Confidencial · Unicorp Systems** 

ACI-CDC-B2B-001-CR-003 

**U N I C O R P S Y S T E M S** ·    C H A N G E R E Q U E S T 0 0 3 · A P I C A T A L Y S T B 2 B 

## _2  ·_ Resumen ejecutivo 

El presente Change Request reemplaza el alcance del CR-002 (link compartido vía URL pública navegable) por una API B2B segura construida sobre Zoho Catalyst, que actúa como backend público y controlado mediante el cual una automotora o integración autorizada puede crear información comercial, consultar informes y consumir el PDF asociado. La persistencia se abstrae en dos recursos internos —una base de datos para información estructurada y un sistema de archivos para los PDF— y ninguno de ellos se expone directamente a terceros. 

El  desarrollo  se  concentra  en  tres  endpoints  versionados.  Los  Blueprints,  etapas  y automatizaciones existentes en Zoho CRM no se modifican: el backend se integra al flujo de agendamiento actual sin rediseñarlo. 

## **T A B L A R E S U M E N E J E C U T I V O** 

|**C O N C E P T O**|**V A L O R**|
|---|---|
|Sale del scope|**Link vía URL pública navegable + validación**<br>**por patente (CR-002)**|
|Entra al scope|**API B2B sobre Zoho Catalyst con tres**<br>**endpoints: creación comercial, consulta de**<br>**informes y consumo seguro de PDF**|
|Autenticación|Bearer token por integración + scopes +<br>segregación por automotora|
|Plataforma|Zoho Catalyst (backend) · base de datos +<br>sistema de archivos internos|
|Impacto sobre el flujo actual|**Nulo · Blueprints, etapas y automatizaciones**<br>**de Zoho CRM no se modifican**|
|Entregables|Seis entregables técnicos (E-01 a E-06) + QA de<br>integración|



Página 3 de 17 

**Confidencial · Unicorp Systems** 

ACI-CDC-B2B-001-CR-003 

**U N I C O R P S Y S T E M S** ·    C H A N G E R E Q U E S T 0 0 3 · A P I C A T A L Y S T B 2 B 

## _3  ·_ Justificación del cambio 

## **3.1 · Limitaciones del scope del CR-002** 

El CR-002 resolvía el acceso mediante una URL pública navegable protegida por token y validación de patente. Esta modalidad expone una dirección pública en internet y un mecanismo de factor débil, incompatibles con el consumo institucional: el informe será consumido por integraciones autorizadas (automotoras e intermediarios) bajo estándares que no admiten links públicos. 

## **3.2 · Necesidad operativa real** 

El consumo es máquina a máquina (server-to-server), no humano. Una integración autorizada se autentica mediante un token Bearer con scopes acotados y opera contra una API controlada, sin recibir nunca credenciales internas ni identificadores que permitan acceder directamente a la base de datos o al sistema de archivos. La API debe permitir crear información comercial (Contacto y Oportunidad), consultar los Informes Revisión autorizados y obtener el PDF asociado mediante streaming autenticado. 

## **3.3 · Valor diferencial del nuevo alcance** 

Zoho Catalyst funciona como una capa de control única donde se validan identidad, alcance, cuota y segregación por automotora. El nuevo esquema elimina toda exposición de URLs públicas,  encapsula  la  persistencia  interna,  habilita  la  interoperabilidad  con  integraciones autorizadas y mantiene intacto el flujo de agendamiento y los Blueprints existentes de Zoho CRM. El resultado es un backend simple, seguro y auditable. 

Página 4 de 17 

**Confidencial · Unicorp Systems** 

ACI-CDC-B2B-001-CR-003 

**U N I C O R P S Y S T E M S** ·    C H A N G E R E Q U E S T 0 0 3 · A P I C A T A L Y S T B 2 B 

## _4  ·_ Scope detallado 

## **4.1 · Qué SALE del scope (reemplazo del CR-002)** 

- **✗** URL pública navegable del informe 

- **✗** Vista standalone HTML del informe compartido 

- **✗** Validación por patente como factor de acceso 

- **✗** Expiración de acceso a 7 días por link 

- **✗** Panel de gestión de links web con generación de URL pública 

## **4.2 · Qué ENTRA en el scope · Tres endpoints sobre Catalyst** 

Endpoint 1 · Crear Contacto y Oportunidad 

- **✓** POST que crea o reutiliza un Contacto en Zoho CRM y crea una Oportunidad en el estado fijo "Agendamiento Ready" 

- **✓** Estado del Deal asignado por el backend — no modificable por el consumidor 

- **✓** Idempotencia obligatoria (X-Idempotency-Key) para evitar oportunidades duplicadas 

## Endpoint 2 · Consultar Informes Revisión 

- **✓** GET que lista y filtra los Informes Revisión de la automotora autenticada, con respuesta normalizada 

- **✓** Filtros controlados (estado, matrícula, oportunidad, rango de fechas) y paginación 

- **✓** Segregación por tenancy: el backend agrega el filtro de Cuenta; no se acepta desde el cliente 

Endpoint 3 · Consumir PDF del Informe 

- **✓** GET que transmite el PDF asociado mediante streaming autenticado, sin exponer una URL pública ni la ubicación interna del archivo 

- **✓** Autorización por pertenencia: el informe debe pertenecer a la Cuenta del token 

Capa transversal de seguridad y operación 

- **✓** Autenticación Bearer token por integración + scopes (opportunities:create, reports:read, reports:pdf) 

- **✓** Cap configurable por consumidor y endpoint para ventanas horaria, diaria y semanal 

- **✓** Auditoría técnica con correlationId y manejo normalizado de errores 

## **4.3 · Qué QUEDA igual (no se modifica)** 

- **✗** Blueprints, etapas y automatizaciones existentes de Zoho CRM 

- **✗** Lógica de agendamiento y de creación de Informes Revisión 

- **✗** Interfaces de usuario, portales y formularios actuales 

Página 5 de 17 

**Confidencial · Unicorp Systems** 

ACI-CDC-B2B-001-CR-003 

**U N I C O R P S Y S T E M S** ·    C H A N G E R E Q U E S T 0 0 3 · A P I C A T A L Y S T B 2 B 

## _5  ·_ Arquitectura resumida 

Cada solicitud entra por Zoho Catalyst, donde se validan identidad, alcance, cuota y segregación. El backend lee o escribe información estructurada en la base de datos y obtiene archivos desde el sistema de archivos. El consumidor externo nunca recibe credenciales internas ni identificadores que permitan acceder directamente a esos recursos. 

**C A P A S D E L A A R Q U I T E C T U R A** 

|**C A P A**|**R E S P O N S A B I L I D A D**|
|---|---|
|**Consumidor B2B**|Envía solicitudes autenticadas y recibe respuestas normalizadas.|
|**Zoho Catalyst**|Expone la API, aplica seguridad, cap, idempotencia y auditoría.|
|**Base de datos**|Almacena y expone internamente la información estructurada de<br>contactos, oportunidades e informes.|
|**Sistema de archivos**|Almacena PDF, evidencias y adjuntos asociados a los informes.|



Decisión de arquitectura: el PDF se transmite desde Catalyst. No se comparte la ubicación interna del sistema de archivos y no se genera una URL pública temporal. 

Página 6 de 17 

**Confidencial · Unicorp Systems** 

ACI-CDC-B2B-001-CR-003 

**U N I C O R P S Y S T E M S** ·    C H A N G E R E Q U E S T 0 0 3 · A P I C A T A L Y S T B 2 B 

## _6  ·_ Seguridad y capa de cap 

El modelo de seguridad se apoya en identidad por integración, alcance acotado por scopes, segregación estricta por automotora y control de consumo configurable. Los secretos de acceso a datos y archivos residen únicamente en el backend. 

|**C O N T R O L**|**A P L I C A C I Ó N**|
|---|---|
|**Token por integración**|Cada automotora o consumidor recibe una identidad separada.|
|**Scopes**|opportunities:create, reports:read y reports:pdf.|
|**Segregación**|Cada operación se filtra por la Cuenta asociada al token.|
|**Secretos internos**|Credenciales de acceso a datos y archivos almacenadas<br>únicamente en secretos del backend.|
|**Cap**|Límites configurables por consumidor y endpoint para ventanas<br>horaria, diaria y semanal.|
|**Idempotencia**|El POST no consume cap nuevamente ni duplica datos al repetir la<br>misma clave.|
|**Auditoría**|Se registran consumidor, endpoint, resultado, fecha, latencia y<br>correlationId.|
|**Datos sensibles**|Los logs no contienen tokens, credenciales ni el binario del PDF.|



Página 7 de 17 

**Confidencial · Unicorp Systems** 

ACI-CDC-B2B-001-CR-003 

**U N I C O R P S Y S T E M S** ·    C H A N G E R E Q U E S T 0 0 3 · A P I C A T A L Y S T B 2 B 

## _7  ·_ Entregables 

El desarrollo se organiza en seis entregables técnicos más el aseguramiento de calidad. Cada entregable es verificable de forma independiente antes de avanzar al siguiente. 

|**ID**|**E N T R E G A B L E**|
|---|---|
|**E-01**|API Catalyst desplegada · tres endpoints versionados (/v1) y entorno de ejecución|
|**E-02**|Integración de datos · creación/reutilización de Contacto y Oportunidad, idempotencia, y<br>consulta de Informes con filtros y paginación|
|**E-03**|Integración de archivos · streaming autenticado del PDF y manejo de errores de archivo|
|**E-04**|Seguridad y cap · Bearer tokens, scopes, segregación por tenancy, secretos en backend<br>y cap configurable|
|**E-05**|Auditoría · logs técnicos, correlationId y manejo normalizado de errores|
|**E-06**|Documentación · contratos de la API, variables de entorno, despliegue y pruebas|
|**QA**|Pruebas de integración end-to-end de los tres endpoints, tenancy, idempotencia y cap|



_La estimación de esfuerzo y la planificación temporal se gestionan por separado, en el plan de ejecución interno. Este documento define el alcance técnico. La estimación asume que las decisiones pendientes (sección 10) se resuelven al inicio de la fase._ 

Página 8 de 17 

**Confidencial · Unicorp Systems** 

ACI-CDC-B2B-001-CR-003 

**U N I C O R P S Y S T E M S** ·    C H A N G E R E Q U E S T 0 0 3 · A P I C A T A L Y S T B 2 B 

## _8  ·_ Criterios de aceptación 

La entrega se considerará aceptada al verificarse los siguientes criterios funcionales medibles, validados en conjunto con Cardoc. 

- El POST crea o reutiliza un Contacto y crea una Oportunidad en "Agendamiento Ready" 

- El backend no modifica el Blueprint existente de Zoho CRM 

- GET /informes devuelve únicamente registros correspondientes a la automotora autenticada 

- La consulta soporta paginación y los filtros controlados definidos 

- GET /informes/{id}/pdf devuelve un archivo PDF válido y no una URL pública 

- Un token no puede consultar ni descargar información de otra automotora 

- Superar el cap configurado devuelve 429 CAP_EXCEEDED 

- Repetir un POST con la misma clave de idempotencia no duplica la Oportunidad 

- Todas las respuestas incluyen correlationId; el cuerpo binario lo devuelve en header 

- Los secretos de Zoho no aparecen en código ni en logs 

Página 9 de 17 

**Confidencial · Unicorp Systems** 

ACI-CDC-B2B-001-CR-003 

**U N I C O R P S Y S T E M S** ·    C H A N G E R E Q U E S T 0 0 3 · A P I C A T A L Y S T B 2 B 

## _9  ·_ Incluye / No incluye 

Aplicación estricta del principio Scope Fence: lo no listado en "Incluye" no forma parte del presente Change Request y requerirá nuevo acuerdo para su incorporación. 

## **9.1 · INCLUYE** 

- **✓** Endpoint 1 — POST de creación/reutilización de Contacto y creación de Oportunidad en "Agendamiento Ready", con idempotencia 

- **✓** Endpoint 2 — GET de consulta normalizada de Informes Revisión con filtros controlados y paginación 

- **✓** Endpoint 3 — GET de consumo del PDF mediante streaming autenticado, sin URL pública 

- **✓** Autenticación Bearer token por integración con scopes (opportunities:create, reports:read, reports:pdf) 

- **✓** Segregación estricta por automotora (tenancy) aplicada en el backend 

- **✓** Cap configurable por consumidor y endpoint (ventanas horaria, diaria y semanal) 

- **✓** Idempotencia en el POST mediante X-Idempotency-Key 

- **✓** Auditoría técnica con correlationId y manejo normalizado de errores (404, 403, 429, 502) 

- **✓** Secretos de acceso a datos y archivos almacenados únicamente en el backend 

- **✓** Documentación de contratos, variables de entorno, despliegue y pruebas 

- **✓** QA de integración end-to-end de los tres endpoints 

## **9.2 · NO INCLUYE** 

- **✗** URL pública navegable, vista standalone HTML ni validación por patente (descartadas del CR002) 

- **✗** Cambios en Blueprints, etapas o automatizaciones existentes de Zoho CRM 

- **✗** Nueva interfaz de usuario, portal o formulario 

- **✗** Rediseño del agendamiento ni de la lógica que crea Informes Revisión 

- **✗** Acceso directo del tercero a la base de datos o al sistema de archivos 

- **✗** Exposición de links públicos al PDF 

- **✗** Autenticación mutua por certificados (mTLS): no forma parte de esta especificación; si una integración la exige, se evalúa como CR adicional 

- **✗** Filtrado por IP a nivel de red: no es capacidad nativa de la plataforma; la identidad se valida por token y scopes 

- **✗** Webhooks salientes hacia el tercero ni sincronización en tiempo real 

Página 10 de 17 

**Confidencial · Unicorp Systems** 

ACI-CDC-B2B-001-CR-003 

**U N I C O R P S Y S T E M S** ·    C H A N G E R E Q U E S T 0 0 3 · A P I C A T A L Y S T B 2 B 

## _10  ·_ Decisiones pendientes 

Las siguientes definiciones deben resolverse al inicio de la fase para cerrar el contrato técnico definitivo. La estimación de la sección 7 asume que se proveen sin demoras; su falta de resolución oportuna puede impactar el cronograma. 

|**D E C I S I Ó N**|**N E C E S A R I A  P A R A**|
|---|---|
|**Nombre técnico del conjunto Informes**<br>**Revisión**|Construir las consultas contra la base de datos.|
|**Clave para reutilizar Contactos**|Evitar contactos duplicados.|
|**Campo técnico de la etapa "Agendamiento**<br>**Ready"**|Crear el Deal en la etapa correcta.|
|**Referencia exacta del PDF**|Resolver el archivo desde el sistema de archivos<br>o un campo del informe.|
|**Filtros que se expondrán**|Cerrar el contrato definitivo de GET /informes.|
|**Valores iniciales de cap**|Configurar cuotas por automotora y endpoint.|
|**Respuesta cross-tenant: 403 o 404**|Definir política de no divulgación de recursos.|



Página 11 de 17 

**Confidencial · Unicorp Systems** 

ACI-CDC-B2B-001-CR-003 

**U N I C O R P S Y S T E M S** ·    C H A N G E R E Q U E S T 0 0 3 · A P I C A T A L Y S T B 2 B 

## _11  ·_ Política de cambios sobre cambios 

Principio Scope Fence: si un requerimiento no existía al momento de definir el presente Change Request,  no  forma  parte  del  alcance  acordado.  Toda  modificación,  ampliación  o  nuevo requerimiento sobre el scope del CR-003 será gestionado mediante un nuevo Change Request independiente, con su propio alcance y planificación. 

## **Tiempos de respuesta** 

- Análisis de impacto de un nuevo requerimiento: 48 horas hábiles desde la recepción formal. 

- Definición formal del nuevo CR: 5 días hábiles desde la aceptación del análisis preliminar. 

- Inicio de ejecución: previa aprobación formal del nuevo alcance. 

## **Disciplina operativa** 

La aplicación estricta del Scope Fence protege la calidad de la entrega y la sostenibilidad de la relación de trabajo. Cualquier cambio no formalizado por la vía aquí descripta no será ejecutado, independientemente del canal por el cual haya sido solicitado. 

Página 12 de 17 

**Confidencial · Unicorp Systems** 

ACI-CDC-B2B-001-CR-003 

**U N I C O R P S Y S T E M S** ·    C H A N G E R E Q U E S T 0 0 3 · A P I C A T A L Y S T B 2 B 

## _12  ·_ Firmas 

El presente Change Request entra en vigencia al recibir la conformidad de ambas partes. La conformidad implica aceptación plena del alcance técnico, los entregables, los criterios de aceptación y las políticas establecidas en el presente documento. 

**P O R C A R D O C P O R U N I C O R P S Y S T E** Nombre completo: ____________________ **Nombre completo: Chris Drège** Rol: ______________________________ Rol: Founder & CEO Firma: ____________________________ Firma: ____________________________ Fecha: ____ / ____ / 2026 Fecha: ____ / ____ / 2026 

## **P O R U N I C O R P S Y S T E M S** 

_Vigencia del Change Request: 30 días calendario desde fecha de emisión._ 

Página 13 de 17 

**Confidencial · Unicorp Systems** 

ACI-CDC-B2B-001-CR-003 

**U N I C O R P S Y S T E M S** ·    C H A N G E R E Q U E S T 0 0 3 · A P I C A T A L Y S T B 2 B 

## _13  ·_ Anexo A · Glosario técnico 

Este glosario aclara los términos técnicos y contractuales del presente Change Request. Su carácter es informativo: en caso de discrepancia con las secciones contractuales, prevalecen siempre los términos contractuales. 

## **A · API y arquitectura** 

**Zoho Catalyst** —  Plataforma serverless del ecosistema Zoho sobre la que se construye el backend público y seguro de la API. Actúa como capa de control donde se validan identidad, alcance, cuota y segregación. Su licencia corre por cuenta del cliente. 

**Endpoint** —  Punto de acceso específico de la API — la dirección a la que un consumidor envía una solicitud. Este CR define tres: creación de Contacto/Oportunidad, consulta de Informes y consumo de PDF. 

**Base de datos / Sistema de archivos** —  Los dos recursos internos donde se persiste la información: la base de datos guarda datos estructurados (contactos, oportunidades, informes) y el sistema de archivos guarda los PDF. Ninguno se expone directamente al consumidor externo. 

**Streaming autenticado** —  Mecanismo por el cual el PDF se transmite directamente desde el backend al consumidor autorizado, sin generar una URL pública ni revelar la ubicación interna del archivo. 

## **B · Seguridad** 

**Bearer token** —  Credencial de acceso que el consumidor presenta en cada solicitud (cabecera Authorization). Identifica a la integración y determina a qué automotora pertenece. Cada integración recibe su propio token. 

**Scope** —  Permiso acotado asociado al token que define qué puede hacer cada integración. Este CR usa tres: opportunities:create (crear), reports:read (consultar) y reports:pdf (descargar PDF). 

**Segregación  por  tenancy** —   Aislamiento  estricto  entre  automotoras.  El  backend  agrega automáticamente el filtro de Cuenta a cada operación, de modo que un token jamás accede a datos de otra automotora — el filtro no se acepta desde el cliente. 

**Cap** —  Límite de consumo configurable por integración y por endpoint, para ventanas horaria, diaria y semanal. Al superarlo, la API responde 429 CAP_EXCEEDED con información de la ventana y el reintento. 

**Idempotencia** —  Propiedad que garantiza que repetir la misma solicitud (identificada por X-IdempotencyKey) no duplica datos: una segunda llamada con la misma clave devuelve el resultado original sin crear una oportunidad nueva. 

**Secretos del backend** —  Credenciales internas de acceso a la base de datos y al sistema de archivos, almacenadas únicamente del lado del backend. Nunca se entregan al consumidor ni aparecen en logs. 

## **C · Operación y auditoría** 

**correlationId** —  Identificador único que acompaña cada operación y su registro de auditoría. Permite rastrear una solicitud de extremo a extremo ante cualquier incidente. Se devuelve en el cuerpo de la respuesta o, para el PDF, en una cabecera. 

Página 14 de 17 

**Confidencial · Unicorp Systems** 

ACI-CDC-B2B-001-CR-003 

**U N I C O R P S Y S T E M S** ·    C H A N G E R E Q U E S T 0 0 3 · A P I C A T A L Y S T B 2 B 

**Manejo normalizado de errores** —  Conjunto de respuestas de error estandarizadas: 404 (recurso inexistente o PDF no disponible), 403 (acceso no autorizado), 429 (cap superado), 502 (falla temporal del sistema de archivos). 

## **D · Contractuales** 

**Change Request (CR)** —  Solicitud formal de cambio sobre un proyecto en curso. Cada CR es independiente, tiene su número correlativo y requiere firma de ambas partes. El presente documento es el CR-003. 

**Scope Fence** —  Principio contractual estricto: lo que no estaba definido al acordar no forma parte del alcance. Todo requerimiento adicional se gestiona como un nuevo CR, sin ampliaciones verbales. 

Cualquier término no contemplado que requiera aclaración antes de la firma puede solicitarse formalmente a Unicorp Systems. 

Página 15 de 17 

**Confidencial · Unicorp Systems** 

ACI-CDC-B2B-001-CR-003 

**U N I C O R P S Y S T E M S** ·    C H A N G E R E Q U E S T 0 0 3 · A P I C A T A L Y S T B 2 B 

## _14  ·_ Anexo B · Contratos técnicos 

Referencia técnica de los contratos de la API para el equipo de integración. Los ejemplos son ilustrativos; el contrato definitivo se cierra tras resolver las decisiones pendientes (sección 10). 

## **B.1 · Endpoint 1 — Crear Contacto y Oportunidad** 

## **R E Q U E S T** 

`POST /v1/crm/opportunity-contact Authorization: Bearer <integration-token> X-Idempotency-Key: <external-reference> Content-Type: application/json { "accountId": "<zoho-account-id>", "externalReference": "AUTOMOTORA-AGENDA-000123", "contact": { "firstName": "Juan", "lastName": "Pérez", "email": "juan@ejemplo.com", "mobile": "+598..." }, "opportunity": { "name": "Revisión VOLKSWAGEN UP! AB-123", "vehicle": { "brand": "VOLKSWAGEN", "model": "UP!", "year": "TODOS", "plate": "AB-123" }, "portalDestination": "ml" } }` **R E S P O N S E** `HTTP/1.1 201 Created { "success": true, "data": { "contactId": "12345", "contactCreated": false, "opportunityId": "67890", "stage": "Agendamiento Ready" }, "correlationId": "corr_..." }` 

## **B.2 · Endpoint 2 — Consultar Informes Revisión** 

## **R E Q U E S T / R E S P O N S E** 

```
GET /v1/informes?estado=Pendiente&matricula=AB-123&page=1&per_page=50
Authorization: Bearer <integration-token>
```

```
HTTP/1.1 200 OK
{
  "success": true,
  "data": [ {
    "id": "<crm-record-id>", "number": "INFREV-4248",
    "date": "2026-05-28",
    "account": { "id": "...", "name": "..." },
    "vehicle": { "brand": "VOLKSWAGEN", "model": "UP!",
```

Página 16 de 17 

**Confidencial · Unicorp Systems** 

ACI-CDC-B2B-001-CR-003 

**U N I C O R P S Y S T E M S** ·    C H A N G E R E Q U E S T 0 0 3 · A P I C A T A L Y S T B 2 B 

```
                 "year": "TODOS", "plate": "AB-123" },
    "status": "Pendiente", "inspector": "Lucas",
    "mode": "Inspection", "destinationPortal": "ml",
    "pdfAvailable": true
  } ],
  "pagination": { "page": 1, "perPage": 50, "hasMore": false },
  "correlationId": "corr_..."
}
```

## **B.3 · Endpoint 3 — Consumir PDF del Informe** 

## **R E Q U E S T / R E S P O N S E** 

```
GET /v1/informes/<informeId>/pdf
Authorization: Bearer <integration-token>
Accept: application/pdf
HTTP/1.1 200 OK
Content-Type: application/pdf
Content-Disposition: inline; filename="INFREV-4248.pdf"
Cache-Control: no-store
X-Correlation-Id: corr_...
```

```
<contenido binario del PDF>
```

## **B.4 · Manejo de errores** 

|**S I T U A C I Ó N**|**R E S P U E S T A**|
|---|---|
|Informe válido con PDF disponible|**200 · application/pdf**|
|Informe inexistente|**404 REPORT_NOT_FOUND**|
|Informe existente sin PDF|**404 PDF_NOT_AVAILABLE**|
|Informe de otra automotora|**403 FORBIDDEN / 404**|
|Cap superado|**429 CAP_EXCEEDED**|
|Falla temporal del sistema de archivos|**502 UPSTREAM_ERROR**|



Página 17 de 17 

**Confidencial · Unicorp Systems** 

ACI-CDC-B2B-001-CR-003 

