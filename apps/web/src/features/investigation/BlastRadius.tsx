import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import type { BlastRadiusGraph, GraphNodeKind } from '@netra/domain';
import {
  AlertTriangle,
  Box,
  Cloud,
  Database,
  FileCode,
  FileDiff,
  Filter,
  Globe,
  KeyRound,
  Package,
  ShieldCheck,
} from 'lucide-react';
import { Button, EmptyState, PanelHeader } from '@/components/primitives';
import { cn } from '@/lib/cn';

/**
 * The blast radius.
 *
 * Every node and edge here was placed by the analyzer, so the graph answers
 * "what does this change touch?" with traced facts. Nodes on the path from the
 * change to the finding are emphasised; everything else recedes.
 */

const KIND_ICON: Record<GraphNodeKind, typeof FileCode> = {
  CHANGED_FILE: FileDiff,
  FILE: FileCode,
  MODULE: Box,
  ENV_VAR: KeyRound,
  SECRET: KeyRound,
  DEPENDENCY: Package,
  ENDPOINT: Globe,
  PERMISSION: ShieldCheck,
  DATA_STORE: Database,
  EXTERNAL_SERVICE: Cloud,
  FINDING: AlertTriangle,
};

const KIND_LABEL: Record<GraphNodeKind, string> = {
  CHANGED_FILE: 'Changed file',
  FILE: 'File',
  MODULE: 'Module',
  ENV_VAR: 'Environment variable',
  SECRET: 'Credential',
  DEPENDENCY: 'Dependency',
  ENDPOINT: 'Endpoint',
  PERMISSION: 'Permission',
  DATA_STORE: 'Data store',
  EXTERNAL_SERVICE: 'External surface',
  FINDING: 'Finding',
};

interface NodeData extends Record<string, unknown> {
  label: string;
  kind: GraphNodeKind;
  file: string | null;
  onAffectedPath: boolean;
  dimmed: boolean;
  evidenceCount: number;
}

function ArtifactNode({ data, selected }: NodeProps<Node<NodeData>>) {
  const Icon = KIND_ICON[data.kind];
  const isFinding = data.kind === 'FINDING';
  const isSecret = data.kind === 'SECRET';

  return (
    <div
      className={cn(
        'group flex w-[186px] items-start gap-2.5 rounded-lg border px-3 py-2.5 transition-all duration-200',
        'bg-surface border-line',
        data.onAffectedPath && 'border-[color-mix(in_oklch,var(--color-state-severe)_50%,transparent)]',
        isFinding &&
          'bg-[color-mix(in_oklch,var(--color-state-severe)_14%,var(--color-surface))] border-state-severe',
        isSecret &&
          'bg-[color-mix(in_oklch,var(--color-state-review)_12%,var(--color-surface))] border-[color-mix(in_oklch,var(--color-state-review)_55%,transparent)]',
        selected && 'ring-2 ring-state-active ring-offset-2 ring-offset-surface-sunken',
        data.dimmed && 'opacity-25',
      )}
    >
      <Handle type="target" position={Position.Left} className="!h-1.5 !w-1.5 !border-0 !bg-line-strong" />
      <Icon
        size={15}
        className={cn(
          'mt-0.5 shrink-0',
          isFinding && 'text-state-severe',
          isSecret && 'text-state-review',
          !isFinding && !isSecret && 'text-ink-subtle',
        )}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[0.78rem] font-medium leading-tight text-ink" title={data.label}>
          {data.label}
        </p>
        <p className="mt-0.5 truncate text-[0.66rem] uppercase tracking-[0.06em] text-ink-subtle">
          {KIND_LABEL[data.kind]}
        </p>
        {data.evidenceCount > 0 ? (
          <p className="mt-1 text-[0.66rem] text-state-active">
            {data.evidenceCount} evidence item{data.evidenceCount === 1 ? '' : 's'}
          </p>
        ) : null}
      </div>
      <Handle type="source" position={Position.Right} className="!h-1.5 !w-1.5 !border-0 !bg-line-strong" />
    </div>
  );
}

const nodeTypes = { artifact: ArtifactNode };

export function BlastRadius({
  graph,
  onSelectNode,
  selectedEvidenceFile,
  className,
}: {
  graph: BlastRadiusGraph | null;
  onSelectNode?: (file: string | null) => void;
  selectedEvidenceFile?: string | null;
  className?: string;
}) {
  const [affectedOnly, setAffectedOnly] = useState(false);
  const layout = useMemo(() => (graph ? toFlow(graph, affectedOnly) : null), [graph, affectedOnly]);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node<NodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // `fitView` as a prop only runs once, on mount. The graph arrives later —
  // the page polls for it — so by the time there are nodes to frame, the
  // viewport has already been set for an empty canvas and the artifacts sit
  // outside it. Holding the instance lets the view be re-fitted whenever the
  // visible set changes, which is also what makes the affected-path filter
  // look like it did something.
  const flowRef = useRef<ReactFlowInstance<Node<NodeData>, Edge> | null>(null);

  useEffect(() => {
    if (!layout) return;
    setNodes(layout.nodes);
    setEdges(layout.edges);
    // After React has committed the new nodes, not before.
    const frame = requestAnimationFrame(() => {
      flowRef.current?.fitView({ padding: 0.18, duration: 220 });
    });
    return () => cancelAnimationFrame(frame);
  }, [layout, setNodes, setEdges]);

  // Selecting evidence highlights the artifact it refers to, so the two panels
  // are two views of one investigation rather than separate lists.
  useEffect(() => {
    setNodes((current) =>
      current.map((node) => ({
        ...node,
        selected: selectedEvidenceFile ? node.data.file === selectedEvidenceFile : false,
      })),
    );
  }, [selectedEvidenceFile, setNodes]);

  const handleNodeClick = useCallback(
    (_: unknown, node: Node<NodeData>) => onSelectNode?.(node.data.file),
    [onSelectNode],
  );

  if (!graph) {
    return (
      <section className={cn('panel flex min-h-0 flex-col overflow-hidden', className)}>
        <PanelHeader title="Blast radius" subtitle="Waiting for impact analysis" />
        <EmptyState
          title="Not mapped yet"
          description="The blast radius appears once Netra has traced what this change can reach."
        />
      </section>
    );
  }

  const affectedCount = graph.nodes.filter((n) => n.onAffectedPath).length;

  return (
    <section className={cn('panel flex min-h-0 flex-col overflow-hidden', className)}>
      <PanelHeader
        title="Blast radius"
        subtitle={`${graph.nodes.length} artifacts · ${affectedCount} on the affected path`}
        actions={
          <Button
            size="sm"
            variant={affectedOnly ? 'primary' : 'ghost'}
            onClick={() => setAffectedOnly((v) => !v)}
            aria-pressed={affectedOnly}
            // With nothing on the affected path this filter can only empty the
            // canvas, which reads as a broken control rather than an answer.
            disabled={affectedCount === 0}
            title={
              affectedCount === 0
                ? 'Nothing is on the affected path in this investigation'
                : affectedOnly
                  ? 'Show every artifact'
                  : 'Show only what the change can reach'
            }
          >
            <Filter size={13} />
            Affected path
          </Button>
        }
      />
      <div className="relative min-h-0 flex-1">
        <ReactFlow
          onInit={(instance) => {
            flowRef.current = instance;
            instance.fitView({ padding: 0.18 });
          }}
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={handleNodeClick}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.18 }}
          minZoom={0.3}
          maxZoom={1.8}
          proOptions={{ hideAttribution: true }}
          nodesDraggable
          nodesConnectable={false}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="var(--color-line-strong)" />
          <Controls
            showInteractive={false}
            className="!border-line !bg-surface [&>button]:!border-line [&>button]:!bg-surface [&>button]:!fill-ink-muted hover:[&>button]:!bg-surface-raised"
          />
          <MiniMap
            pannable
            zoomable
            className="!border !border-line !bg-surface-sunken"
            maskColor="rgba(248,250,252,0.75)"
            nodeColor={(node) =>
              (node.data as NodeData).onAffectedPath ? 'var(--color-state-severe)' : 'var(--color-ink-subtle)'
            }
          />
        </ReactFlow>
      </div>
      {/* The graph is not the only way to read this: the same conclusion in prose. */}
      <p className="border-t border-line px-4 py-2.5 text-xs leading-relaxed text-ink-muted">
        {graph.summary}
      </p>
    </section>
  );
}

/**
 * Lay the graph out left to right by distance from the change.
 *
 * A layered layout matches how the investigation reads: what changed, what it
 * reaches, and what that adds up to.
 */
function toFlow(graph: BlastRadiusGraph, affectedOnly: boolean) {
  const visible = affectedOnly ? graph.nodes.filter((n) => n.onAffectedPath) : graph.nodes;
  const visibleIds = new Set(visible.map((n) => n.id));

  const depth = new Map<string, number>();
  const incoming = new Map<string, number>();
  for (const node of visible) incoming.set(node.id, 0);
  for (const edge of graph.edges) {
    if (visibleIds.has(edge.source) && visibleIds.has(edge.target)) {
      incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
    }
  }

  const queue = visible.filter((n) => (incoming.get(n.id) ?? 0) === 0).map((n) => n.id);
  for (const id of queue) depth.set(id, 0);

  while (queue.length) {
    const id = queue.shift()!;
    const current = depth.get(id) ?? 0;
    for (const edge of graph.edges) {
      if (edge.source !== id || !visibleIds.has(edge.target)) continue;
      const next = current + 1;
      if (next > (depth.get(edge.target) ?? -1)) {
        depth.set(edge.target, next);
        queue.push(edge.target);
      }
    }
  }

  const byColumn = new Map<number, string[]>();
  for (const node of visible) {
    const column = depth.get(node.id) ?? 0;
    byColumn.set(column, [...(byColumn.get(column) ?? []), node.id]);
  }

  const nodes: Node<NodeData>[] = visible.map((node) => {
    const column = depth.get(node.id) ?? 0;
    const siblings = byColumn.get(column)!;
    const row = siblings.indexOf(node.id);
    return {
      id: node.id,
      type: 'artifact',
      position: { x: column * 250, y: row * 92 - (siblings.length - 1) * 46 },
      data: {
        label: node.label,
        kind: node.kind,
        file: node.file,
        onAffectedPath: node.onAffectedPath,
        dimmed: !affectedOnly && !node.onAffectedPath && graph.nodes.some((n) => n.onAffectedPath),
        evidenceCount: node.evidenceIds.length,
      },
    };
  });

  const edges: Edge[] = graph.edges
    .filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target))
    .map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edge.relationship,
      animated: edge.onAffectedPath,
      style: {
        stroke: edge.onAffectedPath ? 'var(--color-state-severe)' : 'var(--color-line-strong)',
        strokeWidth: edge.onAffectedPath ? 1.75 : 1,
      },
      labelStyle: { fill: 'var(--color-ink-muted)', fontSize: 10.5, fontFamily: 'Inter' },
      labelBgStyle: { fill: '#F8FAFC', fillOpacity: 0.92 },
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 3,
    }));

  return { nodes, edges };
}
