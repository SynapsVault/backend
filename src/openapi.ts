/**
 * OpenAPI 3.0 specification for the SynapsVault server.
 * Served as JSON at GET /openapi.json and browsable via Swagger UI at GET /docs.
 */
export const openApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "SynapsVault API",
    version: "1.0.0",
    description:
      "A marketplace where humans and AI agents publish and trade digital resources via HTTP 402 payments on Stellar.\n\n" +
      "**Optional request signatures:** When the server has `REQUIRE_REQUEST_SIGNATURE=true`, publisher mutations (POST/DELETE on `/resources/*`) must include `X-Timestamp` and `X-Signature` headers. See `docs/request-signature.md`.",
    license: { name: "MIT" },
  },
  servers: [{ url: "/", description: "Current server" }],
  tags: [
    { name: "Health", description: "Liveness and readiness probes" },
    { name: "Publishers", description: "Publisher registration and profile management" },
    { name: "Resources", description: "Resource publishing, browsing, and access" },
    { name: "Registry", description: "On-chain Soroban vault-registry" },
    { name: "Verify", description: "AI content originality verification (x402 paywalled)" },
    { name: "Payments", description: "Payment processing and settlement" },
    { name: "Admin", description: "Administrative operations" },
    { name: "Metrics", description: "Service metrics and observability" },
    { name: "Webhooks", description: "Publisher webhook subscription management" },
  ],
  components: {
    securitySchemes: {
      ApiKeyAuth: {
        type: "apiKey",
        in: "header",
        name: "x-api-key",
        description: "Publisher API key returned on registration",
      },
      RequestSignature: {
        type: "apiKey",
        in: "header",
        name: "X-Signature",
        description:
          "Optional HMAC-SHA256 hex digest over method, path, timestamp, nonce, and body (required when REQUIRE_REQUEST_SIGNATURE is enabled). " +
          "Must be paired with X-Timestamp (unix seconds) and X-Nonce (unique per request). The API key is the HMAC secret. See docs/request-signature.md.",
      },
      XTimestamp: {
        type: "apiKey",
        in: "header",
        name: "X-Timestamp",
        description:
          "Unix timestamp in seconds for the request signature. Must be within the allowed clock-skew window of the server. " +
          "Required alongside X-Signature and X-Nonce when REQUIRE_REQUEST_SIGNATURE is enabled. See docs/request-signature.md.",
      },
      XNonce: {
        type: "apiKey",
        in: "header",
        name: "X-Nonce",
        description:
          "Unique, single-use nonce for the request signature to prevent replay attacks. " +
          "Required alongside X-Signature and X-Timestamp when REQUIRE_REQUEST_SIGNATURE is enabled. See docs/request-signature.md.",
      },
      X402Payment: {
        type: "apiKey",
        in: "header",
        name: "X-Payment",
        description: "Base64-encoded x402 payment payload",
      },
      AdminKey: {
        type: "apiKey",
        in: "header",
        name: "x-admin-key",
        description: "Administrative API key required for admin endpoints",
      },
    },
    schemas: {
      Error: {
        type: "object",
        description: "Standard error body returned by every endpoint.",
        properties: {
          error: { type: "string", description: "Human-readable message.", example: "Resource not found" },
          code: {
            type: "string",
            description: "Machine-readable error code.",
            enum: [
              "VALIDATION_ERROR",
              "UNAUTHORIZED",
              "FORBIDDEN",
              "NOT_FOUND",
              "CONFLICT",
              "PAYLOAD_TOO_LARGE",
              "RATE_LIMITED",
              "INTERNAL_ERROR",
              "UPSTREAM_ERROR",
              "SERVICE_UNAVAILABLE",
              "GATEWAY_TIMEOUT",
            ],
            example: "NOT_FOUND",
          },
          details: {
            nullable: true,
            description: "Optional structured context (e.g. field-level validation errors).",
          },
          requestId: {
            type: "string",
            description: "Correlation id (also in the x-request-id header), useful when contacting support.",
            example: "req_01HZX8Y2K3M4N5P6Q7R8S9T0V1",
          },
        },
        required: ["error", "code"],
      },
      RateLimitError: {
        type: "object",
        description: "Returned with status 429 and a Retry-After header when a rate limit is exceeded.",
        properties: {
          error: { type: "string", example: "Too many requests" },
          code: { type: "string", enum: ["RATE_LIMITED"] },
          retryAfterSeconds: { type: "integer", example: 60 },
        },
        required: ["error", "code", "retryAfterSeconds"],
      },
      HealthResponse: {
        type: "object",
        properties: {
          status: { type: "string", example: "ok" },
          service: { type: "string", example: "synapsvault" },
          timestamp: { type: "string", format: "date-time" },
        },
      },
      ReadinessResponse: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["ok", "degraded", "unavailable"] },
          service: { type: "string", example: "synapsvault" },
          checks: {
            type: "object",
            properties: {
              database: { type: "string", enum: ["ok", "error"] },
              sorobanRpc: { type: "string", enum: ["ok", "error"] },
            },
          },
          timestamp: { type: "string", format: "date-time" },
        },
      },
      Publisher: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          email: { type: "string", format: "email" },
          walletAddress: { type: "string" },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      PublisherRegisterRequest: {
        type: "object",
        required: ["name", "email", "walletAddress"],
        properties: {
          name: { type: "string", example: "Alice" },
          email: { type: "string", format: "email", example: "alice@example.com" },
          walletAddress: {
            type: "string",
            example: "GABC...XYZ",
            description: "Stellar wallet address",
          },
        },
      },
      PublisherRegisterResponse: {
        allOf: [
          { $ref: "#/components/schemas/Publisher" },
          {
            type: "object",
            properties: {
              apiKey: {
                type: "string",
                description: "Shown once — store it securely",
              },
            },
          },
        ],
      },
      Resource: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          description: { type: "string", nullable: true },
          price: { type: "string", example: "0.50" },
          walletAddress: { type: "string" },
          resourceType: { type: "string", enum: ["file", "link"] },
          verificationStatus: { type: "string", enum: ["pending", "verified", "rejected"] },
          listed: { type: "boolean" },
          onchainStatus: { type: "string", enum: ["none", "pending", "registered", "failed"] },
          onchainTxHash: { type: "string", nullable: true },
          contentHash: {
            type: "string",
            nullable: true,
            description:
              "SHA-256 content integrity anchor recorded in the on-chain registry metadata; null when no anchor is available.",
          },
          accessUrl: { type: "string", format: "uri" },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      VerificationResult: {
        type: "object",
        properties: {
          isOriginal: { type: "boolean" },
          confidence: { type: "number", format: "float", minimum: 0, maximum: 1 },
          flags: {
            type: "array",
            items: { type: "string" },
          },
          usage: {
            type: "object",
            description: "Model token usage and estimated cost for this verification",
            properties: {
              promptTokens: { type: "integer" },
              completionTokens: { type: "integer" },
              totalTokens: { type: "integer" },
              estimatedCostUsd: { type: "number", format: "float" },
            },
          },
        },
      },
      AgentStatusResponse: {
        type: "object",
        properties: {
          agent: {
            type: "object",
            properties: {
              name: { type: "string" },
              walletAddress: { type: "string" },
              network: { type: "string" },
              endpoint: { type: "string", format: "uri" },
              pricePerVerification: { type: "string" },
              currency: { type: "string" },
              status: { type: "string" },
            },
          },
          stats: {
            type: "object",
            properties: {
              totalVerifications: { type: "integer" },
              verified: { type: "integer" },
              rejected: { type: "integer" },
              totalEarned: { type: "string" },
              avgConfidence: { type: "string" },
            },
          },
          usage: {
            type: "object",
            description: "Aggregate model token usage and estimated spend across all verifications",
            properties: {
              totalPromptTokens: { type: "integer" },
              totalCompletionTokens: { type: "integer" },
              totalTokens: { type: "integer" },
              estimatedCostUsd: { type: "string" },
              model: { type: "string" },
            },
          },
          recentActivity: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                resourceTitle: { type: "string" },
                isOriginal: { type: "boolean" },
                confidence: { type: "number" },
                flags: { type: "array", items: { type: "string" } },
                checkedAt: { type: "string", format: "date-time" },
              },
            },
          },
        },
      },
      RegistryStatusResponse: {
        type: "object",
        properties: {
          contractId: { type: "string" },
          network: { type: "string", example: "testnet" },
          resourceCount: { type: "integer" },
        },
      },
      UnsignedTxResponse: {
        type: "object",
        properties: {
          unsignedXdr: {
            type: "string",
            description: "Base64-encoded unsigned Stellar transaction",
          },
          networkPassphrase: { type: "string" },
        },
      },
      PublisherRateLimit: {
        type: "object",
        description: "Effective per-publisher rate limit for authenticated publisher routes.",
        properties: {
          rateLimitRpm: { type: "integer", description: "Effective requests per window.", example: 60 },
          override: {
            type: "integer",
            nullable: true,
            description: "Publisher-specific override; null means the platform default applies.",
          },
          defaultRpm: { type: "integer", example: 60 },
          maxRpm: { type: "integer", description: "Upper bound for overrides.", example: 10000 },
          windowMs: { type: "integer", example: 60000 },
        },
        required: ["rateLimitRpm", "override", "defaultRpm", "maxRpm", "windowMs"],
      },
      PublisherRateLimitUpdate: {
        type: "object",
        required: ["rateLimitRpm"],
        additionalProperties: false,
        properties: {
          rateLimitRpm: {
            type: "integer",
            minimum: 1,
            nullable: true,
            description: "New override (capped at maxRpm); null resets to the platform default.",
          },
        },
      },
      WebhookEventType: {
        type: "string",
        description: "Event types a publisher webhook can receive.",
        enum: ["resource.purchased", "resource.listed", "resource.delisted", "payment.received"],
      },
      WebhookConfig: {
        type: "object",
        description:
          "Publisher webhook configuration. Deliveries are POSTed as JSON " +
          "`{ event, timestamp, data }` with X-SynapsVault-Event and X-SynapsVault-Timestamp headers. " +
          "When a secret is set, X-SynapsVault-Signature carries the hex HMAC-SHA256 of the raw body. " +
          "Failed deliveries are retried with exponential backoff.",
        properties: {
          webhookUrl: { type: "string", format: "uri", nullable: true },
          webhookSecret: { type: "string", nullable: true, description: "Masked; only the last 4 characters are shown." },
          webhookEvents: {
            type: "array",
            items: { $ref: "#/components/schemas/WebhookEventType" },
            description: "Subscribed events; empty means all events.",
          },
          webhookEnabled: { type: "boolean" },
        },
        required: ["webhookUrl", "webhookSecret", "webhookEvents", "webhookEnabled"],
      },
      WebhookConfigUpdate: {
        type: "object",
        additionalProperties: false,
        minProperties: 1,
        properties: {
          webhookUrl: {
            type: "string",
            format: "uri",
            nullable: true,
            description: "Public HTTPS endpoint (private/loopback hosts are rejected); null clears it and disables delivery.",
          },
          webhookSecret: { type: "string", minLength: 16, maxLength: 256, nullable: true },
          webhookEvents: { type: "array", items: { $ref: "#/components/schemas/WebhookEventType" } },
          webhookEnabled: { type: "boolean", description: "Requires a webhookUrl." },
        },
      },
      WebhookDeliveryResult: {
        type: "object",
        properties: {
          delivered: { type: "boolean" },
          attempts: { type: "integer" },
          status: { type: "integer", description: "Last HTTP status from the endpoint, if any." },
          error: { type: "string" },
        },
        required: ["delivered", "attempts"],
      },
      MetricsResponse: {
        type: "object",
        description: "Service metrics snapshot for observability and monitoring.",
        properties: {
          uptimeSeconds: { type: "number", format: "float" },
          requestsTotal: { type: "integer" },
          requestsByStatus: {
            type: "object",
            additionalProperties: { type: "integer" },
            description: "Request counts keyed by HTTP status code.",
          },
          requestDurationMs: {
            type: "object",
            properties: {
              p50: { type: "number", format: "float" },
              p90: { type: "number", format: "float" },
              p99: { type: "number", format: "float" },
            },
          },
          resources: {
            type: "object",
            properties: {
              total: { type: "integer" },
              listed: { type: "integer" },
              verified: { type: "integer" },
            },
          },
          payments: {
            type: "object",
            properties: {
              total: { type: "integer" },
              succeeded: { type: "integer" },
              failed: { type: "integer" },
              volumeUsdc: { type: "string" },
            },
          },
          timestamp: { type: "string", format: "date-time" },
        },
      },
    },
  },
  paths: {
    // ── Health ──────────────────────────────────────────────────────────────
    "/health": {
      get: {
        tags: ["Health"],
        summary: "Liveness probe",
        operationId: "getHealth",
        responses: {
          "200": {
            description: "Service is alive",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/HealthResponse" } },
            },
          },
        },
      },
    },
    "/health/ready": {
      get: {
        tags: ["Health"],
        summary: "Readiness probe",
        operationId: "getHealthReady",
        description: "Checks database and Soroban RPC connectivity.",
        responses: {
          "200": {
            description: "All dependencies healthy",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/ReadinessResponse" } },
            },
          },
          "503": {
            description: "One or more dependencies unavailable",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/ReadinessResponse" } },
            },
          },
        },
      },
    },

    // ── Metrics ─────────────────────────────────────────────────────────────
    "/metrics": {
      get: {
        tags: ["Metrics"],
        summary: "Service metrics snapshot",
        operationId: "getMetrics",
        description: "Returns runtime and operational metrics for monitoring and observability.",
        responses: {
          "200": {
            description: "Metrics snapshot",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/MetricsResponse" } },
            },
          },
        },
      },
    },
    // ── Publishers ──────────────────────────────────────────────────────────
    "/publishers": {
      post: {
        tags: ["Publishers"],
        summary: "Register a new publisher",
        operationId: "registerPublisher",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/PublisherRegisterRequest" },
            },
          },
        },
        responses: {
          "201": {
            description: "Publisher created — API key shown once",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/PublisherRegisterResponse" },
              },
            },
          },
          "409": {
            description: "Email already registered",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
    },
    "/publishers/wallet/{address}": {
      get: {
        tags: ["Publishers"],
        summary: "Look up publisher by wallet address",
        operationId: "getPublisherByWallet",
        parameters: [
          {
            name: "address",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "Stellar wallet address",
          },
        ],
        responses: {
          "200": {
            description: "Publisher found",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Publisher" } } },
          },
          "404": {
            description: "Not found",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
    },
    "/publishers/me": {
      get: {
        tags: ["Publishers"],
        summary: "Get own publisher profile",
        operationId: "getMyProfile",
        security: [{ ApiKeyAuth: [] }],
        responses: {
          "200": {
            description: "Own profile",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Publisher" } } },
          },
          "401": {
            description: "Missing or invalid API key",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
    },
    "/publishers/me/resources": {
      get: {
        tags: ["Publishers"],
        summary: "List own resources",
        operationId: "getMyResources",
        security: [{ ApiKeyAuth: [] }],
        responses: {
          "200": {
            description: "Array of resources",
            content: {
              "application/json": {
                schema: { type: "array", items: { $ref: "#/components/schemas/Resource" } },
              },
            },
          },
          "401": {
            description: "Unauthorized",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
    },
    "/publishers/me/analytics": {
      get: {
        tags: ["Publishers"],
        summary: "Earnings and stats for own resources",
        operationId: "getMyAnalytics",
        security: [{ ApiKeyAuth: [] }],
        responses: {
          "200": {
            description: "Analytics summary",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    summary: {
                      type: "object",
                      properties: {
                        totalEarned: { type: "string" },
                        currency: { type: "string" },
                        totalSales: { type: "integer" },
                        totalResources: { type: "integer" },
                        listedResources: { type: "integer" },
                        verification: {
                          type: "object",
                          properties: {
                            verified: { type: "integer" },
                            rejected: { type: "integer" },
                            pending: { type: "integer" },
                          },
                        },
                      },
                    },
                    resources: { type: "array", items: { $ref: "#/components/schemas/Resource" } },
                  },
                },
              },
            },
          },
          "401": {
            description: "Unauthorized",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
    },
    "/publishers/me/rate-limit": {
      get: {
        tags: ["Publishers"],
        summary: "Get own effective rate limit",
        operationId: "getMyRateLimit",
        security: [{ ApiKeyAuth: [] }],
        responses: {
          "200": {
            description: "Current rate-limit settings",
            content: { "application/json": { schema: { $ref: "#/components/schemas/PublisherRateLimit" } } },
          },
          "401": {
            description: "Missing or invalid API key",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "429": {
            description: "Rate limit exceeded",
            content: { "application/json": { schema: { $ref: "#/components/schemas/RateLimitError" } } },
          },
        },
      },
      patch: {
        tags: ["Publishers"],
        summary: "Set or reset own rate-limit override",
        operationId: "updateMyRateLimit",
        security: [{ ApiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/PublisherRateLimitUpdate" } } },
        },
        responses: {
          "200": {
            description: "Updated rate-limit settings",
            content: { "application/json": { schema: { $ref: "#/components/schemas/PublisherRateLimit" } } },
          },
          "400": {
            description: "Validation error",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "401": {
            description: "Missing or invalid API key",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "429": {
            description: "Rate limit exceeded",
            content: { "application/json": { schema: { $ref: "#/components/schemas/RateLimitError" } } },
          },
        },
      },
    },
    "/publishers/leaderboard": {
      get: {
        tags: ["Publishers"],
        summary: "Public creator leaderboard sorted by earnings",
        operationId: "getLeaderboard",
        responses: {
          "200": {
            description: "Leaderboard array",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      name: { type: "string" },
                      walletAddress: { type: "string" },
                      joinedAt: { type: "string", format: "date-time" },
                      totalResources: { type: "integer" },
                      listedResources: { type: "integer" },
                      verifiedResources: { type: "integer" },
                      totalSales: { type: "integer" },
                      totalEarned: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },

    // ── Webhooks ────────────────────────────────────────────────────────────
    "/publishers/me/webhooks": {
      get: {
        tags: ["Webhooks"],
        summary: "Get own webhook configuration",
        operationId: "getWebhookConfig",
        security: [{ ApiKeyAuth: [] }],
        responses: {
          "200": {
            description: "Webhook configuration",
            content: { "application/json": { schema: { $ref: "#/components/schemas/WebhookConfig" } } },
          },
          "401": {
            description: "Missing or invalid API key",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "429": {
            description: "Rate limit exceeded",
            content: { "application/json": { schema: { $ref: "#/components/schemas/RateLimitError" } } },
          },
        },
      },
      patch: {
        tags: ["Webhooks"],
        summary: "Update own webhook configuration",
        operationId: "updateWebhookConfig",
        security: [{ ApiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/WebhookConfigUpdate" } } },
        },
        responses: {
          "200": {
            description: "Updated webhook configuration",
            content: { "application/json": { schema: { $ref: "#/components/schemas/WebhookConfig" } } },
          },
          "400": {
            description: "Validation error",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "401": {
            description: "Missing or invalid API key",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "429": {
            description: "Rate limit exceeded",
            content: { "application/json": { schema: { $ref: "#/components/schemas/RateLimitError" } } },
          },
        },
      },
    },
    "/publishers/me/webhooks/test": {
      post: {
        tags: ["Webhooks"],
        summary: "Send a signed webhook.test event to the configured URL",
        operationId: "testWebhook",
        security: [{ ApiKeyAuth: [] }],
        responses: {
          "200": {
            description: "Delivered",
            content: { "application/json": { schema: { $ref: "#/components/schemas/WebhookDeliveryResult" } } },
          },
          "400": {
            description: "No webhook URL configured",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "401": {
            description: "Missing or invalid API key",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "502": {
            description: "Delivery failed after retries",
            content: { "application/json": { schema: { $ref: "#/components/schemas/WebhookDeliveryResult" } } },
          },
        },
      },
    },

    // ── Resources ───────────────────────────────────────────────────────────
    "/resources": {
      get: {
        tags: ["Resources"],
        summary: "Browse public resource catalog",
        operationId: "listResources",
        parameters: [
          {
            name: "search",
            in: "query",
            required: false,
            schema: { type: "string" },
            description: "Filter resources by title or description (case-insensitive)",
          },
          {
            name: "sort",
            in: "query",
            required: false,
            schema: {
              type: "string",
              enum: ["newest", "price_asc", "price_desc", "title"],
            },
            description: "Sort order. Defaults to newest first.",
          },
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
            description: "Max number of resources to return (1-100, default 20).",
          },
          {
            name: "offset",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 0, default: 0 },
            description: "Number of resources to skip for pagination.",
          },
        ],
        responses: {
          "200": {
            description:
              "Array of listed resources. Pagination metadata is returned via the " +
              "X-Total-Count, X-Limit, X-Offset, and X-Next-Offset response headers " +
              "(X-Next-Offset is omitted on the last page).",
            content: {
              "application/json": {
                schema: { type: "array", items: { $ref: "#/components/schemas/Resource" } },
              },
            },
            headers: {
              "X-Total-Count": {
                schema: { type: "integer" },
                description: "Total number of matching resources across all pages.",
              },
              "X-Limit": {
                schema: { type: "integer" },
                description: "The page size used for this response.",
              },
              "X-Offset": {
                schema: { type: "integer" },
                description: "The offset used for this response.",
              },
              "X-Next-Offset": {
                schema: { type: "integer" },
                description: "Offset to use for the next page. Omitted on the last page.",
              },
            },
          },
        },
      },
      post: {
        tags: ["Resources"],
        summary: "Publish a new resource (file or link)",
        operationId: "publishResource",
        security: [{ ApiKeyAuth: [], RequestSignature: [] }],
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                required: ["title", "price"],
                properties: {
                  title: { type: "string" },
                  description: { type: "string" },
                  price: { type: "string", example: "0.50", description: "USDC price" },
                  walletAddress: { type: "string", description: "Override publisher wallet" },
                  file: {
                    type: "string",
                    format: "binary",
                    description: "File upload (omit for link resource)",
                  },
                  externalUrl: {
                    type: "string",
                    format: "uri",
                    description: "Required when not uploading a file",
                  },
                },
              },
            },
            "application/json": {
              schema: {
                type: "object",
                required: ["title", "price", "externalUrl"],
                properties: {
                  title: { type: "string" },
                  description: { type: "string" },
                  price: { type: "string", example: "0.50" },
                  walletAddress: { type: "string" },
                  externalUrl: { type: "string", format: "uri" },
                },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Resource created",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Resource" } } },
          },
          "400": {
            description: "Validation error",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "401": {
            description: "Unauthorized",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "429": {
            description: "Rate limit exceeded",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/RateLimitError" } },
            },
          },
        },
      },
    },
    "/resources/{id}/meta": {
      get: {
        tags: ["Resources"],
        summary: "Get resource preview metadata (no payment required)",
        operationId: "getResourceMeta",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "Resource metadata",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Resource" } } },
          },
          "404": {
            description: "Not found",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
    },
    "/resources/{id}/verification": {
      get: {
        tags: ["Resources"],
        summary: "Get verification status and details",
        operationId: "getResourceVerification",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "Verification details",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/VerificationResult" } },
            },
          },
          "404": {
            description: "Not found",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
    },
    "/resources/{id}": {
      get: {
        tags: ["Resources"],
        summary: "Access a resource (x402 paywalled)",
        operationId: "accessResource",
        description:
          "Returns the resource content or a redirect URL after x402 payment. Responds with HTTP 402 if payment is missing.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        security: [{ X402Payment: [] }],
        responses: {
          "200": { description: "Resource content or link URL delivered" },
          "402": { description: "Payment required (x402)" },
          "404": {
            description: "Not found or not listed",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "409": {
            description: "Price mismatch between DB and on-chain registry",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "503": {
            description: "On-chain price lookup failed",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
      delete: {
        tags: ["Resources"],
        summary: "Delist a resource (owner only)",
        operationId: "delistResource",
        security: [{ ApiKeyAuth: [], RequestSignature: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "Resource delisted" },
          "401": {
            description: "Unauthorized",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "404": {
            description: "Not found or not owned",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
    },
    "/resources/{id}/register/prepare": {
      get: {
        tags: ["Resources"],
        summary: "Build unsigned on-chain register transaction",
        operationId: "prepareRegister",
        security: [{ ApiKeyAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "Unsigned XDR + metadata",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/UnsignedTxResponse" } },
            },
          },
          "400": {
            description: "Resource not verified",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "401": {
            description: "Unauthorized",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "403": {
            description: "Forbidden",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "404": {
            description: "Not found",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "409": {
            description: "Already registered",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
    },
    "/resources/{id}/register": {
      post: {
        tags: ["Resources"],
        summary: "Submit signed register transaction to Soroban",
        operationId: "registerResource",
        security: [{ ApiKeyAuth: [], RequestSignature: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  signedXdr: {
                    type: "string",
                    description:
                      "Signed Stellar transaction XDR (omit to use legacy server-signed flow)",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Registration result",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    onchainStatus: { type: "string" },
                    txHash: { type: "string" },
                  },
                },
              },
            },
          },
          "400": {
            description: "Not verified",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "401": {
            description: "Unauthorized",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "409": {
            description: "Already registered or pending",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "502": {
            description: "On-chain submission failed",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
    },
    "/resources/{id}/price/prepare": {
      post: {
        tags: ["Resources"],
        summary: "Build unsigned set_price transaction",
        operationId: "preparePriceUpdate",
        security: [{ ApiKeyAuth: [], RequestSignature: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["price"],
                properties: { price: { type: "string", example: "1.00" } },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Unsigned XDR",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/UnsignedTxResponse" } },
            },
          },
          "401": {
            description: "Unauthorized",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "403": {
            description: "Forbidden",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "404": {
            description: "Not found",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
    },
    "/resources/{id}/price": {
      post: {
        tags: ["Resources"],
        summary: "Submit signed set_price transaction and sync DB",
        operationId: "updatePrice",
        security: [{ ApiKeyAuth: [], RequestSignature: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["signedXdr", "price"],
                properties: {
                  signedXdr: { type: "string" },
                  price: { type: "string", example: "1.00" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Price updated",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    price: { type: "string" },
                    status: { type: "string" },
                  },
                },
              },
            },
          },
          "401": {
            description: "Unauthorized",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "502": {
            description: "Transaction failed",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "504": {
            description: "Confirmation timeout",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
    },
    "/resources/{id}/ownership/prepare": {
      post: {
        tags: ["Resources"],
        summary: "Build unsigned transfer_ownership transaction",
        operationId: "prepareOwnershipTransfer",
        security: [{ ApiKeyAuth: [], RequestSignature: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["newCreator"],
                properties: {
                  newCreator: { type: "string", description: "New owner Stellar address" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Unsigned XDR",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/UnsignedTxResponse" } },
            },
          },
          "401": {
            description: "Unauthorized",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "403": {
            description: "Forbidden",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "404": {
            description: "Not found",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
    },
    "/resources/{id}/ownership": {
      post: {
        tags: ["Resources"],
        summary: "Submit signed transfer_ownership transaction and sync DB",
        operationId: "transferOwnership",
        security: [{ ApiKeyAuth: [], RequestSignature: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["signedXdr", "newCreator"],
                properties: {
                  signedXdr: { type: "string" },
                  newCreator: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Ownership transferred",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    newCreator: { type: "string" },
                    status: { type: "string" },
                  },
                },
              },
            },
          },
          "401": {
            description: "Unauthorized",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "502": {
            description: "Transaction failed",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "504": {
            description: "Confirmation timeout",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
    },

    // ── Registry ────────────────────────────────────────────────────────────
    "/registry/status": {
      get: {
        tags: ["Registry"],
        summary: "On-chain registry metadata and resource count",
        operationId: "getRegistryStatus",
        responses: {
          "200": {
            description: "Registry status",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/RegistryStatusResponse" },
              },
            },
          },
          "503": {
            description: "Registry unavailable",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
    },

    // ── Verify ──────────────────────────────────────────────────────────────
    "/verify-content": {
      post: {
        tags: ["Verify"],
        summary: "AI originality check (x402 paywalled)",
        operationId: "verifyContent",
        description: `Requires an x402 payment of $${0.1} USDC. Returns originality analysis.`,
        security: [{ X402Payment: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["content"],
                properties: {
                  content: { type: "string", description: "Text content to verify" },
                  resourceId: {
                    type: "string",
                    description: "Optional — saves result to this resource",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Verification result",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/VerificationResult" } },
            },
          },
          "402": { description: "Payment required (x402)" },
          "429": {
            description: "Rate limit exceeded",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/RateLimitError" } },
            },
          },
        },
      },
    },
    "/agent/status": {
      get: {
        tags: ["Verify"],
        summary: "Public agent stats and recent verification activity",
        operationId: "getAgentStatus",
        responses: {
          "200": {
            description: "Agent status",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/AgentStatusResponse" } },
            },
          },
        },
      },
    },
  },
} as const;
