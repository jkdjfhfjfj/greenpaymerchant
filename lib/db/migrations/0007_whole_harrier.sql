CREATE TABLE "greenpay_sandbox_transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"reference" varchar(100) NOT NULL,
	"merchant_id" integer NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"payment_method" text,
	"customer_email" text NOT NULL,
	"customer_name" text,
	"customer_phone" text,
	"description" text,
	"status" varchar(24) NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	CONSTRAINT "greenpay_sandbox_transactions_reference_unique" UNIQUE("reference")
);
--> statement-breakpoint
ALTER TABLE "greenpay_merchant_api_keys" ADD COLUMN "environment" varchar(12) DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "greenpay_platform_settings" ADD COLUMN "sandbox_api_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "greenpay_platform_settings" ADD COLUMN "sandbox_default_outcome" varchar(16) DEFAULT 'pending' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "greenpay_sandbox_transactions_merchant_idempotency_idx" ON "greenpay_sandbox_transactions" USING btree ("merchant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "greenpay_sandbox_transactions_merchant_created_idx" ON "greenpay_sandbox_transactions" USING btree ("merchant_id","created_at");--> statement-breakpoint
CREATE INDEX "greenpay_sandbox_transactions_status_idx" ON "greenpay_sandbox_transactions" USING btree ("status");