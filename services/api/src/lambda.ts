/**
 * AWS Lambda entry point for the Netra Investigation API.
 *
 * Wraps the Fastify server using `server.inject()` so the same codebase
 * runs locally (tsx) and in Lambda (Node 22, Function URL) without needing
 * an external adapter library.
 *
 * Lambda Function URL events are a strict superset of API Gateway HTTP API
 * v2 events, so the same adapter covers both invocation paths.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildServer } from './server.js';

// Warm the server on the first request; reuse the instance across invocations.
let serverPromise: Promise<FastifyInstance> | null = null;

async function getServer(): Promise<FastifyInstance> {
  if (!serverPromise) {
    serverPromise = buildServer().then(async (s) => {
      await s.ready();
      return s;
    });
  }
  return serverPromise;
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const server = await getServer();

  // Reconstruct the full path + query string.
  const qs = event.rawQueryString ? `?${event.rawQueryString}` : '';
  const url = (event.rawPath ?? '/') + qs;

  // Decode the body when the runtime base-64 encodes binary payloads.
  const payload =
    event.body
      ? event.isBase64Encoded
        ? Buffer.from(event.body, 'base64').toString('utf8')
        : event.body
      : undefined;

  // Inject the request into Fastify without opening a real socket.
  const opts: InjectOptions = {
    method: event.requestContext.http.method as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'OPTIONS' | 'HEAD',
    url,
    headers: event.headers as Record<string, string>,
    ...(payload !== undefined ? { payload } : {}),
  };
  const response = await server.inject(opts);

  // Flatten multi-value headers; Lambda Function URL accepts string values only.
  const flatHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(response.headers)) {
    if (key === 'transfer-encoding') continue; // chunked encoding not valid here
    flatHeaders[key] = Array.isArray(value) ? value.join(', ') : String(value ?? '');
  }

  return {
    statusCode: response.statusCode,
    headers: flatHeaders,
    body: response.body,
  };
};
