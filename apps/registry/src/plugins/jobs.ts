// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import fp from 'fastify-plugin';
import { FastifyPluginAsync } from 'fastify';
import { registerGcJobs } from '../jobs/gc';
import { registerWebhookJobs } from '../jobs/webhooks';
import { registerAlertJobs } from '../jobs/alerts';
import { registerPublishJobs } from '../jobs/publish';
import { registerDomainJobs } from '../jobs/domains';

const jobsPlugin: FastifyPluginAsync = async (fastify, _options) => {
  if (process.env.NODE_ENV !== 'test') {
    await registerGcJobs(fastify);
    await registerWebhookJobs(fastify);
    await registerAlertJobs(fastify);
    await registerPublishJobs(fastify);
    await registerDomainJobs(fastify);

    fastify.container.logger.info('Background jobs registered');
  }
};

export default fp(jobsPlugin, {
  name: 'app-jobs',
  dependencies: ['app-container'],
});
