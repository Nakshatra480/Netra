import type { InvestigationEvent } from '@netra/domain';

type Subscriber = (event: InvestigationEvent) => void;

/**
 * In-process fan-out of investigation events to connected SSE clients.
 *
 * Live delivery is best-effort; durability comes from the store. A client that
 * reconnects replays missed events by sequence number, so a dropped connection
 * costs latency rather than data.
 */
export class EventBroker {
  #subscribers = new Map<string, Set<Subscriber>>();

  subscribe(investigationId: string, subscriber: Subscriber): () => void {
    const subscribers = this.#subscribers.get(investigationId) ?? new Set<Subscriber>();
    subscribers.add(subscriber);
    this.#subscribers.set(investigationId, subscribers);

    return () => {
      subscribers.delete(subscriber);
      if (subscribers.size === 0) this.#subscribers.delete(investigationId);
    };
  }

  publish(investigationId: string, event: InvestigationEvent): void {
    const subscribers = this.#subscribers.get(investigationId);
    if (!subscribers) return;
    for (const subscriber of subscribers) {
      try {
        subscriber(event);
      } catch {
        // A failing subscriber is a broken client connection, never a reason to
        // interrupt the investigation or the other subscribers.
      }
    }
  }

  subscriberCount(investigationId: string): number {
    return this.#subscribers.get(investigationId)?.size ?? 0;
  }
}
