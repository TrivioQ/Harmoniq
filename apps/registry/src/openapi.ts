// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import type { FastifyDynamicSwaggerOptions } from '@fastify/swagger';
import type { ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { DeployRequestSchema } from '@harmoniq/core/dist/schemas/DeployRequestSchema';
import {
  FreezeOverrideRequestSchema,
  FreezeRequestSchema,
  PromoteRequestSchema,
  RollbackRequestSchema,
} from '@harmoniq/core/dist/schemas/RollbackRequestSchema';
import {
  KillSwitchRequestSchema,
  SetCanaryRequestSchema,
} from '@harmoniq/core/dist/schemas/CanaryRequestSchema';
import { HealthReportSchema } from '@harmoniq/core/dist/schemas/HealthReportSchema';
import {
  CreateAlertRuleSchema,
  UpdateAlertRuleSchema,
} from '@harmoniq/core/dist/schemas/AlertRuleSchema';
import { CreateScheduledOperationSchema } from '@harmoniq/core/dist/schemas/ScheduledOperationSchema';
import { ApprovalPolicySchema } from '@harmoniq/core/dist/schemas/ApprovalPolicySchema';
import {
  ApprovalBypassSchema,
  ApprovalDecisionSchema,
} from '@harmoniq/core/dist/schemas/ApprovalDecisionSchema';
import {
  OidcConfigSchema,
  OrgOidcConfigSchema,
  OrgProvisioningSchema,
  OrgSamlConfigSchema,
  SamlConfigSchema,
} from '@harmoniq/core/dist/schemas/SsoSchema';
import {
  AddOrgMemberSchema,
  CreateEnvironmentSchema,
  CreateHostAppSchema,
  CreateModuleSchema,
  CreateOrgApiKeySchema,
  CreateOrganizationSchema,
  CreateWorkspaceSchema,
  SetModuleOwnersSchema,
  UpdateEnvironmentSchema,
  UpdateHostAppSchema,
  UpdateModuleSchema,
  UpdateOrgMemberSchema,
  UpdateOrganizationSchema,
  UpdateWorkspaceSchema,
} from '@harmoniq/core/dist/schemas/ResourceSchemas';
import { ApiKeyCreateSchema } from '@harmoniq/core/dist/schemas/ApiKeyCreateSchema';
import {
  GrantInstanceAdminSchema,
  SetPlanSchema,
  SetupCompleteSchema,
  SuspendWorkspaceSchema,
} from '@harmoniq/core/dist/schemas/AdminSchemas';
import { WorkspaceStorageConfigSchema } from '@harmoniq/core/dist/schemas/WorkspaceStorageConfigSchema';
import { GitOpsApplyRequestSchema } from '@harmoniq/core/dist/schemas/GitOpsConfigSchema';
import {
  AuthCallbackRequestSchema,
  AuthStartRequestSchema,
  EmailLoginRequestSchema,
  EmailLoginVerifySchema,
  RefreshRequestSchema,
} from '@harmoniq/core/dist/schemas/AuthSchemas';

// OAS-01/02: the OpenAPI document is generated from the routes (`@fastify/swagger`). The
// routes validate with Zod inside their handlers, so their request bodies are added here
// from the same schemas; the spec can't drift from what the registry accepts.

const WS = '/api/workspaces/:workspaceSlug';
const MODULE = `${WS}/modules/:moduleRef`;
const ENV = `${WS}/host-apps/:hostAppSlug/environments/:envSlug`;
const ORG = '/api/orgs/:orgSlug';

const BODIES: Record<string, ZodTypeAny> = {
  [`POST ${WS}/modules`]: CreateModuleSchema,
  [`PATCH ${MODULE}`]: UpdateModuleSchema,
  [`PUT ${MODULE}/owners`]: SetModuleOwnersSchema,
  [`POST ${MODULE}/deploy`]: DeployRequestSchema,
  [`POST ${MODULE}/rollback`]: RollbackRequestSchema,
  [`POST ${MODULE}/promote`]: PromoteRequestSchema,
  [`PUT ${MODULE}/kill-switch`]: KillSwitchRequestSchema,
  [`PUT ${MODULE}/canary`]: SetCanaryRequestSchema,
  'POST /api/health/:workspaceSlug/:hostAppSlug/:env': HealthReportSchema,
  [`POST ${WS}/alerts`]: CreateAlertRuleSchema,
  [`PATCH ${WS}/alerts/:ruleId`]: UpdateAlertRuleSchema,
  [`POST ${WS}/scheduled-operations`]: CreateScheduledOperationSchema,
  [`PUT ${ENV}/approval-policy`]: ApprovalPolicySchema,
  [`POST ${WS}/approvals/:requestId/approve`]: ApprovalDecisionSchema,
  [`POST ${WS}/approvals/:requestId/reject`]: ApprovalDecisionSchema,
  [`POST ${WS}/approvals/:requestId/bypass`]: ApprovalBypassSchema,
  [`PUT ${WS}/sso/oidc`]: OidcConfigSchema,
  [`PUT ${WS}/sso/saml`]: SamlConfigSchema,
  'POST /api/workspaces': CreateWorkspaceSchema,
  [`PATCH ${WS}`]: UpdateWorkspaceSchema,
  [`POST ${WS}/host-apps`]: CreateHostAppSchema,
  [`PATCH ${WS}/host-apps/:hostAppSlug`]: UpdateHostAppSchema,
  [`POST ${WS}/host-apps/:hostAppSlug/environments`]: CreateEnvironmentSchema,
  [`PATCH ${WS}/host-apps/:hostAppSlug/environments/:envSlug`]: UpdateEnvironmentSchema,
  [`PUT ${ENV}/freeze`]: FreezeRequestSchema,
  [`POST ${ENV}/freeze/override`]: FreezeOverrideRequestSchema,
  [`POST ${WS}/api-keys`]: ApiKeyCreateSchema,
  [`POST ${WS}/storage`]: WorkspaceStorageConfigSchema,
  [`POST ${WS}/apply`]: GitOpsApplyRequestSchema,
  'POST /api/orgs': CreateOrganizationSchema,
  [`PATCH ${ORG}`]: UpdateOrganizationSchema,
  [`POST ${ORG}/members`]: AddOrgMemberSchema,
  [`PATCH ${ORG}/members/:memberId`]: UpdateOrgMemberSchema,
  [`POST ${ORG}/workspaces`]: CreateWorkspaceSchema,
  [`POST ${ORG}/keys`]: CreateOrgApiKeySchema,
  [`PUT ${ORG}/sso/oidc`]: OrgOidcConfigSchema,
  [`PUT ${ORG}/sso/saml`]: OrgSamlConfigSchema,
  [`PUT ${ORG}/provisioning`]: OrgProvisioningSchema,
  'POST /api/admin/setup': SetupCompleteSchema,
  'POST /api/admin/workspaces/:slug/suspend': SuspendWorkspaceSchema,
  'PUT /api/admin/workspaces/:slug/plan': SetPlanSchema,
  'PUT /api/admin/orgs/:slug/plan': SetPlanSchema,
  'POST /api/admin/admins': GrantInstanceAdminSchema,
  'POST /api/auth/:provider/start': AuthStartRequestSchema,
  'POST /api/auth/:provider/callback': AuthCallbackRequestSchema,
  'POST /api/auth/email/request': EmailLoginRequestSchema,
  'POST /api/auth/email/verify': EmailLoginVerifySchema,
  'POST /api/auth/refresh': RefreshRequestSchema,
};

/** Operations by area, in the order of the API reference. */
function tagFor(url: string): string {
  if (/^\/api\/(manifest|importmap|federation-manifest|schema)\//.test(url)) return 'Manifests';
  if (url.startsWith('/api/health/')) return 'Health ingest';
  if (url.startsWith('/api/auth') || url === '/api/me' || url.startsWith('/auth/')) {
    return 'Sign-in';
  }
  if (url.startsWith('/scim/')) return 'SCIM';
  if (url.startsWith('/api/admin') || url === '/api/instance') return 'Instance administration';
  if (url.startsWith('/api/orgs')) return 'Organizations';
  if (url.startsWith('/api/webhooks')) return 'Webhooks';
  if (url.startsWith('/api/workspaces')) {
    const area = url.split('/')[4];
    const areas: Record<string, string> = {
      modules: 'Modules and versions',
      'host-apps': 'Host apps and environments',
      alerts: 'Alerts',
      'scheduled-operations': 'Scheduled operations',
      approvals: 'Approvals',
      'approval-policies': 'Approvals',
      sso: 'Single sign-on',
      scim: 'SCIM',
      'api-keys': 'API keys and members',
      members: 'API keys and members',
      webhooks: 'Webhooks',
      storage: 'Storage',
      apply: 'Workspace as code',
      config: 'Workspace as code',
      audit: 'Audit',
      manifests: 'Manifests',
    };
    return areas[area] ?? 'Workspaces';
  }
  return 'Service';
}

/** Public routes (no credentials): manifests, health ingest, sign-in, setup, SAML SP. */
const isPublic = (method: string, url: string) =>
  /^\/api\/(manifest|importmap|federation-manifest|schema)\//.test(url) ||
  url.startsWith('/api/health/') ||
  (url.startsWith('/api/auth') && url !== '/api/auth/logout') ||
  url.startsWith('/auth/') ||
  url === '/api/instance' ||
  url.startsWith('/api/admin/setup') ||
  ['/health', '/ready', '/metrics'].includes(url) ||
  (method === 'GET' && url === '/api/schema/manifest.json');

const jsonSchema = (schema: ZodTypeAny) => {
  const result = zodToJsonSchema(schema, {
    $refStrategy: 'none',
    target: 'openApi3',
  }) as Record<string, unknown>;
  delete result.$schema;
  return result;
};

/** `@fastify/swagger` transform: hides internals, tags, security and request bodies. */
export const openapiTransform: NonNullable<FastifyDynamicSwaggerOptions['transform']> = ({
  schema,
  url,
  route,
}) => {
  const base = (schema ?? {}) as Record<string, unknown>;
  if (url.startsWith('/docs') || url.startsWith('/static/')) {
    return { schema: { ...base, hide: true }, url };
  }
  const method = (Array.isArray(route.method) ? route.method[0] : route.method).toUpperCase();
  const body = BODIES[`${method} ${url}`];
  return {
    url,
    schema: {
      ...base,
      tags: [tagFor(url)],
      ...(!isPublic(method, url) && { security: [{ bearerAuth: [] }] }),
      ...(body && !base.body && { body: jsonSchema(body) }),
    },
  };
};
