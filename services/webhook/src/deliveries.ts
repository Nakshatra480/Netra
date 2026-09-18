import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  DynamoDBClient,
  PutItemCommand,
} from '@aws-sdk/client-dynamodb';

/**
 * Delivery idempotency.
 *
 * GitHub retries a delivery it considers failed, and a retry carries the same
 * `X-GitHub-Delivery` id. Without a claim, one webhook could start several
 * investigations -- each of which spends money and opens pull requests.
 *
 * The claim is a conditional write: the first caller to insert the id wins, and
 * every later caller is told it is a duplicate. DynamoDB decides, so two
 * concurrent Lambda invocations cannot both win.
 */

const TABLE = process.env.NETRA_DELIVERIES_TABLE ?? '';
const REGION = process.env.AWS_REGION ?? 'eu-north-1';

/** How long a claim is remembered. GitHub stops retrying long before this. */
const CLAIM_TTL_SECONDS = 7 * 24 * 60 * 60;

const dynamo = new DynamoDBClient({ region: REGION });

export type ClaimResult = 'CLAIMED' | 'DUPLICATE';

export class DeliveryStoreUnavailable extends Error {
  constructor(cause: string) {
    super(`The delivery store is unavailable: ${cause}`);
    this.name = 'DeliveryStoreUnavailable';
  }
}

/**
 * Claim a delivery id, or report that it was already claimed.
 *
 * Throws when the store cannot be reached: the caller must then fail the
 * delivery rather than process it, because processing without a claim risks
 * duplicate work.
 */
export async function claimDelivery(
  deliveryId: string,
  context: { event: string; repository: string },
): Promise<ClaimResult> {
  if (!TABLE) throw new DeliveryStoreUnavailable('NETRA_DELIVERIES_TABLE is not configured');

  const now = Math.floor(Date.now() / 1000);
  try {
    await dynamo.send(
      new PutItemCommand({
        TableName: TABLE,
        Item: {
          deliveryId: { S: deliveryId },
          event: { S: context.event },
          repository: { S: context.repository },
          claimedAt: { S: new Date().toISOString() },
          expiresAt: { N: String(now + CLAIM_TTL_SECONDS) },
        },
        // The whole mechanism, in one line: the write only succeeds if nobody
        // has claimed this delivery already.
        ConditionExpression: 'attribute_not_exists(deliveryId)',
      }),
    );
    return 'CLAIMED';
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) return 'DUPLICATE';
    throw new DeliveryStoreUnavailable((error as Error).name);
  }
}

/**
 * Release a claim that was taken but whose work did not go through.
 *
 * Without this, a delivery claimed and then failed would be treated as a
 * duplicate on GitHub's retry and dropped silently -- the claim would have
 * turned a retryable failure into permanent data loss. Releasing it makes the
 * retry behave like a first attempt.
 *
 * Best-effort by design: if the release itself fails there is nothing useful
 * left to do, and the caller is already returning an error.
 */
export async function releaseDelivery(deliveryId: string): Promise<boolean> {
  if (!TABLE) return false;
  try {
    await dynamo.send(
      new DeleteItemCommand({ TableName: TABLE, Key: { deliveryId: { S: deliveryId } } }),
    );
    return true;
  } catch {
    return false;
  }
}
