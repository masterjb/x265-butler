// Processing order of the queue (setting `queue_order`). Leaf module without
// Node imports so client components may import the values; the SQL that
// implements each order lives in the job repository.
//
// Jobs pinned by hand (dragged in the queue, or put back at the front after a
// restart or a stalled encode) always come first, in their manual order. The
// order below only sorts the jobs that are not pinned.

export const QUEUE_ORDERS = ['oldest', 'newest', 'largest', 'smallest'] as const;

export type QueueOrder = (typeof QUEUE_ORDERS)[number];

// 'oldest' sorts by queue position, which is exactly the order before this
// setting existed (including any earlier manual sorting).
export const DEFAULT_QUEUE_ORDER: QueueOrder = 'oldest';

export const QUEUE_ORDER_SETTING_KEY = 'queue_order';

export function isQueueOrder(value: unknown): value is QueueOrder {
  return typeof value === 'string' && (QUEUE_ORDERS as readonly string[]).includes(value);
}

// Unknown or missing stored values fall back to the default instead of failing
// the dispatch.
export function resolveQueueOrder(raw: string | null | undefined): QueueOrder {
  return isQueueOrder(raw) ? raw : DEFAULT_QUEUE_ORDER;
}
