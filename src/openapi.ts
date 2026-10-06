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
        description: "Standardized error response returned by all endpoints on failure.",
        properties: {
          error: {
            type: "object",
            description: "Error details.",
            properties: {
              code: {
                type: "string",
                description: "Machine-readable error code.",
                example: "RESOURCE_NOT_FOUND",
              },
              message: {
                type: "string",
                description: "Human-readable error message.",
                example: "Resource not found",
              },
              details: {
                type: "object",
                nullable: true,
                additionalProperties: true,
                description: "Optional structured context about the error (e.g. field-level validation errors).",
              },
            },
            required: ["code", "message"],
          },
          requestId: {
            type: "string",
            nullable: true,
            description: "Correlation identifier for this request, useful when contacting support.",
            example: "req_01HZX8Y2K3M4N5P6Q7R8S9T0V1",
          },
        },
        required: ["error"],
      },
      RateLimitError: {
        type: "object",
        description: "Standardized error response returned when a rate limit is exceeded.",
        properties: {
          error: {
            type: "object",
            properties: {
              code: { type: "string", example: "RATE_LIMITED" },
              message: { type: "string", example: "Too many requests" },
              details: {
                type: "object",
                nullable: true,
                additionalProperties: true,
                properties: {
                  retryAfterSeconds: { type: "integer", example: 60 },
                },
              },
            },
            required: ["code", "message"],
          },
          requestId: { type: "string", nullable: true },
        },
        required: ["error"],
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
        description: "Current rate-limit quota and usage for the authenticated publisher.",
        properties: {
          limit: {
            type: "integer",
            description: "Maximum number of requests allowed in the current window.",
            example: 100,
          },
          remaining: {
            type: "integer",
            description: "Requests remaining in the current window.",
            example: 42,
          },
          resetAt: {
            type: "string",
            format: "date-time",
            description: "When the current window resets.",
          },
          windowSeconds: {
            type: "integer",
            description: "Length of the rate-limit window in seconds.",
            example: 60,
          },
        },
        required: ["limit", "remaining", "resetAt", "windowSeconds"],
      },
      WebhookEventType: {
        type: "string",
        description: "Event types a webhook subscription can receive.",
        enum: [
          "resource.published",
          "resource.delisted",
          "resource.registered",
          "resource.price_updated",
          "resource.ownership_transferred",
          "sale.completed",
        ],
      },
      Webhook: {
        type: "object",
        properties: {
          id: { type: "string" },
          url: { type: "string", format: "uri", description: "Delivery endpoint (HTTPS)." },
          events: {
            type: "array",
            items: { $ref: "#/components/schemas/WebhookEventType" },
            description: "Event types this subscription receives.",
          },
          active: { type: "boolean" },
          secret: {
            type: "string",
            description:
              "HMAC-SHA256 signing secret. Returned only on creation; use it to verify the X-SynapsVault-Signature header.",
          },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      WebhookCreateRequest: {
        type: "object",
        required: ["url", "events"],
        properties: {
          url: {
            type: "string",
            format: "uri",
            description: "HTTPS endpoint that will receive POST deliveries.",
            example: "https://example.com/webhooks/synapsvault",
          },
          events: {
            type: "array",
            minItems: 1,
            items: { $ref: "#/components/schemas/WebhookEventType" },
            description: "Event types to subscribe to.",
          },
          active: {
            type: "boolean",
            default: true,
            description: "Whether the subscription is active immediately.",
          },
        },
      },
      WebhookUpdateRequest: {
        type: "object",
        properties: {
          url: { type: "string", format: "uri" },
          events: {
            type: "array",
            minItems: 1,
            items: { $ref: "#/components/schemas/WebhookEventType" },
          },
          active: { type: "boolean" },
        },
      },
      WebhookDelivery: {
        type: "object",
        description: "A single webhook delivery attempt.",
        properties: {
          id: { type: "string" },
          webhookId: { type: "string" },
          event: { $ref: "#/components/schemas/WebhookEventType" },
          status: {
            type: "string",
            enum: ["pending", "success", "failed"],
          },
          responseStatus: { type: "integer", nullable: true },
          attempts: { type: "integer" },
          deliveredAt: { type: "string", format: "date-time", nullable: true },
          createdAt: { type: "string", format: "date-time" },
        },
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
      BusinessMetricsResponse: {
        type: "object",
        description: "Aggregated business KPIs across the marketplace.",
        properties: {
          publishers: {
            type: "object",
            properties: {
              total: { type: "integer" },
              active: { type: "integer" },
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
          sales: {
            type: "object",
            properties: {
              total: { type: "integer" },
              volumeUsdc: { type: "string" },
              avgPriceUsdc: { type: "string" },
            },
          },
          topResources: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                title: { type: "string" },
                sales: { type: "integer" },
                revenueUsdc: { type: "string" },
              },
            },
          },
          windowDays: { type: "integer" },
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
    "/metrics/business": {
      get: {
        tags: ["Metrics"],
        summary: "Aggregated business KPIs",
        operationId: "getBusinessMetrics",
        description: "Returns aggregated business metrics across publishers, resources, and sales.",
        parameters: [
          {
            name: "windowDays",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 1, maximum: 365, default: 30 },
            description: "Rolling window in days for the aggregated metrics (1-365, default 30).",
          },
        ],
        responses: {
          "200": {
            description: "Business metrics",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/BusinessMetricsResponse" },
              },
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
        summary: "Get own publisher rate-limit quota and usage",
        operationId: "getMyRateLimit",
        security: [{ ApiKeyAuth: [] }],
        responses: {
          "200": {
            description: "Current rate-limit status",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/PublisherRateLimit" },
              },
            },
          },
          "401": {
            description: "Missing or invalid API key",
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
        summary: "List own webhook subscriptions",
        operationId: "listWebhooks",
        security: [{ ApiKeyAuth: [] }],
        responses: {
          "200": {
            description: "Array of webhook subscriptions",
            content: {
              "application/json": {
                schema: { type: "array", items: { $ref: "#/components/schemas/Webhook" } },
              },
            },
          },
          "401": {
            description: "Missing or invalid API key",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
      post: {
        tags: ["Webhooks"],
        summary: "Create a webhook subscription",
        operationId: "createWebhook",
        security: [{ ApiKeyAuth: [], RequestSignature: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/WebhookCreateRequest" },
            },
          },
        },
        responses: {
          "201": {
            description:
              "Webhook created. The signing secret is returned only in this response; " +
              "store it to verify the X-SynapsVault-Signature header on deliveries.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Webhook" } },
            },
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
    "/publishers/me/webhooks/{id}": {
      get: {
        tags: ["Webhooks"],
        summary: "Get a webhook subscription",
        operationId: "getWebhook",
        security: [{ ApiKeyAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "Webhook subscription",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Webhook" } },
            },
          },
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
      patch: {
        tags: ["Webhooks"],
        summary: "Update a webhook subscription",
        operationId: "updateWebhook",
        security: [{ ApiKeyAuth: [], RequestSignature: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/WebhookUpdateRequest" },
            },
          },
        },
        responses: {
          "200": {
            description: "Updated webhook subscription",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Webhook" } },
            },
          },
          "400": {
            description: "Validation error",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
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
      delete: {
        tags: ["Webhooks"],
        summary: "Delete a webhook subscription",
        operationId: "deleteWebhook",
        security: [{ ApiKeyAuth: [], RequestSignature: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "204": { description: "Webhook deleted" },
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
    "/publishers/me/webhooks/{id}/deliveries": {
      get: {
        tags: ["Webhooks"],
        summary: "List recent delivery attempts for a webhook",
        operationId: "listWebhookDeliveries",
        security: [{ ApiKeyAuth: [] }],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
            description: "Max number of deliveries to return (1-100, default 20).",
          },
        ],
        responses: {
          "200": {
            description: "Array of delivery attempts, newest first",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/WebhookDelivery" },
                },
              },
            },
          },
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
            description
