import { z } from 'zod';
import { INVESTIGATION_STATUSES } from './status.js';
import {
  actionSchema,
  blastRadiusGraphSchema,
  evidenceSchema,
  findingSchema,
  remediationSchema,
  verificationResultSchema,
} from './models.js';

/**
 * Events emitted by the investigator as work actually happens.
 *
 * Every event corresponds to a real backend activity: a command that ran, a
 * byte of output that was produced, a check that completed. Nothing here is
 * generated for visual effect, and no event carries model chain-of-thought.
 */

const base = z.object({
  /** Monotonic per-investigation sequence number; the UI orders by this. */
  seq: z.number().int().nonnegative(),
  investigationId: z.string().min(1),
  at: z.string().datetime(),
});

export const statusChangedEventSchema = base.extend({
  type: z.literal('status_changed'),
  status: z.enum(INVESTIGATION_STATUSES),
  /** Present when status is FAILED. */
  reason: z.string().nullable(),
});

/**
 * A concise, user-facing statement of what the investigator is doing.
 * Deliberately a summary: the agent's internal reasoning is never emitted.
 */
export const activityEventSchema = base.extend({
  type: z.literal('activity'),
  state: z.enum(['STARTED', 'COMPLETED', 'FAILED']),
  /** Groups a STARTED event with its COMPLETED/FAILED counterpart. */
  activityId: z.string().min(1),
  message: z.string().min(1),
});

export const commandStartedEventSchema = base.extend({
  type: z.literal('command_started'),
  commandId: z.string().min(1),
  /** The tool contract that authorised this command. */
  tool: z.string().min(1),
  /** Rendered argv, exactly as executed in the sandbox. */
  command: z.string().min(1),
});

export const commandOutputEventSchema = base.extend({
  type: z.literal('command_output'),
  commandId: z.string().min(1),
  stream: z.enum(['stdout', 'stderr']),
  chunk: z.string(),
});

export const commandFinishedEventSchema = base.extend({
  type: z.literal('command_finished'),
  commandId: z.string().min(1),
  exitCode: z.number().int(),
  durationMs: z.number().int().nonnegative(),
  /** True when the sandbox killed the command for exceeding its limits. */
  timedOut: z.boolean(),
});

export const findingDetectedEventSchema = base.extend({
  type: z.literal('finding_detected'),
  finding: findingSchema,
});

export const evidenceFoundEventSchema = base.extend({
  type: z.literal('evidence_found'),
  evidence: evidenceSchema,
});

export const verificationEventSchema = base.extend({
  type: z.literal('verification'),
  state: z.enum(['STARTED', 'COMPLETED']),
  verifier: z.string().min(1),
  findingId: z.string().min(1),
  /** Present when state is COMPLETED. */
  result: verificationResultSchema.nullable(),
});

export const graphUpdatedEventSchema = base.extend({
  type: z.literal('graph_updated'),
  graph: blastRadiusGraphSchema,
});

export const remediationProposedEventSchema = base.extend({
  type: z.literal('remediation_proposed'),
  remediation: remediationSchema,
  action: actionSchema,
});

export const actionUpdatedEventSchema = base.extend({
  type: z.literal('action_updated'),
  action: actionSchema,
});

export const investigationEventSchema = z.discriminatedUnion('type', [
  statusChangedEventSchema,
  activityEventSchema,
  commandStartedEventSchema,
  commandOutputEventSchema,
  commandFinishedEventSchema,
  findingDetectedEventSchema,
  evidenceFoundEventSchema,
  verificationEventSchema,
  graphUpdatedEventSchema,
  remediationProposedEventSchema,
  actionUpdatedEventSchema,
]);

export type InvestigationEvent = z.infer<typeof investigationEventSchema>;
export type InvestigationEventType = InvestigationEvent['type'];
export type StatusChangedEvent = z.infer<typeof statusChangedEventSchema>;
export type ActivityEvent = z.infer<typeof activityEventSchema>;
export type CommandStartedEvent = z.infer<typeof commandStartedEventSchema>;
export type CommandOutputEvent = z.infer<typeof commandOutputEventSchema>;
export type CommandFinishedEvent = z.infer<typeof commandFinishedEventSchema>;
