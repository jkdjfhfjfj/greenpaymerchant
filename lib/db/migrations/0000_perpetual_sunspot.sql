CREATE TABLE "greenpay_transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"reference" varchar(100) NOT NULL,
	"provider" varchar(24) NOT NULL,
	"provider_reference" varchar(200),
	"amount" numeric(18, 2) NOT NULL,
	"fee" numeric(18, 2),
	"net_amount" numeric(18, 2),
	"platform_fee" numeric(18, 2) DEFAULT 0 NOT NULL,
	"platform_net_amount" numeric(18, 2),
	"platform_fee_percent" numeric(8, 4) DEFAULT 0 NOT NULL,
	"platform_flat_fee" numeric(18, 2) DEFAULT 0 NOT NULL,
	"platform_fee_currency" varchar(3),
	"platform_fee_schedule_id" integer,
	"currency" varchar(3) NOT NULL,
	"status" varchar(24) DEFAULT 'pending' NOT NULL,
	"payment_method" text,
	"customer_email" text NOT NULL,
	"customer_name" text,
	"customer_phone" text,
	"description" text,
	"failure_reason" text,
	"payment_url" text,
	"payment_link_id" integer,
	"merchant_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	"settlement_at" timestamp with time zone,
	"settlement_status" varchar(24) DEFAULT 'not_applicable' NOT NULL,
	CONSTRAINT "greenpay_transactions_reference_unique" UNIQUE("reference")
);
--> statement-breakpoint
CREATE TABLE "greenpay_payment_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" varchar(80) NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"amount_type" varchar(24) NOT NULL,
	"amount" numeric(18, 2),
	"currency" varchar(3) NOT NULL,
	"status" varchar(24) DEFAULT 'active' NOT NULL,
	"merchant_id" integer,
	"recovery_for_transaction_id" integer,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "greenpay_payment_links_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "greenpay_payouts" (
	"id" serial PRIMARY KEY NOT NULL,
	"merchant_id" integer,
	"reference" varchar(100) NOT NULL,
	"provider" varchar(24) NOT NULL,
	"provider_reference" varchar(200),
	"amount" numeric(18, 2) NOT NULL,
	"fee" numeric(18, 2),
	"net_amount" numeric(18, 2),
	"currency" varchar(3) NOT NULL,
	"method" text NOT NULL,
	"account_name" text NOT NULL,
	"masked_account" varchar(80) NOT NULL,
	"status" varchar(24) DEFAULT 'pending' NOT NULL,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "greenpay_payouts_reference_unique" UNIQUE("reference")
);
--> statement-breakpoint
CREATE TABLE "greenpay_settlements" (
	"id" serial PRIMARY KEY NOT NULL,
	"reference" varchar(100) NOT NULL,
	"provider" varchar(24) NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"net_amount" numeric(18, 2) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"status" varchar(24) DEFAULT 'pending' NOT NULL,
	"expected_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	"payout_method" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "greenpay_settlements_reference_unique" UNIQUE("reference")
);
--> statement-breakpoint
CREATE TABLE "greenpay_refunds" (
	"id" serial PRIMARY KEY NOT NULL,
	"reference" varchar(100) NOT NULL,
	"original_reference" varchar(100) NOT NULL,
	"provider_reference" varchar(200),
	"provider" varchar(24),
	"amount" numeric(18, 2) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"status" varchar(24) NOT NULL,
	"reason" text,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "greenpay_refunds_reference_unique" UNIQUE("reference")
);
--> statement-breakpoint
CREATE TABLE "greenpay_webhook_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"delivery_key" varchar(128) NOT NULL,
	"provider" varchar(24) NOT NULL,
	"event" varchar(120) NOT NULL,
	"reference" varchar(100),
	"status" varchar(24) NOT NULL,
	"http_status" integer,
	"attempts" integer DEFAULT 1 NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	CONSTRAINT "greenpay_webhook_events_delivery_key_unique" UNIQUE("delivery_key")
);
--> statement-breakpoint
CREATE TABLE "greenpay_admin_audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"actor" varchar(128) NOT NULL,
	"action" varchar(100) NOT NULL,
	"target" varchar(200) NOT NULL,
	"details" text,
	"method" varchar(10),
	"route" varchar(250),
	"status_code" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "greenpay_collection_currency_availability" (
	"currency" varchar(3) PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" varchar(128) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "greenpay_developer_idempotency" (
	"id" serial PRIMARY KEY NOT NULL,
	"merchant_id" integer NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"status" varchar(20) DEFAULT 'in_flight' NOT NULL,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "greenpay_fee_schedules" (
	"id" serial PRIMARY KEY NOT NULL,
	"merchant_id" integer,
	"percentage" numeric(8, 4) NOT NULL,
	"flat_amount" numeric(18, 2) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"fx_markup_bps" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "greenpay_fx_rates" (
	"id" serial PRIMARY KEY NOT NULL,
	"from_currency" varchar(3) NOT NULL,
	"to_currency" varchar(3) NOT NULL,
	"rate" numeric(20, 10) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"source" varchar(150) NOT NULL,
	"effective_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "greenpay_merchant_api_keys" (
	"id" serial PRIMARY KEY NOT NULL,
	"merchant_id" integer NOT NULL,
	"name" varchar(100) NOT NULL,
	"prefix" varchar(20) NOT NULL,
	"secret_hash" varchar(64) NOT NULL,
	"scopes" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "greenpay_merchant_api_keys_secret_hash_unique" UNIQUE("secret_hash")
);
--> statement-breakpoint
CREATE TABLE "greenpay_merchant_webhook_endpoints" (
	"id" serial PRIMARY KEY NOT NULL,
	"merchant_id" integer NOT NULL,
	"url" text NOT NULL,
	"events" jsonb NOT NULL,
	"encrypted_secret" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "greenpay_merchant_webhook_outbox" (
	"id" serial PRIMARY KEY NOT NULL,
	"transaction_id" integer NOT NULL,
	"merchant_id" integer NOT NULL,
	"endpoint_id" integer NOT NULL,
	"event" varchar(100) NOT NULL,
	"delivery_id" varchar(250) NOT NULL,
	"destination_url" text NOT NULL,
	"encrypted_secret" text NOT NULL,
	"payload" text NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"last_status_code" integer,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "greenpay_merchants" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_clerk_id" varchar(128) NOT NULL,
	"business_name" varchar(150) NOT NULL,
	"shop_name" varchar(100),
	"shop_logo_url" text,
	"country" varchar(2) NOT NULL,
	"base_currency" varchar(3) NOT NULL,
	"registration_number" varchar(150),
	"application_details" jsonb,
	"application_status" varchar(32) DEFAULT 'not_submitted' NOT NULL,
	"application_requested_info" text,
	"application_submitted_at" timestamp with time zone,
	"application_reviewed_at" timestamp with time zone,
	"application_reviewed_by" varchar(128),
	"status" varchar(24) DEFAULT 'pending' NOT NULL,
	"payments_enabled" boolean DEFAULT true NOT NULL,
	"api_access_enabled" boolean DEFAULT true NOT NULL,
	"payouts_enabled" boolean DEFAULT true NOT NULL,
	"refunds_enabled" boolean DEFAULT true NOT NULL,
	"merchant_action_controls" jsonb,
	"payout_safety_settings" jsonb,
	"kyc_status" varchar(24) DEFAULT 'not_started' NOT NULL,
	"didit_session_id" varchar(200),
	"didit_session_url" text,
	"didit_kind" varchar(8),
	"kyb_status" varchar(24) DEFAULT 'not_started' NOT NULL,
	"didit_kyb_session_id" varchar(200),
	"didit_kyb_session_url" text,
	"risk_note" varchar(1000),
	"verification_updated_at" timestamp with time zone,
	"kyb_verification_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "greenpay_payout_idempotency" (
	"id" serial PRIMARY KEY NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"payout_id" integer,
	"status" varchar(20) DEFAULT 'in_flight' NOT NULL,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "greenpay_payout_idempotency_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "greenpay_platform_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"new_merchant_signups" boolean DEFAULT true NOT NULL,
	"payments_enabled" boolean DEFAULT true NOT NULL,
	"payouts_enabled" boolean DEFAULT true NOT NULL,
	"refunds_enabled" boolean DEFAULT true NOT NULL,
	"api_access_enabled" boolean DEFAULT true NOT NULL,
	"kyc_required" boolean DEFAULT true NOT NULL,
	"platform_name" varchar(100) DEFAULT 'Greenpay' NOT NULL,
	"base_currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"contact_email" varchar(254) DEFAULT 'support@greenpay.africa' NOT NULL,
	"contact_phone" varchar(40) DEFAULT '' NOT NULL,
	"contact_address" varchar(250) DEFAULT '' NOT NULL,
	"contact_whatsapp" varchar(100) DEFAULT '' NOT NULL,
	"logo_url" text,
	"favicon_url" text,
	"wallet_fx_currency_spreads" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "greenpay_provider_credentials" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider" varchar(24) NOT NULL,
	"encrypted_credentials" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "greenpay_provider_credentials_provider_unique" UNIQUE("provider")
);
--> statement-breakpoint
CREATE TABLE "greenpay_merchant_wallets" (
	"id" serial PRIMARY KEY NOT NULL,
	"merchant_id" integer NOT NULL,
	"currency" varchar(3) NOT NULL,
	"available_minor" bigint DEFAULT 0 NOT NULL,
	"reserved_minor" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "greenpay_wallet_conversions" (
	"id" serial PRIMARY KEY NOT NULL,
	"merchant_id" integer NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"from_currency" varchar(3) NOT NULL,
	"to_currency" varchar(3) NOT NULL,
	"source_minor" bigint NOT NULL,
	"target_minor" bigint NOT NULL,
	"fee_minor" bigint NOT NULL,
	"source_rate" numeric(24, 12) NOT NULL,
	"effective_rate" numeric(24, 12) NOT NULL,
	"markup_bps" integer NOT NULL,
	"currency_spread_bps" integer DEFAULT 0 NOT NULL,
	"fee_schedule_id" integer,
	"rate_source" varchar(160) NOT NULL,
	"rate_source_date" varchar(10) NOT NULL,
	"rate_fetched_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "greenpay_wallet_fx_rates" (
	"id" serial PRIMARY KEY NOT NULL,
	"from_currency" varchar(3) NOT NULL,
	"to_currency" varchar(3) NOT NULL,
	"rate" numeric(24, 12) NOT NULL,
	"source" varchar(160) NOT NULL,
	"source_date" varchar(10) NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "greenpay_wallet_journal_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"journal_id" integer NOT NULL,
	"merchant_id" integer,
	"currency" varchar(3) NOT NULL,
	"account" varchar(32) NOT NULL,
	"direction" varchar(6) NOT NULL,
	"amount_minor" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "greenpay_wallet_journals" (
	"id" serial PRIMARY KEY NOT NULL,
	"merchant_id" integer NOT NULL,
	"currency" varchar(3) NOT NULL,
	"kind" varchar(40) NOT NULL,
	"reference" varchar(200) NOT NULL,
	"source_reference" varchar(200),
	"evidence_reference" varchar(200),
	"idempotency_key" varchar(200) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "greenpay_wallet_journals_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "greenpay_wallet_payout_destination_change_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"merchant_id" integer NOT NULL,
	"destination_id" integer,
	"expected_version_id" integer,
	"idempotency_key" varchar(128) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"proposed_label" varchar(120) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"method" varchar(120) NOT NULL,
	"account_name" varchar(200) NOT NULL,
	"masked_account" varchar(80) NOT NULL,
	"encrypted_destination" text NOT NULL,
	"destination_fingerprint" varchar(64) NOT NULL,
	"requested_by" varchar(128) NOT NULL,
	"status" varchar(24) DEFAULT 'requested' NOT NULL,
	"first_approved_by" varchar(128),
	"first_approved_at" timestamp with time zone,
	"second_approved_by" varchar(128),
	"second_approved_at" timestamp with time zone,
	"rejected_by" varchar(128),
	"rejected_at" timestamp with time zone,
	"approved_version_id" integer,
	"decision_reason" varchar(400),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "greenpay_wallet_payout_destination_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"destination_id" integer NOT NULL,
	"version" integer NOT NULL,
	"label" varchar(120) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"method" varchar(120) NOT NULL,
	"account_name" varchar(200) NOT NULL,
	"masked_account" varchar(80) NOT NULL,
	"encrypted_destination" text NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"approved_by" varchar(128) NOT NULL,
	"approved_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "greenpay_wallet_payout_destinations" (
	"id" serial PRIMARY KEY NOT NULL,
	"merchant_id" integer NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"current_version_id" integer,
	"created_by" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "greenpay_wallet_payout_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"merchant_id" integer NOT NULL,
	"reference" varchar(100) NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"amount_minor" bigint NOT NULL,
	"fee_minor" bigint NOT NULL,
	"hold_minor" bigint NOT NULL,
	"destination_id" integer,
	"destination_version_id" integer,
	"destination_version" integer,
	"destination_fingerprint" varchar(64),
	"requested_by" varchar(128),
	"requires_second_approval" boolean DEFAULT false NOT NULL,
	"threshold_minor" bigint,
	"threshold_configured" boolean DEFAULT false NOT NULL,
	"first_approved_by" varchar(128),
	"first_approved_at" timestamp with time zone,
	"second_approved_by" varchar(128),
	"second_approved_at" timestamp with time zone,
	"rejected_by" varchar(128),
	"rejected_at" timestamp with time zone,
	"currency" varchar(3) NOT NULL,
	"method" varchar(120) NOT NULL,
	"account_name" varchar(200) NOT NULL,
	"masked_account" varchar(80) NOT NULL,
	"encrypted_destination" text NOT NULL,
	"status" varchar(24) DEFAULT 'requested' NOT NULL,
	"provider" varchar(24) NOT NULL,
	"provider_reference" varchar(200),
	"reservation_journal_id" integer NOT NULL,
	"decision_reason" varchar(400),
	"approved_by" varchar(128),
	"submitted_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "greenpay_wallet_payout_requests_reference_unique" UNIQUE("reference")
);
--> statement-breakpoint
CREATE TABLE "greenpay_wallet_refund_adjustments" (
	"id" serial PRIMARY KEY NOT NULL,
	"refund_reference" varchar(120) NOT NULL,
	"transaction_reference" varchar(100) NOT NULL,
	"merchant_id" integer NOT NULL,
	"currency" varchar(3) NOT NULL,
	"amount_minor" bigint NOT NULL,
	"status" varchar(16) DEFAULT 'reserved' NOT NULL,
	"reserve_journal_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "greenpay_wallet_refund_adjustments_refund_reference_unique" UNIQUE("refund_reference")
);
--> statement-breakpoint
CREATE TABLE "greenpay_wallet_settlement_confirmations" (
	"id" serial PRIMARY KEY NOT NULL,
	"settlement_reference" varchar(200) NOT NULL,
	"merchant_id" integer NOT NULL,
	"currency" varchar(3) NOT NULL,
	"funded_minor" bigint NOT NULL,
	"evidence_reference" varchar(200) NOT NULL,
	"journal_id" integer NOT NULL,
	"confirmed_by" varchar(128) NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "greenpay_wallet_settlement_confirmations_settlement_reference_unique" UNIQUE("settlement_reference"),
	CONSTRAINT "greenpay_wallet_settlement_confirmations_evidence_reference_unique" UNIQUE("evidence_reference")
);
--> statement-breakpoint
CREATE TABLE "greenpay_case_attachments" (
	"id" serial PRIMARY KEY NOT NULL,
	"merchant_id" integer NOT NULL,
	"case_id" integer NOT NULL,
	"message_id" varchar(36) NOT NULL,
	"object_path" text NOT NULL,
	"name" varchar(180) NOT NULL,
	"content_type" varchar(40) NOT NULL,
	"size" integer NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "greenpay_case_refunds" (
	"id" serial PRIMARY KEY NOT NULL,
	"merchant_id" integer NOT NULL,
	"case_id" integer NOT NULL,
	"transaction_reference" varchar(100) NOT NULL,
	"refund_id" integer NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"provider_reference" varchar(200) NOT NULL,
	"evidence_reference" varchar(200) NOT NULL,
	"created_by" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "greenpay_case_upload_intents" (
	"id" serial PRIMARY KEY NOT NULL,
	"token" varchar(64) NOT NULL,
	"merchant_id" integer NOT NULL,
	"case_id" integer NOT NULL,
	"object_path" text NOT NULL,
	"name" varchar(180) NOT NULL,
	"content_type" varchar(40) NOT NULL,
	"size" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "greenpay_case_upload_intents_token_unique" UNIQUE("token"),
	CONSTRAINT "greenpay_case_upload_intents_object_path_unique" UNIQUE("object_path")
);
--> statement-breakpoint
CREATE TABLE "greenpay_merchant_invoice_reminders" (
	"id" serial PRIMARY KEY NOT NULL,
	"merchant_id" integer NOT NULL,
	"invoice_id" integer NOT NULL,
	"delivery_status" varchar(24) DEFAULT 'unconfigured' NOT NULL,
	"message" text NOT NULL,
	"scheduled_at" timestamp with time zone,
	"event_key" varchar(200),
	"delivery_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "greenpay_merchant_invoices" (
	"id" serial PRIMARY KEY NOT NULL,
	"merchant_id" integer NOT NULL,
	"reference" varchar(80) NOT NULL,
	"customer_name" varchar(150) NOT NULL,
	"customer_email" varchar(254) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"due_date" date NOT NULL,
	"lines" jsonb NOT NULL,
	"subtotal" numeric(18, 2) NOT NULL,
	"total" numeric(18, 2) NOT NULL,
	"paid_amount" numeric(18, 2) DEFAULT 0 NOT NULL,
	"payment_link_amount" numeric(18, 2),
	"status" varchar(24) DEFAULT 'draft' NOT NULL,
	"note" text,
	"payment_link_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "greenpay_merchant_invoices_reference_unique" UNIQUE("reference")
);
--> statement-breakpoint
CREATE TABLE "greenpay_merchant_payment_link_reminders" (
	"id" serial PRIMARY KEY NOT NULL,
	"merchant_id" integer NOT NULL,
	"payment_link_id" integer NOT NULL,
	"recipient_email" varchar(254) NOT NULL,
	"delivery_status" varchar(24) DEFAULT 'unconfigured' NOT NULL,
	"message" text NOT NULL,
	"scheduled_at" timestamp with time zone,
	"event_key" varchar(200) NOT NULL,
	"delivery_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempted_at" timestamp with time zone,
	CONSTRAINT "greenpay_merchant_payment_link_reminders_event_key_unique" UNIQUE("event_key")
);
--> statement-breakpoint
CREATE TABLE "greenpay_merchant_support_cases" (
	"id" serial PRIMARY KEY NOT NULL,
	"merchant_id" integer NOT NULL,
	"kind" varchar(16) NOT NULL,
	"transaction_reference" varchar(100) NOT NULL,
	"status" varchar(24) DEFAULT 'requested' NOT NULL,
	"financial_movement" varchar(24) DEFAULT 'requested' NOT NULL,
	"messages" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "greenpay_verification_tier_limits" (
	"id" serial PRIMARY KEY NOT NULL,
	"tier" varchar(16) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"collection_per_transaction_limit" numeric(20, 2),
	"collection_daily_limit" numeric(20, 2),
	"collection_monthly_limit" numeric(20, 2),
	"payout_limit" numeric(20, 2),
	"conversion_limit" numeric(20, 2),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "greenpay_verification_usage_reservations" (
	"id" serial PRIMARY KEY NOT NULL,
	"merchant_id" integer NOT NULL,
	"transaction_id" integer,
	"action" varchar(16) NOT NULL,
	"amount" numeric(20, 2) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"status" varchar(16) DEFAULT 'reserved' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "greenpay_email_delivery_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"from_email" varchar(254),
	"sender_verified_at" timestamp with time zone,
	"sender_verified_by" varchar(128),
	"updated_by" varchar(128),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "greenpay_financial_notification_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_key" varchar(240) NOT NULL,
	"event_type" varchar(32) NOT NULL,
	"transaction_id" integer,
	"payout_id" integer,
	"wallet_payout_request_id" integer,
	"reference" varchar(100) NOT NULL,
	"previous_status" varchar(32),
	"status" varchar(32) NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"delivery_state" varchar(24) DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"lease_owner" varchar(128),
	"lease_until" timestamp with time zone,
	"last_error" text,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "greenpay_merchant_business_contacts" (
	"id" serial PRIMARY KEY NOT NULL,
	"merchant_id" integer NOT NULL,
	"contact_name" varchar(120),
	"email" varchar(254),
	"phone" varchar(40),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "greenpay_merchant_business_contacts_merchant_id_unique" UNIQUE("merchant_id")
);
--> statement-breakpoint
CREATE TABLE "greenpay_support_delivery_outbox" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_key" varchar(200) NOT NULL,
	"ticket_id" integer NOT NULL,
	"recipient_email" varchar(254) NOT NULL,
	"purpose" varchar(32) NOT NULL,
	"delivery_state" varchar(32) DEFAULT 'unconfigured' NOT NULL,
	"payload" jsonb NOT NULL,
	"reviewed_by" varchar(128),
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "greenpay_support_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticket_id" integer NOT NULL,
	"author_role" varchar(16) NOT NULL,
	"author_clerk_id" varchar(128),
	"author_name" varchar(120) NOT NULL,
	"body" text NOT NULL,
	"email_delivery_state" varchar(24) DEFAULT 'unconfigured' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "greenpay_support_tickets" (
	"id" serial PRIMARY KEY NOT NULL,
	"reference" varchar(40) NOT NULL,
	"owner_clerk_id" varchar(128),
	"requester_name" varchar(120) NOT NULL,
	"requester_email" varchar(254) NOT NULL,
	"subject" varchar(180) NOT NULL,
	"category" varchar(32) DEFAULT 'other' NOT NULL,
	"status" varchar(24) DEFAULT 'open' NOT NULL,
	"email_delivery_state" varchar(24) DEFAULT 'unconfigured' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "greenpay_support_tickets_reference_unique" UNIQUE("reference")
);
--> statement-breakpoint
CREATE TABLE "greenpay_transactional_email_outbox" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_key" varchar(240) NOT NULL,
	"purpose" varchar(32) NOT NULL,
	"recipient_email" varchar(254) NOT NULL,
	"template" varchar(40) NOT NULL,
	"subject" varchar(200) NOT NULL,
	"payload" jsonb NOT NULL,
	"delivery_state" varchar(24) DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"retryable" boolean DEFAULT true NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"lease_owner" varchar(128),
	"lease_until" timestamp with time zone,
	"last_error" text,
	"provider_message_id" varchar(200),
	"reviewed_by" varchar(128),
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "greenpay_user_notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" varchar(128) NOT NULL,
	"event_key" varchar(240) NOT NULL,
	"type" varchar(32) NOT NULL,
	"title" varchar(180) NOT NULL,
	"body" varchar(500) NOT NULL,
	"href" varchar(300) NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "greenpay_merchant_team_invitations" (
	"id" serial PRIMARY KEY NOT NULL,
	"merchant_id" integer NOT NULL,
	"email" varchar(254) NOT NULL,
	"role" varchar(16) NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"created_by_clerk_id" varchar(128) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "greenpay_merchant_team_invitations_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "greenpay_merchant_team_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"merchant_id" integer NOT NULL,
	"clerk_user_id" varchar(128) NOT NULL,
	"email" varchar(254) NOT NULL,
	"role" varchar(16) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "greenpay_public_content" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" varchar(16) NOT NULL,
	"status" varchar(16) DEFAULT 'draft' NOT NULL,
	"title" varchar(160) NOT NULL,
	"slug" varchar(120) NOT NULL,
	"summary" varchar(300) NOT NULL,
	"body" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" varchar(128),
	"updated_by" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "greenpay_public_content_kind_check" CHECK ("greenpay_public_content"."kind" in ('guide', 'article', 'faq')),
	CONSTRAINT "greenpay_public_content_status_check" CHECK ("greenpay_public_content"."status" in ('draft', 'published')),
	CONSTRAINT "greenpay_public_content_published_at_check" CHECK (("greenpay_public_content"."status" = 'draft' and "greenpay_public_content"."published_at" is null) or ("greenpay_public_content"."status" = 'published' and "greenpay_public_content"."published_at" is not null)),
	CONSTRAINT "greenpay_public_content_slug_check" CHECK ("greenpay_public_content"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
--> statement-breakpoint
CREATE TABLE "greenpay_public_content_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"content_id" integer NOT NULL,
	"version" integer NOT NULL,
	"kind" varchar(16) NOT NULL,
	"status" varchar(16) NOT NULL,
	"title" varchar(160) NOT NULL,
	"slug" varchar(120) NOT NULL,
	"summary" varchar(300) NOT NULL,
	"body" text NOT NULL,
	"created_by" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "greenpay_platform_admin_assignments" (
	"clerk_user_id" varchar(128) PRIMARY KEY NOT NULL,
	"verified_email_snapshot" varchar(254) NOT NULL,
	"assigned_by_clerk_user_id" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "greenpay_clerk_identity_links" (
	"external_clerk_user_id" varchar(128) PRIMARY KEY NOT NULL,
	"legacy_clerk_user_id" varchar(128),
	"resolution" varchar(16) NOT NULL,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "greenpay_legal_policies" (
	"policy_type" varchar(24) PRIMARY KEY NOT NULL,
	"slug" varchar(40) NOT NULL,
	"draft_title" varchar(160) NOT NULL,
	"draft_content" text DEFAULT '' NOT NULL,
	"published_title" varchar(160),
	"published_content" text,
	"published_version" integer DEFAULT 0 NOT NULL,
	"draft_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"updated_by" varchar(128),
	CONSTRAINT "greenpay_legal_policies_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "greenpay_legal_policy_acceptances" (
	"id" serial PRIMARY KEY NOT NULL,
	"clerk_user_id" varchar(128) NOT NULL,
	"policy_type" varchar(24) NOT NULL,
	"version" integer NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "greenpay_legal_policy_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"policy_type" varchar(24) NOT NULL,
	"version" integer NOT NULL,
	"title" varchar(160) NOT NULL,
	"content" text NOT NULL,
	"published_by" varchar(128) NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "greenpay_wallet_journal_entries" ADD CONSTRAINT "greenpay_wallet_journal_entries_journal_id_greenpay_wallet_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."greenpay_wallet_journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "greenpay_wallet_payout_destination_change_requests" ADD CONSTRAINT "greenpay_wallet_payout_destination_change_requests_destination_id_greenpay_wallet_payout_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."greenpay_wallet_payout_destinations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "greenpay_wallet_payout_destination_change_requests" ADD CONSTRAINT "greenpay_wallet_payout_destination_change_requests_approved_version_id_greenpay_wallet_payout_destination_versions_id_fk" FOREIGN KEY ("approved_version_id") REFERENCES "public"."greenpay_wallet_payout_destination_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "greenpay_wallet_payout_destination_versions" ADD CONSTRAINT "greenpay_wallet_payout_destination_versions_destination_id_greenpay_wallet_payout_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."greenpay_wallet_payout_destinations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "greenpay_wallet_payout_requests" ADD CONSTRAINT "greenpay_wallet_payout_requests_reservation_journal_id_greenpay_wallet_journals_id_fk" FOREIGN KEY ("reservation_journal_id") REFERENCES "public"."greenpay_wallet_journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "greenpay_wallet_refund_adjustments" ADD CONSTRAINT "greenpay_wallet_refund_adjustments_reserve_journal_id_greenpay_wallet_journals_id_fk" FOREIGN KEY ("reserve_journal_id") REFERENCES "public"."greenpay_wallet_journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "greenpay_wallet_settlement_confirmations" ADD CONSTRAINT "greenpay_wallet_settlement_confirmations_journal_id_greenpay_wallet_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."greenpay_wallet_journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "greenpay_transactions_created_at_idx" ON "greenpay_transactions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "greenpay_transactions_status_idx" ON "greenpay_transactions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "greenpay_transactions_currency_idx" ON "greenpay_transactions" USING btree ("currency");--> statement-breakpoint
CREATE INDEX "greenpay_transactions_customer_email_idx" ON "greenpay_transactions" USING btree ("customer_email");--> statement-breakpoint
CREATE INDEX "greenpay_transactions_merchant_id_idx" ON "greenpay_transactions" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "greenpay_payment_links_status_idx" ON "greenpay_payment_links" USING btree ("status");--> statement-breakpoint
CREATE INDEX "greenpay_payment_links_created_at_idx" ON "greenpay_payment_links" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "greenpay_payment_links_merchant_id_idx" ON "greenpay_payment_links" USING btree ("merchant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "greenpay_payment_links_recovery_transaction_unique_idx" ON "greenpay_payment_links" USING btree ("recovery_for_transaction_id");--> statement-breakpoint
CREATE INDEX "greenpay_payouts_status_idx" ON "greenpay_payouts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "greenpay_payouts_merchant_id_idx" ON "greenpay_payouts" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "greenpay_payouts_currency_idx" ON "greenpay_payouts" USING btree ("currency");--> statement-breakpoint
CREATE INDEX "greenpay_payouts_created_at_idx" ON "greenpay_payouts" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "greenpay_payouts_confirmed_at_idx" ON "greenpay_payouts" USING btree ("confirmed_at");--> statement-breakpoint
CREATE INDEX "greenpay_settlements_status_idx" ON "greenpay_settlements" USING btree ("status");--> statement-breakpoint
CREATE INDEX "greenpay_settlements_currency_idx" ON "greenpay_settlements" USING btree ("currency");--> statement-breakpoint
CREATE INDEX "greenpay_settlements_expected_at_idx" ON "greenpay_settlements" USING btree ("expected_at");--> statement-breakpoint
CREATE INDEX "greenpay_refunds_original_reference_idx" ON "greenpay_refunds" USING btree ("original_reference");--> statement-breakpoint
CREATE INDEX "greenpay_refunds_created_at_idx" ON "greenpay_refunds" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "greenpay_refunds_confirmed_at_idx" ON "greenpay_refunds" USING btree ("confirmed_at");--> statement-breakpoint
CREATE INDEX "greenpay_webhook_events_provider_idx" ON "greenpay_webhook_events" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "greenpay_webhook_events_status_idx" ON "greenpay_webhook_events" USING btree ("status");--> statement-breakpoint
CREATE INDEX "greenpay_webhook_events_received_at_idx" ON "greenpay_webhook_events" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "greenpay_admin_audit_log_created_at_idx" ON "greenpay_admin_audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "greenpay_admin_audit_log_actor_idx" ON "greenpay_admin_audit_log" USING btree ("actor");--> statement-breakpoint
CREATE INDEX "greenpay_admin_audit_log_action_idx" ON "greenpay_admin_audit_log" USING btree ("action");--> statement-breakpoint
CREATE UNIQUE INDEX "greenpay_developer_idempotency_merchant_key_idx" ON "greenpay_developer_idempotency" USING btree ("merchant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "greenpay_developer_idempotency_status_idx" ON "greenpay_developer_idempotency" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "greenpay_fee_schedules_merchant_unique_idx" ON "greenpay_fee_schedules" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "greenpay_fx_rates_pair_idx" ON "greenpay_fx_rates" USING btree ("from_currency","to_currency");--> statement-breakpoint
CREATE INDEX "greenpay_fx_rates_active_idx" ON "greenpay_fx_rates" USING btree ("active");--> statement-breakpoint
CREATE INDEX "greenpay_api_keys_merchant_id_idx" ON "greenpay_merchant_api_keys" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "greenpay_api_keys_active_idx" ON "greenpay_merchant_api_keys" USING btree ("revoked_at");--> statement-breakpoint
CREATE INDEX "greenpay_webhook_endpoints_merchant_id_idx" ON "greenpay_merchant_webhook_endpoints" USING btree ("merchant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "greenpay_merchant_webhook_outbox_delivery_idx" ON "greenpay_merchant_webhook_outbox" USING btree ("transaction_id","endpoint_id","event");--> statement-breakpoint
CREATE INDEX "greenpay_merchant_webhook_outbox_status_idx" ON "greenpay_merchant_webhook_outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "greenpay_merchants_owner_idx" ON "greenpay_merchants" USING btree ("owner_clerk_id");--> statement-breakpoint
CREATE INDEX "greenpay_merchants_status_idx" ON "greenpay_merchants" USING btree ("status");--> statement-breakpoint
CREATE INDEX "greenpay_merchants_application_status_idx" ON "greenpay_merchants" USING btree ("application_status");--> statement-breakpoint
CREATE INDEX "greenpay_merchants_kyc_status_idx" ON "greenpay_merchants" USING btree ("kyc_status");--> statement-breakpoint
CREATE INDEX "greenpay_merchants_kyb_status_idx" ON "greenpay_merchants" USING btree ("kyb_status");--> statement-breakpoint
CREATE INDEX "greenpay_payout_idempotency_status_idx" ON "greenpay_payout_idempotency" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "greenpay_merchant_wallet_currency_unique_idx" ON "greenpay_merchant_wallets" USING btree ("merchant_id","currency");--> statement-breakpoint
CREATE INDEX "greenpay_merchant_wallet_currency_idx" ON "greenpay_merchant_wallets" USING btree ("currency");--> statement-breakpoint
CREATE UNIQUE INDEX "greenpay_wallet_conversions_merchant_key_unique_idx" ON "greenpay_wallet_conversions" USING btree ("merchant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "greenpay_wallet_conversions_merchant_created_idx" ON "greenpay_wallet_conversions" USING btree ("merchant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "greenpay_wallet_fx_rates_pair_source_date_unique_idx" ON "greenpay_wallet_fx_rates" USING btree ("from_currency","to_currency","source_date");--> statement-breakpoint
CREATE INDEX "greenpay_wallet_fx_rates_pair_fetched_idx" ON "greenpay_wallet_fx_rates" USING btree ("from_currency","to_currency","fetched_at");--> statement-breakpoint
CREATE INDEX "greenpay_wallet_entries_journal_idx" ON "greenpay_wallet_journal_entries" USING btree ("journal_id");--> statement-breakpoint
CREATE INDEX "greenpay_wallet_entries_merchant_idx" ON "greenpay_wallet_journal_entries" USING btree ("merchant_id","currency");--> statement-breakpoint
CREATE INDEX "greenpay_wallet_journals_merchant_created_idx" ON "greenpay_wallet_journals" USING btree ("merchant_id","created_at");--> statement-breakpoint
CREATE INDEX "greenpay_wallet_journals_source_reference_idx" ON "greenpay_wallet_journals" USING btree ("source_reference");--> statement-breakpoint
CREATE UNIQUE INDEX "greenpay_wallet_destination_change_merchant_key_unique_idx" ON "greenpay_wallet_payout_destination_change_requests" USING btree ("merchant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "greenpay_wallet_destination_change_status_created_idx" ON "greenpay_wallet_payout_destination_change_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "greenpay_wallet_destination_change_merchant_created_idx" ON "greenpay_wallet_payout_destination_change_requests" USING btree ("merchant_id","created_at");--> statement-breakpoint
CREATE INDEX "greenpay_wallet_destination_change_fingerprint_idx" ON "greenpay_wallet_payout_destination_change_requests" USING btree ("destination_fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "greenpay_wallet_payout_destination_version_unique_idx" ON "greenpay_wallet_payout_destination_versions" USING btree ("destination_id","version");--> statement-breakpoint
CREATE INDEX "greenpay_wallet_payout_destination_versions_approved_idx" ON "greenpay_wallet_payout_destination_versions" USING btree ("approved_at");--> statement-breakpoint
CREATE INDEX "greenpay_wallet_payout_destinations_merchant_idx" ON "greenpay_wallet_payout_destinations" USING btree ("merchant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "greenpay_wallet_payout_merchant_key_unique_idx" ON "greenpay_wallet_payout_requests" USING btree ("merchant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "greenpay_wallet_payout_status_created_idx" ON "greenpay_wallet_payout_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "greenpay_wallet_payout_merchant_created_idx" ON "greenpay_wallet_payout_requests" USING btree ("merchant_id","created_at");--> statement-breakpoint
CREATE INDEX "greenpay_wallet_payout_provider_ref_idx" ON "greenpay_wallet_payout_requests" USING btree ("provider","provider_reference");--> statement-breakpoint
CREATE INDEX "greenpay_wallet_payout_destination_version_idx" ON "greenpay_wallet_payout_requests" USING btree ("destination_version_id");--> statement-breakpoint
CREATE INDEX "greenpay_wallet_refund_adjustments_transaction_idx" ON "greenpay_wallet_refund_adjustments" USING btree ("transaction_reference");--> statement-breakpoint
CREATE INDEX "greenpay_wallet_refund_adjustments_merchant_idx" ON "greenpay_wallet_refund_adjustments" USING btree ("merchant_id","currency");--> statement-breakpoint
CREATE INDEX "greenpay_wallet_confirmations_merchant_confirmed_idx" ON "greenpay_wallet_settlement_confirmations" USING btree ("merchant_id","confirmed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "greenpay_case_attachments_object_path_unique_idx" ON "greenpay_case_attachments" USING btree ("object_path");--> statement-breakpoint
CREATE INDEX "greenpay_case_attachments_case_created_idx" ON "greenpay_case_attachments" USING btree ("case_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "greenpay_case_refunds_case_key_unique_idx" ON "greenpay_case_refunds" USING btree ("case_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "greenpay_case_refunds_refund_unique_idx" ON "greenpay_case_refunds" USING btree ("refund_id");--> statement-breakpoint
CREATE UNIQUE INDEX "greenpay_case_refunds_provider_reference_unique_idx" ON "greenpay_case_refunds" USING btree ("provider_reference");--> statement-breakpoint
CREATE UNIQUE INDEX "greenpay_case_refunds_evidence_reference_unique_idx" ON "greenpay_case_refunds" USING btree ("evidence_reference");--> statement-breakpoint
CREATE INDEX "greenpay_case_refunds_merchant_case_idx" ON "greenpay_case_refunds" USING btree ("merchant_id","case_id");--> statement-breakpoint
CREATE INDEX "greenpay_case_upload_intents_case_idx" ON "greenpay_case_upload_intents" USING btree ("merchant_id","case_id","expires_at");--> statement-breakpoint
CREATE INDEX "greenpay_invoice_reminders_merchant_invoice_idx" ON "greenpay_merchant_invoice_reminders" USING btree ("merchant_id","invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "greenpay_invoice_reminders_event_key_unique_idx" ON "greenpay_merchant_invoice_reminders" USING btree ("event_key");--> statement-breakpoint
CREATE INDEX "greenpay_merchant_invoices_merchant_idx" ON "greenpay_merchant_invoices" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "greenpay_merchant_invoices_status_idx" ON "greenpay_merchant_invoices" USING btree ("status");--> statement-breakpoint
CREATE INDEX "greenpay_payment_link_reminders_merchant_link_idx" ON "greenpay_merchant_payment_link_reminders" USING btree ("merchant_id","payment_link_id","created_at");--> statement-breakpoint
CREATE INDEX "greenpay_support_cases_merchant_idx" ON "greenpay_merchant_support_cases" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "greenpay_support_cases_status_idx" ON "greenpay_merchant_support_cases" USING btree ("status");--> statement-breakpoint
CREATE INDEX "greenpay_support_cases_reference_idx" ON "greenpay_merchant_support_cases" USING btree ("transaction_reference");--> statement-breakpoint
CREATE UNIQUE INDEX "greenpay_verification_tier_currency_unique_idx" ON "greenpay_verification_tier_limits" USING btree ("tier","currency");--> statement-breakpoint
CREATE INDEX "greenpay_verification_usage_window_idx" ON "greenpay_verification_usage_reservations" USING btree ("merchant_id","action","currency","status","created_at");--> statement-breakpoint
CREATE INDEX "greenpay_verification_usage_transaction_idx" ON "greenpay_verification_usage_reservations" USING btree ("transaction_id","action");--> statement-breakpoint
CREATE UNIQUE INDEX "greenpay_financial_notification_event_key_idx" ON "greenpay_financial_notification_events" USING btree ("event_key");--> statement-breakpoint
CREATE INDEX "greenpay_financial_notification_claim_idx" ON "greenpay_financial_notification_events" USING btree ("delivery_state","next_attempt_at","created_at");--> statement-breakpoint
CREATE INDEX "greenpay_financial_notification_transaction_idx" ON "greenpay_financial_notification_events" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "greenpay_financial_notification_payout_idx" ON "greenpay_financial_notification_events" USING btree ("payout_id");--> statement-breakpoint
CREATE INDEX "greenpay_financial_notification_wallet_payout_idx" ON "greenpay_financial_notification_events" USING btree ("wallet_payout_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "greenpay_support_outbox_event_key_idx" ON "greenpay_support_delivery_outbox" USING btree ("event_key");--> statement-breakpoint
CREATE INDEX "greenpay_support_outbox_ticket_idx" ON "greenpay_support_delivery_outbox" USING btree ("ticket_id","created_at");--> statement-breakpoint
CREATE INDEX "greenpay_support_messages_ticket_idx" ON "greenpay_support_messages" USING btree ("ticket_id","created_at");--> statement-breakpoint
CREATE INDEX "greenpay_support_owner_idx" ON "greenpay_support_tickets" USING btree ("owner_clerk_id","updated_at");--> statement-breakpoint
CREATE INDEX "greenpay_support_status_idx" ON "greenpay_support_tickets" USING btree ("status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "greenpay_transactional_email_event_key_idx" ON "greenpay_transactional_email_outbox" USING btree ("event_key");--> statement-breakpoint
CREATE INDEX "greenpay_transactional_email_claim_idx" ON "greenpay_transactional_email_outbox" USING btree ("delivery_state","next_attempt_at","created_at");--> statement-breakpoint
CREATE INDEX "greenpay_transactional_email_recipient_idx" ON "greenpay_transactional_email_outbox" USING btree ("recipient_email","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "greenpay_user_notifications_event_idx" ON "greenpay_user_notifications" USING btree ("user_id","event_key");--> statement-breakpoint
CREATE INDEX "greenpay_user_notifications_unread_idx" ON "greenpay_user_notifications" USING btree ("user_id","read_at","created_at");--> statement-breakpoint
CREATE INDEX "greenpay_merchant_team_invites_merchant_idx" ON "greenpay_merchant_team_invitations" USING btree ("merchant_id","created_at");--> statement-breakpoint
CREATE INDEX "greenpay_merchant_team_invites_email_idx" ON "greenpay_merchant_team_invitations" USING btree ("email","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "greenpay_merchant_team_member_user_unique_idx" ON "greenpay_merchant_team_members" USING btree ("merchant_id","clerk_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "greenpay_merchant_team_member_active_workspace_idx" ON "greenpay_merchant_team_members" USING btree ("clerk_user_id") WHERE "greenpay_merchant_team_members"."active" = true;--> statement-breakpoint
CREATE INDEX "greenpay_merchant_team_member_access_idx" ON "greenpay_merchant_team_members" USING btree ("clerk_user_id","active");--> statement-breakpoint
CREATE INDEX "greenpay_merchant_team_member_merchant_idx" ON "greenpay_merchant_team_members" USING btree ("merchant_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "greenpay_public_content_slug_unique_idx" ON "greenpay_public_content" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "greenpay_public_content_publication_idx" ON "greenpay_public_content" USING btree ("status","kind","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "greenpay_public_content_version_unique_idx" ON "greenpay_public_content_versions" USING btree ("content_id","version");--> statement-breakpoint
CREATE INDEX "greenpay_public_content_versions_content_idx" ON "greenpay_public_content_versions" USING btree ("content_id","created_at");--> statement-breakpoint
CREATE INDEX "greenpay_platform_admin_assignments_active_idx" ON "greenpay_platform_admin_assignments" USING btree ("revoked_at");--> statement-breakpoint
CREATE INDEX "greenpay_platform_admin_assignments_assigned_by_idx" ON "greenpay_platform_admin_assignments" USING btree ("assigned_by_clerk_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "greenpay_clerk_identity_links_legacy_unique_idx" ON "greenpay_clerk_identity_links" USING btree ("legacy_clerk_user_id");--> statement-breakpoint
CREATE INDEX "greenpay_clerk_identity_links_resolution_idx" ON "greenpay_clerk_identity_links" USING btree ("resolution","resolved_at");--> statement-breakpoint
CREATE UNIQUE INDEX "greenpay_legal_policy_acceptance_unique_idx" ON "greenpay_legal_policy_acceptances" USING btree ("clerk_user_id","policy_type","version");--> statement-breakpoint
CREATE INDEX "greenpay_legal_policy_acceptance_user_idx" ON "greenpay_legal_policy_acceptances" USING btree ("clerk_user_id","accepted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "greenpay_legal_policy_version_unique_idx" ON "greenpay_legal_policy_versions" USING btree ("policy_type","version");--> statement-breakpoint
CREATE INDEX "greenpay_legal_policy_versions_history_idx" ON "greenpay_legal_policy_versions" USING btree ("policy_type","published_at");