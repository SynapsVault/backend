import { Router, type Router as RouterType } from "express";
import { openApiSpec } from "../openapi.js";
import { config } from "../config.js";

const router: RouterType = Router();

// ── Pinned Swagger UI version ─────────────────────────────────────────────────
// Update these constants together whenever Swagger UI is upgraded.
// Run the following to recompute the SRI hashes after bumping the version:
//   VERSION=<new-version>
//   curl -fsSL https://unpkg.com/swagger-ui-dist@$VERSION/swagger-ui.css \
//     | openssl dgst -sha384 -binary | openssl base64 -A
//   curl -fsSL https://unpkg.com/swagger-ui-dist@$VERSION/swagger-ui-bundle.js \
//     | openssl dgst -sha384 -binary | openssl base64 -A
const SWAGGER_UI_VERSION = "5.34.0";
const SWAGGER_UI_CSS_INTEGRITY =
  "sha384-4c3vsE5f+trhFyHrFrLM1fFGUn531NIaC7dcqEWIJdoRQJ5CkJbSuSCwXLpaS1KF";
const SWAGGER_UI_JS_INTEGRITY =
  "sha384-9Td7MKiIr2S83E1kZyyVi8KdJw/S8CpAvu0llLyMeg0xq/hDGiZJfVn0fV4llCmK";

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
 * GET /openapi.json — machine-readable OpenAPI 3.0 spec (canonical endpoint).
 * Served in all environments.
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
 * GET /docs/json — alias for the canonical OpenAPI spec endpoint.
 * Served in all environments.
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
 * GET /docs — Swagger UI.
 *
 * Only mounted outside production (#54). The CDN assets are pinned to an
 * exact version and carry Subresource Integrity (SRI) hashes so the browser
 * rejects any tampered file served from the CDN.
 */
if (config.NODE_ENV !== "production") {
  router.get("/docs", (_req, res) => {
    const cssUrl = `https://unpkg.com/swagger-ui-dist@${SWAGGER_UI_VERSION}/swagger-ui.css`;
    const jsUrl = `https://unpkg.com/swagger-ui-dist@${SWAGGER_UI_VERSION}/swagger-ui-bundle.js`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SynapsVault API Docs</title>
  <link rel="stylesheet"
        href="${cssUrl}"
        integrity="${SWAGGER_UI_CSS_INTEGRITY}"
        crossorigin="anonymous" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="${jsUrl}"
          integrity="${SWAGGER_UI_JS_INTEGRITY}"
          crossorigin="anonymous"></script>
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
}

export default router;
