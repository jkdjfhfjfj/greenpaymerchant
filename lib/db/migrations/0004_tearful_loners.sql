ALTER TABLE "greenpay_merchants" ADD COLUMN "application_request_id" varchar(64);--> statement-breakpoint
ALTER TABLE "greenpay_merchants" ADD COLUMN "kyc_requested_info" text;--> statement-breakpoint
ALTER TABLE "greenpay_merchants" ADD COLUMN "kyb_requested_info" text;--> statement-breakpoint
ALTER TABLE "greenpay_application_attachments" ADD COLUMN "request_id" varchar(64);--> statement-breakpoint
ALTER TABLE "greenpay_application_upload_intents" ADD COLUMN "request_id" varchar(64);