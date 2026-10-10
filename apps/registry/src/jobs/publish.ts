// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { FastifyInstance } from 'fastify';

export const PUBLISH_QUEUE = 'manifest.publish';

/** M2.1: writes manifests to storage/CDN after changes (enqueued by the mutation pipeline). */
export async function registerPublishJobs(fastify: FastifyInstance) {
  const { boss, publisher } = fastify.container;
  if (!boss) return;

  await boss.createQueue(PUBLISH_QUEUE);
  await boss.work<{ environmentId: string }>(PUBLISH_QUEUE, async (jobs) => {
    for (const job of Array.isArray(jobs) ? jobs : [jobs]) {
      await publisher.publish(job.data.environmentId); // throws → pg-boss retries
    }
  });
}
