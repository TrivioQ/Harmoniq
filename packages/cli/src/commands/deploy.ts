import { Command } from 'commander';

export const deployCommand = new Command('deploy')
  .description('Deploy a module version to an environment')
  .requiredOption('--workspace <slug>', 'Workspace slug')
  .requiredOption('--module <id>', 'Module ID')
  .requiredOption('--env <env>', 'Environment')
  .requiredOption('--url <url>', 'Module bundle URL')
  .requiredOption('--version-id <id>', 'Module version ID (semver)')
  .requiredOption('--integrity <hash>', 'Subresource integrity hash')
  .option('--dry-run', 'Validate without committing')
  .action(async (options, command) => {
    const parentOpts = command.parent?.opts() || {};
    const apiKey = parentOpts.apiKey;
    const registryUrl = parentOpts.registryUrl;

    if (!apiKey) {
      console.error('Error: --api-key is required');
      process.exit(1);
    }

    const payload = {
      environment: options.env,
      version: options.versionId,
      url: options.url,
      integrity: options.integrity,
      dryRun: options.dryRun || false,
    };

    try {
      const res = await fetch(
        `${registryUrl}/api/workspaces/${options.workspace}/modules/${options.module}/deploy`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(payload),
        }
      );

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.error(`Deploy failed: ${res.status}`, err);
        process.exit(1);
      }

      const data = await res.json();
      if (parentOpts.json) {
        console.log(JSON.stringify(data));
      } else {
        console.log(
          `Successfully deployed ${options.module} version ${options.versionId} to ${options.env}`
        );
      }
    } catch (e) {
      console.error('Network error during deploy', e);
      process.exit(1);
    }
  });
