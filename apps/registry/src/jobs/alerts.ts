import { FastifyInstance } from 'fastify';
import { evaluateAlerts } from '../services/alerts';

export async function registerAlertJobs(fastify: FastifyInstance) {
  const { boss, logger, systemDb, withTenant, mutations, webhooks } = fastify.container;

  if (!boss) return;

  // pg-boss 10+ requires queues to exist before schedule()/work(). Idempotent.
  await boss.createQueue('alert.evaluate');
  await boss.createQueue('rollout.advance');

  // ALT-05: every rule, every minute. pg-boss runs a schedule once across replicas.
  await boss.schedule('alert.evaluate', '* * * * *');
  boss.work('alert.evaluate', async () => {
    const { evaluated, fired } = await evaluateAlerts({
      systemDb,
      withTenant,
      mutations,
      webhooks,
      logger,
    });
    if (fired) logger.info(`Alert evaluation: ${fired} of ${evaluated} rules fired`);
  });

  // Rollout Advance - Scheduled (no cron, invoked on demand)
  boss.work('rollout.advance', async () => {
    logger.info('Running rollout.advance job - stub');
    // Implementation deferred to full Staged Rollout Phase
  });
}
