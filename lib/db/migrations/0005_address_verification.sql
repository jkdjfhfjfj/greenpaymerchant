ALTER TABLE "greenpay_merchants" ADD COLUMN "address_verification_status" varchar(24) DEFAULT 'not_required' NOT NULL;--> statement-breakpoint
ALTER TABLE "greenpay_merchants" ADD COLUMN "address_verification_reason" text;--> statement-breakpoint
ALTER TABLE "greenpay_merchants" ADD COLUMN "address_verification_reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "greenpay_merchants" ADD COLUMN "address_verification_reviewed_by" varchar(128);