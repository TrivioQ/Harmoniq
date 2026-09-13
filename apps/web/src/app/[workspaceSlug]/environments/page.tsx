import { PrismaClient } from '@harmoniq/db';

const db = new PrismaClient();

export default async function EnvironmentsPage(props: {
  params: Promise<{ workspaceSlug: string }>;
}) {
  const params = await props.params;
  const workspace = await db.workspace.findUnique({
    where: { slug: params.workspaceSlug },
    include: {
      HostApps: {
        include: {
          Environments: true
        }
      }
    }
  });

  if (!workspace) return null;

  const environments = workspace.HostApps.flatMap(h => h.Environments.map(e => ({...e, hostAppName: h.name})));

  return (
    <div className="container p-6 md:p-10 max-w-6xl space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Environments</h2>
          <p className="text-muted-foreground mt-2">
            View and manage deployment environments.
          </p>
        </div>
      </div>
      
      <div className="grid gap-4">
        {environments.map((env) => (
          <div key={env.id} className="rounded-xl border bg-card text-card-foreground shadow-sm p-6 flex justify-between items-center">
            <div>
              <h3 className="font-semibold">{env.name}</h3>
              <p className="text-sm text-muted-foreground">{env.slug} &middot; Host App: {env.hostAppName}</p>
            </div>
            <div>
              {env.isDefault && <span className="bg-primary text-primary-foreground text-xs px-2 py-1 rounded">Default</span>}
            </div>
          </div>
        ))}
        {environments.length === 0 && (
          <div className="p-8 border border-dashed rounded-xl text-center">
            <p className="text-muted-foreground">No environments configured yet.</p>
          </div>
        )}
      </div>
    </div>
  );
}
