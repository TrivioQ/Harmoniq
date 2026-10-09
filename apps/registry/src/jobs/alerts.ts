import { FastifyInstance } from 'fastify';
import { evaluateAlerts } from '../services/alerts';
import { evaluateRollouts } from '../services/rollout';

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

  // STG-02: staged rollouts, checked every minute (a scan, so nothing is lost when a
  // replica restarts mid-band).
  await boss.schedule('rollout.advance', '* * * * *');
  boss.work('rollout.advance', async () => {
    const results = await evaluateRollouts({ systemDb, withTenant, mutations, webhooks, logger });
    for (const r of results.filter((r) => r.outcome !== 'waiting_for_samples')) {
      logger.info(`Rollout ${r.versionId}: ${r.outcome}`);
    }
  });
}
