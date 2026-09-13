import fp from 'fastify-plugin';
import { FastifyPluginAsync } from 'fastify';
import { registerGcJobs } from '../jobs/gc';
import { registerWebhookJobs } from '../jobs/webhooks';
import { registerAlertJobs } from '../jobs/alerts';

const jobsPlugin: FastifyPluginAsync = async (fastify, _options) => {
  if (process.env.NODE_ENV !== 'test') {
    await registerGcJobs(fastify);
    await registerWebhookJobs(fastify);
    await registerAlertJobs(fastify);

    fastify.container.logger.info('Background jobs registered');
  }
};

export default fp(jobsPlugin, {
  name: 'app-jobs',
  dependencies: ['app-container'],
});
