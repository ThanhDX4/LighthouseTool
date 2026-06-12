import { Queue, QueueEvents } from "bullmq";
import type { Redis } from "ioredis";

export const auditQueueName = "lh-audits";

export function createAuditQueue(connection: Redis): Queue {
  return new Queue(auditQueueName, { connection });
}

export function createAuditQueueEvents(connection: Redis): QueueEvents {
  return new QueueEvents(auditQueueName, { connection });
}
