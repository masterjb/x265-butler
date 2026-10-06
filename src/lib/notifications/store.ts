// Thin pull-through store over detectEncoders().
//
// NO persistence (DB) — per CONTEXT.md Constraint: warnings are runtime-derived
// from probe, NOT persisted. NO migration. A later release may swap this for an
// eventual-consistency store with SSE.

import { detectEncoders } from '../encode/detection';
import { notificationsFromDetection } from './from-detection';
import type { Notification } from './types';

export interface NotificationStore {
  list(): Promise<Notification[]>;
}

export function notificationStore(): NotificationStore {
  return {
    async list() {
      const detection = await detectEncoders();
      return notificationsFromDetection(detection);
    },
  };
}
