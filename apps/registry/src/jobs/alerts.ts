import { FastifyInstance } from 'fastify';

export async function registerAlertJobs(fastify: FastifyInstance) {
  const boss = fastify.container.boss;
  const logger = fastify.container.logger;

  if (!boss) return;

  // 1. Alert Evaluate - Every minute
  await boss.schedule('alert.evaluate', '* * * * *');
  boss.work('alert.evaluate', async () => {
    logger.info('Running alert.evaluate job - stub');
    // Implementation deferred to full Alerting Phase
  });

  // 2. Rollout Advance - Scheduled (no cron, invoked on demand)
  boss.work('rollout.advance', async () => {
    logger.info('Running rollout.advance job - stub');
    // Implementation deferred to full Staged Rollout Phase
  });

  // 3. Alert Auto Rollback - Invoked on demand
  boss.work('alert.auto_rollback', async () => {
    logger.info('Running alert.auto_rollback job - stub');
    // Implementation deferred to full Alerting Phase
  });
}
