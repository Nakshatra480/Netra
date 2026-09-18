import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import type { CodeChangeEvent } from './changeEvent.js';

/**
 * Publishing a code change to EventBridge.
 *
 * The webhook handler's job ends here. EventBridge decouples "GitHub told us
 * something changed" from "Netra investigates it", so the investigation can be
 * slow, retried or rewritten without GitHub ever waiting on it.
 */

const BUS = process.env.NETRA_EVENT_BUS_NAME ?? '';
const REGION = process.env.AWS_REGION ?? 'eu-north-1';

export const EVENT_SOURCE = 'netra.github';
export const EVENT_DETAIL_TYPE = 'Netra.CodeChange';

const events = new EventBridgeClient({ region: REGION });

export class PublishFailed extends Error {
  constructor(cause: string) {
    super(`Could not publish the change event: ${cause}`);
    this.name = 'PublishFailed';
  }
}

export async function publishCodeChange(event: CodeChangeEvent): Promise<string> {
  if (!BUS) throw new PublishFailed('NETRA_EVENT_BUS_NAME is not configured');

  let response;
  try {
    response = await events.send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: BUS,
            Source: EVENT_SOURCE,
            DetailType: EVENT_DETAIL_TYPE,
            Detail: JSON.stringify(event),
            // Lets a consumer correlate an investigation back to the exact
            // GitHub delivery that caused it.
            Resources: [`github-delivery/${event.deliveryId}`],
          },
        ],
      }),
    );
  } catch (error) {
    throw new PublishFailed((error as Error).name);
  }

  // PutEvents answers 200 even when an individual entry was rejected, so the
  // per-entry result is what actually says whether this was published.
  if (response.FailedEntryCount && response.FailedEntryCount > 0) {
    const entry = response.Entries?.[0];
    throw new PublishFailed(entry?.ErrorCode ?? 'entry rejected');
  }

  return response.Entries?.[0]?.EventId ?? 'unknown';
}
