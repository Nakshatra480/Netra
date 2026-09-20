import type { FastifyReply } from 'fastify';
import { HTTP_STATUS_FOR_ERROR, type ApiErrorBody, type ApiErrorCode } from '@netra/domain';
import { ZodError } from 'zod';

/**
 * One error shape for the whole API, so clients can handle failures uniformly
 * and users get an actionable message rather than a stack trace.
 */
export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: ApiErrorBody['error']['details'],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof ApiError) {
    return reply.status(HTTP_STATUS_FOR_ERROR[error.code]).send({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    } satisfies ApiErrorBody);
  }

  if (error instanceof ZodError) {
    return reply.status(400).send({
      error: {
        code: 'BAD_REQUEST',
        message: 'The request payload is not valid.',
        details: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    } satisfies ApiErrorBody);
  }

  // Surface AWS SDK AccessDeniedException as a safe, actionable 500 — the
  // action name (e.g. events:PutEvents) tells the operator what IAM permission
  // is missing without leaking credentials or internal paths.
  if (
    error != null &&
    typeof error === 'object' &&
    (error as { name?: string }).name === 'AccessDeniedException'
  ) {
    const msg = (error as Error).message ?? '';
    // Extract action from the AWS error message safely (no secrets in there)
    const actionMatch = msg.match(/perform:\s+([\w:]+)/);
    const action = actionMatch ? actionMatch[1] : 'unknown AWS action';
    reply.log.error({ err: error }, 'aws-access-denied');
    return reply.status(500).send({
      error: {
        code: 'INTERNAL',
        message: `Infrastructure permission error: the server is not authorised to perform ${action}. Contact the system administrator.`,
      },
    } satisfies ApiErrorBody);
  }

  // Unexpected failures are logged with their detail but never returned to the
  // caller, which could otherwise leak internals.
  reply.log.error({ err: error }, 'unhandled error');
  return reply.status(500).send({
    error: { code: 'INTERNAL', message: 'Something went wrong on our side.' },
  } satisfies ApiErrorBody);
}
