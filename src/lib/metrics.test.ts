import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { businessEventsTotal, httpErrorsTotal, metricsRegistry } from "./metrics.js";
import { requestDurationMiddleware } from "../middleware/requestDuration.js";

async function counterValue(name: string, labels: Record<string, string>): Promise<number> {
  const metric = await metricsRegistry.getSingleMetric(name)?.get();
  const match = metric?.values.find((v) =>
    Object.entries(labels).every(([k, val]) => v.labels[k] === val),
  );
  return match?.value ?? 0;
}

describe("metrics", () => {
  beforeEach(() => {
    businessEventsTotal.reset();
    httpErrorsTotal.reset();
  });

  it("increments business event counters by label", async () => {
    businessEventsTotal.inc({ event: "verification.completed", outcome: "original" });
    businessEventsTotal.inc({ event: "verification.completed", outcome: "original" });
    businessEventsTotal.inc({ event: "verification.completed", outcome: "not_original" });

    expect(
      await counterValue("business_events_total", { event: "verification.completed", outcome: "original" }),
    ).toBe(2);
    expect(
      await counterValue("business_events_total", { outcome: "not_original" }),
    ).toBe(1);
  });

  it("records HTTP errors with the matched route pattern", async () => {
    const app = express();
    app.use(requestDurationMiddleware);
    app.get("/items/:id", (_req, res) => {
      res.status(404).json({ error: "nope" });
    });

    await request(app).get("/items/42");

    expect(
      await counterValue("http_errors_total", { route: "/items/:id", status_code: "404" }),
    ).toBe(1);
  });

  it("does not record an error for successful requests", async () => {
    const app = express();
    app.use(requestDurationMiddleware);
    app.get("/ok", (_req, res) => {
      res.json({ ok: true });
    });

    await request(app).get("/ok");

    const metric = await metricsRegistry.getSingleMetric("http_errors_total")?.get();
    expect(metric?.values ?? []).toHaveLength(0);
  });
});
