import { describe, it, expect } from 'vitest';
import { DeployRequestSchema as DeploySchema } from '../schemas/DeployRequestSchema';
import { CanaryConfigSchema as CanarySchema } from '../schemas/CanaryConfigSchema';
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
      url: 'https://cdn.example.com/remoteEntry.js',
      version: '1.0.0',
      integrity: 'sha384-xyz',
    };
    expect(() => DeploySchema.parse(validData)).not.toThrow();
  });

  it('should fail DeployRequest without url', () => {
    const invalidData = {
      version: '1.0.0',
      integrity: 'sha384-xyz',
    };
    expect(() => DeploySchema.parse(invalidData)).toThrow();
  });

  it('should validate a valid CanaryConfig', () => {
    const validData = {
      trafficPercentage: 50,
      targetVersionId: 'clx0000000000000000000001',
      stableVersionId: 'clx0000000000000000000002',
    };
    expect(() => CanarySchema.parse(validData)).not.toThrow();
  });

  it('should fail CanaryConfig with invalid percentage', () => {
    const invalidData = {
      trafficPercentage: 150, // > 100
      targetVersionId: 'clx0000000000000000000001',
      stableVersionId: 'clx0000000000000000000002',
    };
    expect(() => CanarySchema.parse(invalidData)).toThrow();
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
