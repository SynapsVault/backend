import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import docsRoutes from './docs';

describe('docs routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await app.register(docsRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /openapi.json returns a valid OpenAPI 3.0 document', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/openapi.json',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');

    const document = JSON.parse(response.body);

    expect(document).toBeTypeOf('object');
    expect(document.openapi).toBeTypeOf('string');
    expect(document.openapi).toMatch(/^3\.0\.\d+$/);
    expect(document.info).toBeTypeOf('object');
    expect(document.info.title).toBeTypeOf('string');
    expect(document.info.version).toBeTypeOf('string');
    expect(document.paths).toBeTypeOf('object');
  });

  it('GET /docs returns HTML containing the Swagger UI bundle reference', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/docs',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('swagger-ui');
  });
});