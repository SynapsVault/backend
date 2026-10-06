import { Router, type Router as RouterType } from "express";
import { openApiSpec } from "../openapi.js";

const router: RouterType = Router();

/**
 * Validates that the OpenAPI spec object is well-formed enough to serve.
 * Returns true when the spec looks usable, false otherwise.
 */
function isWellFormedSpec(spec: unknown): boolean {
  if (!spec || typeof spec !== "object") return false;
  const s = spec as Record<string, unknown>;
  if (typeof s.openapi !== "string" || s.openapi.length === 0) return false;
  if (!s.info || typeof s.info !== "object") return false;
  if (!s.paths || typeof s.paths !== "object") return false;
  return true;
}

/**
 * GET /openapi.json — machine-readable OpenAPI 3.0 spec (canonical endpoint)
 */
router.get("/openapi.json", (_req, res) => {
  if (!isWellFormedSpec(openApiSpec)) {
    res.status(500).json({
      error: "OpenAPI spec is not well-formed",
    });
    return;
  }
  res.setHeader("Cache-Control", "public, max-age=300");
  res.json(openApiSpec);
});

/**
 * GET /docs/json — alias for the canonical OpenAPI spec endpoint
 */
router.get("/docs/json", (_req, res) => {
  if (!isWellFormedSpec(openApiSpec)) {
    res.status(500).json({
      error: "OpenAPI spec is not well-formed",
    });
    return;
  }
  res.setHeader("Cache-Control", "public, max-age=300");
  res.json(openApiSpec);
});

/**
 * GET /docs — Swagger UI (only mounted in non-production environments)
 * Uses the official Swagger UI CDN so no extra npm package is required.
 */
router.get("/docs", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SynapsVault API Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      url: "/openapi.json",
      dom_id: "#swagger-ui",
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
      layout: "BaseLayout",
      deepLinking: true,
      tryItOutEnabled: true,
    });
  </script>
</body>
</html>`);
});

export default router;