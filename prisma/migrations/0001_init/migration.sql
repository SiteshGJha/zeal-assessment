-- CreateTable
CREATE TABLE "case_records" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "priority" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "case_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "case_comments" (
    "id" TEXT NOT NULL,
    "case_id" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "case_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "actor_sub" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "status_code" INTEGER NOT NULL,
    "response_body" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "actor_sub" TEXT NOT NULL,
    "agent_id" TEXT,
    "action" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "scopes" TEXT[],
    "outcome" TEXT NOT NULL,
    "metadata" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_subscriptions" (
    "id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "target_url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_outbox" (
    "id" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMP(3),

    CONSTRAINT "webhook_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_metrics" (
    "account_id" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "protected_tb" DOUBLE PRECISION NOT NULL,
    "api_calls" INTEGER NOT NULL,
    "active_users" INTEGER NOT NULL,

    CONSTRAINT "usage_metrics_pkey" PRIMARY KEY ("account_id","month")
);

-- CreateIndex
CREATE INDEX "case_comments_case_id_created_at_idx" ON "case_comments"("case_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_idempotency_key_method_path_actor_sub_key" ON "idempotency_records"("idempotency_key", "method", "path", "actor_sub");

-- CreateIndex
CREATE INDEX "audit_logs_resource_type_resource_id_created_at_idx" ON "audit_logs"("resource_type", "resource_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_actor_sub_created_at_idx" ON "audit_logs"("actor_sub", "created_at");

-- CreateIndex
CREATE INDEX "webhook_subscriptions_event_type_active_idx" ON "webhook_subscriptions"("event_type", "active");

-- CreateIndex
CREATE INDEX "webhook_outbox_status_next_attempt_at_idx" ON "webhook_outbox"("status", "next_attempt_at");

-- AddForeignKey
ALTER TABLE "case_comments" ADD CONSTRAINT "case_comments_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "case_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_outbox" ADD CONSTRAINT "webhook_outbox_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "webhook_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
