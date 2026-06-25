/**
 * App Express de la API pública /v1/*.
 *
 * Pipeline de middlewares con ORDEN FIJO. requireScope y cap se montan POR RUTA
 * (no por prefijo) porque /v1/informes y /v1/informes/:id/pdf tienen scopes y caps
 * distintos:
 *
 *   correlation(global) → auditOnFinish(global) →
 *   [por ruta] attachContainer → auth → requireScope → cap → handler ;  errorMiddleware(último)
 */
import express from "express";
import type { Request, Response } from "express";
import {
  attachContainer,
  authMiddleware,
  correlationMiddleware,
  requireInternalSecret,
  requireScope,
} from "./middleware/auth";
import { auditOnFinish } from "./middleware/audit";
import { cap } from "./middleware/cap";
import { errorMiddleware } from "./middleware/errors";
import { opportunityContactHandler } from "./routes/opportunity-contact";
import { listInformesHandler, streamPdfHandler } from "./routes/informes";
import { dealEstadoHandler } from "./routes/internal";

const app: express.Express = express();
app.use(express.json());
app.use(correlationMiddleware);
app.use(auditOnFinish);

// Health check abierto (sin auth) — lo consume el monitoreo de disponibilidad.
app.get("/v1/health", (_req: Request, res: Response): void => {
  res.status(200).json({ status: "ok", service: "api" });
});

// Cadena de autenticación compartida por las 3 rutas protegidas.
const authed = [attachContainer, authMiddleware];

app.post(
  "/v1/opportunity-contact",
  ...authed,
  requireScope("opportunities:create"),
  cap("opportunity-contact"),
  opportunityContactHandler,
);

app.get(
  "/v1/informes",
  ...authed,
  requireScope("reports:read"),
  cap("informes-list"),
  listInformesHandler,
);

app.get(
  "/v1/informes/:id/pdf",
  ...authed,
  requireScope("reports:pdf"),
  cap("informes-pdf"),
  streamPdfHandler,
);

// Ruta interna (CRM workflow → Catalyst): notifica a ML el cambio de estado del Deal.
// Shared-secret (x-internal-secret), sin Bearer ni scopes.
app.post("/v1/internal/deal-estado", attachContainer, requireInternalSecret, dealEstadoHandler);

app.all("/", (_req: Request, res: Response): void => {
  res.status(200).send("cardoc api: live");
});

// Error handler global — debe ir ÚLTIMO. Traduce todo al sobre de error único.
app.use(errorMiddleware);

export default app;
