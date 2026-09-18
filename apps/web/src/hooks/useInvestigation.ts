import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Action,
  BlastRadiusGraph,
  Evidence,
  Finding,
  InvestigationDetail,
  InvestigationEvent,
  InvestigationStatus,
  Remediation,
  VerificationResult,
} from '@netra/domain';
import { api, ApiError, type Session } from '@/lib/api';

/** One command that ran in the sandbox, assembled from its stream of events. */
export interface CommandBlock {
  readonly id: string;
  readonly tool: string;
  readonly command: string;
  output: Array<{ stream: 'stdout' | 'stderr'; text: string }>;
  exitCode: number | null;
  durationMs: number | null;
  timedOut: boolean;
}

/** A concise statement of what the investigator is doing. Never reasoning. */
export interface ActivityItem {
  readonly id: string;
  message: string;
  state: 'STARTED' | 'COMPLETED' | 'FAILED';
  readonly at: string;
}

export interface InvestigationState {
  status: InvestigationStatus | null;
  failureReason: string | null;
  detail: InvestigationDetail | null;
  commands: CommandBlock[];
  activities: ActivityItem[];
  findings: Finding[];
  evidence: Evidence[];
  verifications: VerificationResult[];
  graph: BlastRadiusGraph | null;
  remediation: Remediation | null;
  action: Action | null;
  /** Whether the live stream is currently attached. */
  streaming: boolean;
  loading: boolean;
  error: string | null;
}

const TERMINAL_STATUSES: InvestigationStatus[] = ['RESOLVED', 'REJECTED', 'FAILED'];

/**
 * Subscribes to one investigation.
 *
 * Stored state is loaded first so the page is useful immediately, then the
 * event stream takes over. Events are applied by sequence number, so a replay
 * after a reconnect cannot duplicate or reorder anything.
 */
export function useInvestigation(session: Session | null, investigationId: string | undefined) {
  const [state, setState] = useState<InvestigationState>(initialState);
  const lastSeq = useRef(0);
  const sourceRef = useRef<EventSource | null>(null);

  const applyEvent = useCallback((event: InvestigationEvent) => {
    if (event.seq <= lastSeq.current) return;
    lastSeq.current = event.seq;
    setState((current) => reduce(current, event));
  }, []);

  const refresh = useCallback(async () => {
    if (!session || !investigationId) return;
    try {
      const detail = await api.getInvestigation(session, investigationId);
      setState((current) => ({
        ...current,
        detail,
        status: detail.investigation.status,
        failureReason: detail.investigation.failureReason,
        findings: detail.findings,
        evidence: detail.evidence,
        verifications: detail.verifications,
        graph: detail.graph,
        remediation: detail.remediation,
        action: detail.action,
        loading: false,
        error: null,
      }));
    } catch (error) {
      setState((current) => ({
        ...current,
        loading: false,
        error: error instanceof ApiError ? error.message : 'Could not load the investigation.',
      }));
    }
  }, [session, investigationId]);

  useEffect(() => {
    lastSeq.current = 0;
    setState(initialState);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!session || !investigationId) return;

    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      if (closed) return;
      const source = new EventSource(
        api.eventStreamUrl(session, investigationId, lastSeq.current),
      );
      sourceRef.current = source;

      source.onopen = () => setState((c) => ({ ...c, streaming: true }));

      source.onmessage = (message) => {
        const parsed = JSON.parse(message.data) as InvestigationEvent | { type: string };
        if (parsed.type === 'stream_complete') {
          source.close();
          setState((c) => ({ ...c, streaming: false }));
          void refresh();
          return;
        }
        applyEvent(parsed as InvestigationEvent);
      };

      source.onerror = () => {
        source.close();
        setState((c) => ({ ...c, streaming: false }));
        if (closed) return;
        // Reconnect and replay from the last sequence seen, so a dropped
        // connection costs latency rather than events.
        retry = setTimeout(connect, 1500);
      };
    };

    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, [session, investigationId, applyEvent, refresh]);

  // Once an investigation reaches a terminal state, reconcile with the store so
  // anything the stream missed is still shown.
  useEffect(() => {
    if (state.status && TERMINAL_STATUSES.includes(state.status)) void refresh();
  }, [state.status, refresh]);

  const evidenceByFinding = useMemo(() => {
    const map = new Map<string, Evidence[]>();
    for (const item of state.evidence) {
      map.set(item.findingId, [...(map.get(item.findingId) ?? []), item]);
    }
    return map;
  }, [state.evidence]);

  return { ...state, refresh, evidenceByFinding };
}

const initialState: InvestigationState = {
  status: null,
  failureReason: null,
  detail: null,
  commands: [],
  activities: [],
  findings: [],
  evidence: [],
  verifications: [],
  graph: null,
  remediation: null,
  action: null,
  streaming: false,
  loading: true,
  error: null,
};

/** Fold one event into the view state. */
function reduce(state: InvestigationState, event: InvestigationEvent): InvestigationState {
  switch (event.type) {
    case 'status_changed':
      return { ...state, status: event.status, failureReason: event.reason };

    case 'activity': {
      const existing = state.activities.findIndex((a) => a.id === event.activityId);
      if (existing >= 0) {
        const activities = [...state.activities];
        activities[existing] = {
          ...activities[existing]!,
          message: event.message,
          state: event.state,
        };
        return { ...state, activities };
      }
      return {
        ...state,
        activities: [
          ...state.activities,
          { id: event.activityId, message: event.message, state: event.state, at: event.at },
        ],
      };
    }

    case 'command_started':
      return {
        ...state,
        commands: [
          ...state.commands,
          {
            id: event.commandId,
            tool: event.tool,
            command: event.command,
            output: [],
            exitCode: null,
            durationMs: null,
            timedOut: false,
          },
        ],
      };

    case 'command_output':
      return {
        ...state,
        commands: state.commands.map((block) =>
          block.id === event.commandId
            ? { ...block, output: [...block.output, { stream: event.stream, text: event.chunk }] }
            : block,
        ),
      };

    case 'command_finished':
      return {
        ...state,
        commands: state.commands.map((block) =>
          block.id === event.commandId
            ? {
                ...block,
                exitCode: event.exitCode,
                durationMs: event.durationMs,
                timedOut: event.timedOut,
              }
            : block,
        ),
      };

    case 'finding_detected':
      return { ...state, findings: upsert(state.findings, event.finding) };

    case 'evidence_found':
      return { ...state, evidence: upsert(state.evidence, event.evidence) };

    case 'verification':
      return event.result
        ? { ...state, verifications: upsert(state.verifications, event.result) }
        : state;

    case 'graph_updated':
      return { ...state, graph: event.graph };

    case 'remediation_proposed':
      return { ...state, remediation: event.remediation, action: event.action };

    case 'action_updated':
      return { ...state, action: event.action };

    default:
      return state;
  }
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const index = list.findIndex((existing) => existing.id === item.id);
  if (index < 0) return [...list, item];
  const next = [...list];
  next[index] = item;
  return next;
}
