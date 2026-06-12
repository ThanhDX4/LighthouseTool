#!/usr/bin/env node
import { Queue } from "bullmq";
import { Redis } from "ioredis";

const queueName = process.env.AUDIT_QUEUE_NAME ?? "lh-audits";
const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const dryRun = process.argv.includes("--dry-run");

const jobStates = [
  "waiting",
  "active",
  "delayed",
  "prioritized",
  "paused",
  "waiting-children",
  "completed",
  "failed"
];

const connection = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false
});
const queue = new Queue(queueName, { connection });

try {
  const before = await queue.getJobCounts(...jobStates);
  console.log(JSON.stringify({ queue: queueName, redisUrl, before }, null, 2));

  if (dryRun) {
    console.log("Dry run only. Queue was not cleared.");
  } else {
    await queue.obliterate({ force: true });
    const after = await queue.getJobCounts(...jobStates);
    console.log(JSON.stringify({ queue: queueName, cleared: true, after }, null, 2));
  }
} finally {
  await queue.close();
  connection.disconnect();
}
