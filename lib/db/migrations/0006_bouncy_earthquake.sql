CREATE TABLE "greenpay_airtime_purchases" (
	"id" serial PRIMARY KEY NOT NULL,
	"merchant_id" integer NOT NULL,
	"reference" varchar(100) NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"phone_number" varchar(20) NOT NULL,
	"amount_minor" bigint NOT NULL,
	"charge_minor" bigint,
	"provider_request_id" varchar(128),
	"result_code" integer,
	"result_description" text,
	"status" varchar(24) DEFAULT 'submitting' NOT NULL,
	"last_callback_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "greenpay_airtime_purchases_reference_unique" UNIQUE("reference")
);
--> statement-breakpoint
CREATE TABLE "greenpay_airtime_statum_callbacks" (
	"id" serial PRIMARY KEY NOT NULL,
	"delivery_hash" varchar(64) NOT NULL,
	"provider_request_id" varchar(128) NOT NULL,
	"charge_minor" bigint NOT NULL,
	"account_balance_minor" bigint,
	"result_code" integer NOT NULL,
	"result_description" text NOT NULL,
	"purchase_reference" varchar(100),
	"processed_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "greenpay_airtime_statum_callbacks_delivery_hash_unique" UNIQUE("delivery_hash")
);
--> statement-breakpoint
CREATE TABLE "greenpay_airtime_topups" (
	"id" serial PRIMARY KEY NOT NULL,
	"merchant_id" integer NOT NULL,
	"reference" varchar(100) NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"phone_number" varchar(20) NOT NULL,
	"amount_minor" bigint NOT NULL,
	"provider_reference" varchar(200),
	"status" varchar(24) DEFAULT 'initiating' NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "greenpay_airtime_topups_reference_unique" UNIQUE("reference")
);
--> statement-breakpoint
CREATE TABLE "greenpay_airtime_wallet_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"merchant_id" integer NOT NULL,
	"reference" varchar(100) NOT NULL,
	"kind" varchar(40) NOT NULL,
	"idempotency_key" varchar(200) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"available_delta_minor" bigint NOT NULL,
	"reserved_delta_minor" bigint NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "greenpay_airtime_wallets" (
	"id" serial PRIMARY KEY NOT NULL,
	"merchant_id" integer NOT NULL,
	"available_minor" bigint DEFAULT 0 NOT NULL,
	"reserved_minor" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "greenpay_airtime_purchases_merchant_key_unique_idx" ON "greenpay_airtime_purchases" USING btree ("merchant_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "greenpay_airtime_purchases_provider_request_unique_idx" ON "greenpay_airtime_purchases" USING btree ("provider_request_id");--> statement-breakpoint
CREATE INDEX "greenpay_airtime_purchases_merchant_created_idx" ON "greenpay_airtime_purchases" USING btree ("merchant_id","created_at");--> statement-breakpoint
CREATE INDEX "greenpay_airtime_purchases_status_created_idx" ON "greenpay_airtime_purchases" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "greenpay_airtime_statum_callbacks_request_idx" ON "greenpay_airtime_statum_callbacks" USING btree ("provider_request_id");--> statement-breakpoint
CREATE INDEX "greenpay_airtime_statum_callbacks_pending_idx" ON "greenpay_airtime_statum_callbacks" USING btree ("processed_at","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "greenpay_airtime_topups_merchant_key_unique_idx" ON "greenpay_airtime_topups" USING btree ("merchant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "greenpay_airtime_topups_status_created_idx" ON "greenpay_airtime_topups" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "greenpay_airtime_topups_provider_reference_idx" ON "greenpay_airtime_topups" USING btree ("provider_reference");--> statement-breakpoint
CREATE UNIQUE INDEX "greenpay_airtime_wallet_entry_key_unique_idx" ON "greenpay_airtime_wallet_entries" USING btree ("merchant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "greenpay_airtime_wallet_entries_merchant_created_idx" ON "greenpay_airtime_wallet_entries" USING btree ("merchant_id","created_at");--> statement-breakpoint
CREATE INDEX "greenpay_airtime_wallet_entries_reference_idx" ON "greenpay_airtime_wallet_entries" USING btree ("reference");--> statement-breakpoint
CREATE UNIQUE INDEX "greenpay_airtime_wallet_merchant_unique_idx" ON "greenpay_airtime_wallets" USING btree ("merchant_id");