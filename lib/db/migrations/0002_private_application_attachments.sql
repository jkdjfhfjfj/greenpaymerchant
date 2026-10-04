CREATE TABLE "greenpay_application_attachments" (
	"id" serial PRIMARY KEY NOT NULL,
	"merchant_id" integer NOT NULL,
	"object_path" text NOT NULL,
	"name" varchar(180) NOT NULL,
	"content_type" varchar(40) NOT NULL,
	"size" integer NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "greenpay_application_upload_intents" (
	"id" serial PRIMARY KEY NOT NULL,
	"token" varchar(64) NOT NULL,
	"merchant_id" integer NOT NULL,
	"object_path" text NOT NULL,
	"name" varchar(180) NOT NULL,
	"content_type" varchar(40) NOT NULL,
	"size" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "greenpay_application_upload_intents_token_unique" UNIQUE("token"),
	CONSTRAINT "greenpay_application_upload_intents_object_path_unique" UNIQUE("object_path")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "greenpay_application_attachments_object_path_unique_idx" ON "greenpay_application_attachments" USING btree ("object_path");--> statement-breakpoint
CREATE INDEX "greenpay_application_attachments_merchant_created_idx" ON "greenpay_application_attachments" USING btree ("merchant_id","created_at");--> statement-breakpoint
CREATE INDEX "greenpay_application_upload_intents_merchant_idx" ON "greenpay_application_upload_intents" USING btree ("merchant_id","expires_at");