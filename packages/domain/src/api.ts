import { z } from 'zod';

/** Request and response contracts shared by the API service and the web app. */

export const createWorkspaceRequestSchema = z.object({
  name: z.string().trim().min(1).max(80),
});
export type CreateWorkspaceRequest = z.infer<typeof createWorkspaceRequestSchema>;

export const createRepositoryRequestSchema = z.object({
  workspaceId: z.string().min(1),
  provider: z.enum(['GITHUB', 'DEMO']),
  fullName: z.string().trim().min(1).max(200),
  defaultBranch: z.string().trim().min(1).max(200).default('main'),
  githubInstallationId: z.number().int().positive().nullable().default(null),
  githubRepositoryId: z.number().int().positive().nullable().default(null),
});
export type CreateRepositoryRequest = z.infer<typeof createRepositoryRequestSchema>;

export const startDemoInvestigationRequestSchema = z.object({
  workspaceId: z.string().min(1),
  /** Which built-in fixture scenario to investigate. */
  scenario: z.enum(['credential-exposure']).default('credential-exposure'),
});
export type StartDemoInvestigationRequest = z.infer<typeof startDemoInvestigationRequestSchema>;

export const approveRequestSchema = z.object({
  actionId: z.string().min(1),
  note: z.string().max(500).optional(),
});
export type ApproveRequest = z.infer<typeof approveRequestSchema>;

export const rejectRequestSchema = z.object({
  actionId: z.string().min(1),
  reason: z.string().trim().min(1).max(500),
});
export type RejectRequest = z.infer<typeof rejectRequestSchema>;

export const listInvestigationsQuerySchema = z.object({
  workspaceId: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type ListInvestigationsQuery = z.infer<typeof listInvestigationsQuerySchema>;

/** Stable machine-readable error codes returned by the API. */
export const API_ERROR_CODES = [
  'BAD_REQUEST',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'DEPENDENCY_UNAVAILABLE',
  'INTERNAL',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    /** Field-level validation problems, when the code is BAD_REQUEST. */
    details?: Array<{ path: string; message: string }>;
  };
}

export const HTTP_STATUS_FOR_ERROR: Readonly<Record<ApiErrorCode, number>> = {
  BAD_REQUEST: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  DEPENDENCY_UNAVAILABLE: 503,
  INTERNAL: 500,
};
