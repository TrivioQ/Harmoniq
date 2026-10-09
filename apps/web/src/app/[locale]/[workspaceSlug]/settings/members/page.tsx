import { getTranslations } from 'next-intl/server';
import { ActionForm } from '@/components/ActionForm';
import { workspaceApi } from '@/lib/workspaceApi';
import { changeRoleAction, inviteMemberAction, removeMemberAction } from '../../actions';

const ROLES = ['viewer', 'developer', 'admin', 'owner'] as const;

export default async function MembersPage(props: { params: Promise<{ workspaceSlug: string }> }) {
  const { workspaceSlug } = await props.params;
  const t = await getTranslations('MembersPage');
  const [{ members }, workspace] = await Promise.all([
    workspaceApi.members(workspaceSlug),
    workspaceApi.get(workspaceSlug),
  ]);
  // Only owners can grant or change ownership (enforced by the registry too).
  const assignable = workspace.role === 'owner' ? ROLES : ROLES.filter((r) => r !== 'owner');

  const roleSelect = (name: string, defaultValue?: string) => (
    <select
      name={name}
      defaultValue={defaultValue}
      aria-label={t('role')}
      className="rounded-md border px-2 py-1.5 text-sm"
    >
      {assignable.map((r) => (
        <option key={r} value={r}>
          {t(`roles.${r}`)}
        </option>
      ))}
    </select>
  );

  return (
    <div className="space-y-6">
      <section className="rounded-xl border bg-card p-6 space-y-3">
        <h3 className="font-semibold">{t('invite')}</h3>
        <ActionForm
          action={inviteMemberAction.bind(null, workspaceSlug)}
          submitLabel={t('inviteSubmit')}
          className="flex flex-wrap items-center gap-2"
        >
          <input
            name="email"
            type="email"
            required
            placeholder="dev@example.com"
            aria-label={t('email')}
            className="rounded-md border px-3 py-1.5 text-sm w-64"
          />
          {roleSelect('role', 'developer')}
        </ActionForm>
        <p className="text-xs text-muted-foreground">{t('inviteHint')}</p>
      </section>

      <ul className="rounded-xl border bg-card divide-y">
        {members.map((member) => (
          <li key={member.id} className="p-4 flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="font-medium">{member.user.name ?? member.user.email}</div>
              <div className="text-xs text-muted-foreground">
                {member.user.email}
                {member.status === 'invited' && ` · ${t('pending')}`}
              </div>
            </div>
            {member.role === 'owner' && workspace.role !== 'owner' ? (
              <span className="text-sm">{t('roles.owner')}</span>
            ) : (
              <div className="flex gap-2 items-center">
                <ActionForm
                  action={changeRoleAction.bind(null, workspaceSlug, member.id)}
                  submitLabel={t('save')}
                  variant="outline"
                  className="flex items-center gap-2"
                >
                  {roleSelect('role', member.role)}
                </ActionForm>
                <ActionForm
                  action={removeMemberAction.bind(null, workspaceSlug, member.id)}
                  submitLabel={t('remove')}
                  variant="danger"
                  confirm={t('removeConfirm', { email: member.user.email })}
                />
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
