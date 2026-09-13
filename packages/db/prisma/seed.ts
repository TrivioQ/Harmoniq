import { PrismaClient, Role, ActorType, ModuleVersionStatus } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Clear existing
  await prisma.workspace.deleteMany();
  await prisma.user.deleteMany();

  // Create demo user
  const user = await prisma.user.create({
    data: {
      email: 'demo@harmoniq.dev',
      name: 'Demo Admin',
    },
  });

  // Create demo workspace inside a transaction to bypass RLS for its children
  const { workspace, hostApp, remoteModule, productionEnv } = await prisma.$transaction(async (tx) => {
    const ws = await tx.workspace.create({
      data: {
        slug: 'acme-corp',
        name: 'Acme Corporation',
      },
    });

    // Set the RLS context for the transaction
    await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${ws.id}, true)`;

    await tx.workspaceMember.create({
      data: {
        workspaceId: ws.id,
        userId: user.id,
        role: Role.owner,
        joinedAt: new Date(),
      },
    });

    // Create host app
    const host = await tx.hostApp.create({
      data: {
        workspaceId: ws.id,
        name: 'Consumer Portal',
        slug: 'consumer-portal',
        Environments: {
          create: [
            { name: 'Production', slug: 'production', isDefault: true },
            { name: 'Staging', slug: 'staging' },
          ],
        },
      },
      include: {
        Environments: true,
      },
    });

    const prodEnv = host.Environments.find(e => e.slug === 'production')!;

    // Create remote module
    const remote = await tx.remoteModule.create({
      data: {
        workspaceId: ws.id,
        hostAppId: host.id,
        name: 'checkout',
        slug: 'checkout',
        description: 'Checkout flow for consumer portal',
      },
    });

    // Create module version
    await tx.moduleVersion.create({
      data: {
        workspaceId: ws.id,
        remoteModuleId: remote.id,
        environmentId: prodEnv.id,
        version: '1.2.3',
        url: 'https://cdn.example.com/checkout/1.2.3/remoteEntry.js',
        integrity: 'sha256-xyz789',
        status: ModuleVersionStatus.active,
        deployedBy: user.id,
        deployedByType: ActorType.user,
      },
    });

    return { workspace: ws, hostApp: host, remoteModule: remote, productionEnv: prodEnv };
  });

  console.log('Seed completed successfully!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
