import type { FastifyInstance } from 'fastify';

/** The OpenAPI document as committed in docs/openapi.json (stable formatting). */
export function openapiDocument(app: FastifyInstance) {
  return JSON.stringify(app.swagger(), null, 2) + '\n';
}
