import { describe, it, expect } from 'vitest';
import { DeployRequestSchema as DeploySchema } from '../schemas/DeployRequestSchema';
import { SetCanaryRequestSchema } from '../schemas/CanaryRequestSchema';
import { ApprovalPolicySchema, ApprovalPolicyDto } from '../schemas/ApprovalPolicySchema';
import { CreateOrganizationSchema, CreateOrganizationDto } from '../schemas/OrganizationSchema';
import { ApprovalDecisionSchema, ApprovalBypassSchema } from '../schemas/ApprovalDecisionSchema';
import { InstanceConfigSchema, InstanceConfigDto } from '../schemas/InstanceConfigSchema';
import {
  WorkspaceStorageConfigSchema,
  WorkspaceStorageConfigDto,
} from '../schemas/WorkspaceStorageConfigSchema';

describe('Zod Schemas', () => {
  it('should validate a valid DeployRequest', () => {
    const validData = {
      environment: 'staging',
      url: 'https://cdn.example.com/remoteEntry.js',
      version: '1.0.0',
      integrity: 'sha384-xyz',
    };
    expect(() => DeploySchema.parse(validData)).not.toThrow();
  });

  it('should fail DeployRequest without an environment or with a non-SRI integrity', () => {
    const base = { url: 'https://cdn.example.com/remoteEntry.js', version: '1.0.0' };
    expect(() => DeploySchema.parse({ ...base, integrity: 'sha384-xyz' })).toThrow();
    expect(() =>
      DeploySchema.parse({ ...base, environment: 'staging', integrity: 'md5-abc' })
    ).toThrow();
  });

  it('should fail DeployRequest without url', () => {
    const invalidData = {
      version: '1.0.0',
      integrity: 'sha384-xyz',
    };
    expect(() => DeploySchema.parse(invalidData)).toThrow();
  });

  it('accepts canary traffic between 1 and 99 only', () => {
    const ok = { environment: 'production', trafficPercent: 10 };
    expect(() => SetCanaryRequestSchema.parse(ok)).not.toThrow();
    for (const trafficPercent of [0, 100, 12.5]) {
      expect(() => SetCanaryRequestSchema.parse({ ...ok, trafficPercent })).toThrow();
    }
    expect(() =>
      DeploySchema.parse({
        environment: 'production',
        url: 'https://cdn.example.com/a.js',
        version: '1.0.0',
        integrity: 'sha384-abc',
        canary: { trafficPercent: 100 },
      })
    ).toThrow();
  });

  describe('Phase 8 Zod Schemas', () => {
    it('should validate a valid ApprovalPolicy', () => {
      const validData: ApprovalPolicyDto = {
        requiredApprovers: 2,
        eligibleRoles: ['admin', 'owner'],
        requireChangeTicket: true,
        ticketUrlPattern: 'https://jira.example.com/browse/{id}',
        expiryHours: 48,
      };
      expect(() => ApprovalPolicySchema.parse(validData)).not.toThrow();
    });

    it('should fail ApprovalPolicy with invalid url pattern', () => {
      const invalidData = {
        requiredApprovers: 2,
        eligibleRoles: ['admin', 'owner'],
        requireChangeTicket: true,
        ticketUrlPattern: 'not-a-url',
        expiryHours: 48,
      };
      expect(() => ApprovalPolicySchema.parse(invalidData)).toThrow();
    });

    it('should validate a valid CreateOrganization', () => {
      const validData: CreateOrganizationDto = {
        slug: 'acme-corp',
        name: 'Acme Corporation',
        plan: 'enterprise',
      };
      expect(() => CreateOrganizationSchema.parse(validData)).not.toThrow();
    });

    it('should validate an ApprovalDecision', () => {
      const validData = {
        decision: 'approved' as const,
        comments: 'Looks good to deploy',
      };
      expect(() => ApprovalDecisionSchema.parse(validData)).not.toThrow();
    });

    it('should validate an ApprovalBypass with long enough justification', () => {
      const validData = {
        bypassJustification: 'This is a long enough justification for emergency bypass',
      };
      expect(() => ApprovalBypassSchema.parse(validData)).not.toThrow();
    });

    it('should fail ApprovalBypass with short justification', () => {
      const invalidData = {
        bypassJustification: 'Too short',
      };
      expect(() => ApprovalBypassSchema.parse(invalidData)).toThrow();
    });

    it('should validate an InstanceConfig', () => {
      const validData: InstanceConfigDto = {
        key: 'system_settings',
        value: { setupCompleted: true, instanceName: 'Harmoniq Hub' },
      };
      expect(() => InstanceConfigSchema.parse(validData)).not.toThrow();
    });

    it('should validate a WorkspaceStorageConfig', () => {
      const validData: WorkspaceStorageConfigDto = {
        provider: 'S3',
        bucket: 'my-bucket',
        region: 'us-east-1',
        credentials: { accessKeyId: 'key', secretAccessKey: 'secret' },
      };
      expect(() => WorkspaceStorageConfigSchema.parse(validData)).not.toThrow();
    });
  });
});
