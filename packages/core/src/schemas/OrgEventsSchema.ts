// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';

/** TAD-09/10: events of an organization, for its webhooks and notification channels. */
export const OrgEventNameSchema = z.enum([
  'org.member.added',
  'org.member.removed',
  'org.member.role_changed',
  'org.workspace.created',
  'org.workspace.deleted',
  'org.workspace.restored',
  'org.workspace.attached',
  'org.workspace.detached',
  'org.key.created',
  'org.key.revoked',
  'org.key.rotated',
  'org.policy.updated',
  'quota.warning',
  'quota.exceeded',
  'plan.changed',
  // Notification channels also hear these (TAD-09).
  'deploy.approval_requested',
  'domain.verification_lost',
]);
export type OrgEventName = z.infer<typeof OrgEventNameSchema>;

const eventList = z
  .array(z.union([OrgEventNameSchema, z.literal('*')]))
  .min(1)
  .max(50);

export const CreateOrgWebhookSchema = z.object({
  url: z.string().url().max(2048),
  events: eventList,
});
export const UpdateOrgWebhookSchema = z.object({
  url: z.string().url().max(2048).optional(),
  events: eventList.optional(),
  active: z.boolean().optional(),
  paused: z.boolean().optional(),
});

/** TAD-09: email addresses, or a Slack or Teams incoming-webhook URL. */
export const CreateNotificationChannelSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('email'),
    name: z.string().min(1).max(100),
    emails: z.array(z.string().email().max(320)).min(1).max(20),
    events: eventList,
  }),
  z.object({
    kind: z.enum(['slack', 'teams']),
    name: z.string().min(1).max(100),
    url: z.string().url().max(2048),
    events: eventList,
  }),
]);
export const UpdateNotificationChannelSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  events: eventList.optional(),
  active: z.boolean().optional(),
});

/** AUD-06: an HTTPS endpoint or an S3-compatible bucket. */
export const CreateAuditSinkSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('https'),
    name: z.string().min(1).max(100),
    url: z.string().url().max(2048),
  }),
  z.object({
    kind: z.literal('s3'),
    name: z.string().min(1).max(100),
    bucket: z.string().min(3).max(63),
    region: z.string().min(1).max(64),
    endpoint: z.string().url().max(2048).optional(),
    prefix: z.string().max(200).optional(),
    accessKeyId: z.string().min(1).max(256),
    secretAccessKey: z.string().min(1).max(512),
  }),
]);
export const UpdateAuditSinkSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  enabled: z.boolean().optional(),
});
