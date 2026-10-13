-- TAD-09/10, AUD-06 (Phase 9.8): org webhooks, notification channels, audit sinks.
-- CreateTable
CREATE TABLE "OrgWebhookEndpoint" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "events" TEXT[],
    "secret" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "maxRetries" INTEGER NOT NULL DEFAULT 5,
    "backoffCeilingMs" INTEGER NOT NULL DEFAULT 300000,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrgWebhookEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrgWebhookDelivery" (
    "id" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "statusCode" INTEGER,
    "attempt" INTEGER NOT NULL,
    "durationMs" INTEGER,
    "success" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrgWebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrgWebhookDeadLetter" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "finalStatusCode" INTEGER,
    "finalResponseBody" TEXT,
    "totalAttempts" INTEGER NOT NULL,
    "firstAttemptAt" TIMESTAMP(3) NOT NULL,
    "exhaustedAt" TIMESTAMP(3) NOT NULL,
    "retriedAt" TIMESTAMP(3),

    CONSTRAINT "OrgWebhookDeadLetter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationChannel" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "events" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastSentAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditSink" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "config" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "cursorAt" TIMESTAMP(3),
    "cursorId" TEXT,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lastDeliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditSink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditSinkDeadLetter" (
    "id" TEXT NOT NULL,
    "sinkId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "fromAt" TIMESTAMP(3) NOT NULL,
    "fromId" TEXT NOT NULL,
    "toAt" TIMESTAMP(3) NOT NULL,
    "toId" TEXT NOT NULL,
    "events" INTEGER NOT NULL,
    "error" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retriedAt" TIMESTAMP(3),

    CONSTRAINT "AuditSinkDeadLetter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrgWebhookEndpoint_organizationId_idx" ON "OrgWebhookEndpoint"("organizationId");

-- CreateIndex
CREATE INDEX "OrgWebhookDelivery_endpointId_createdAt_idx" ON "OrgWebhookDelivery"("endpointId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "OrgWebhookDelivery_organizationId_idx" ON "OrgWebhookDelivery"("organizationId");

-- CreateIndex
CREATE INDEX "OrgWebhookDeadLetter_organizationId_idx" ON "OrgWebhookDeadLetter"("organizationId");

-- CreateIndex
CREATE INDEX "NotificationChannel_organizationId_idx" ON "NotificationChannel"("organizationId");

-- CreateIndex
CREATE INDEX "AuditSink_organizationId_idx" ON "AuditSink"("organizationId");

-- CreateIndex
CREATE INDEX "AuditSinkDeadLetter_organizationId_idx" ON "AuditSinkDeadLetter"("organizationId");

-- AddForeignKey
ALTER TABLE "OrgWebhookEndpoint" ADD CONSTRAINT "OrgWebhookEndpoint_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgWebhookDelivery" ADD CONSTRAINT "OrgWebhookDelivery_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "OrgWebhookEndpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationChannel" ADD CONSTRAINT "NotificationChannel_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditSink" ADD CONSTRAINT "AuditSink_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditSinkDeadLetter" ADD CONSTRAINT "AuditSinkDeadLetter_sinkId_fkey" FOREIGN KEY ("sinkId") REFERENCES "AuditSink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Organization rows: visible in the organization's scope only.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['OrgWebhookEndpoint', 'OrgWebhookDelivery', 'OrgWebhookDeadLetter',
    'NotificationChannel', 'AuditSink', 'AuditSinkDeadLetter'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY org_isolation ON %I USING ("organizationId" = current_setting(''app.current_org_id'', TRUE)) WITH CHECK ("organizationId" = current_setting(''app.current_org_id'', TRUE))',
      t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO harmoniq_app', t);
  END LOOP;
END $$;
