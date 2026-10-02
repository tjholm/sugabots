CREATE TABLE "sandbox" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"workspace_id" uuid NOT NULL,
	"pod_id" uuid NOT NULL,
	"sandbox_provider_id" uuid NOT NULL,
	"provider_sandbox_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sandbox_provider" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"workspace_id" uuid NOT NULL,
	"preset" text NOT NULL,
	"base_url" text,
	"sandbox_url" text,
	"image" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"api_key_encrypted" text,
	"last_tested_at" timestamp with time zone,
	"last_test_error" text,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_provider_preset_check" CHECK ("preset" in ('opensandbox', 'e2b'))
);
--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "uses_sandbox" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_pod_id_idx" ON "sandbox" ("pod_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_provider_enabled_idx" ON "sandbox_provider" ("workspace_id") WHERE "enabled";--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_provider_id_workspace_id_idx" ON "sandbox_provider" ("id","workspace_id");--> statement-breakpoint
ALTER TABLE "sandbox" ADD CONSTRAINT "sandbox_pod_workspace_fkey" FOREIGN KEY ("pod_id","workspace_id") REFERENCES "pod"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sandbox" ADD CONSTRAINT "sandbox_provider_workspace_fkey" FOREIGN KEY ("sandbox_provider_id","workspace_id") REFERENCES "sandbox_provider"("id","workspace_id");--> statement-breakpoint
ALTER TABLE "sandbox_provider" ADD CONSTRAINT "sandbox_provider_workspace_id_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sandbox_provider" ADD CONSTRAINT "sandbox_provider_created_by_id_user_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE SET NULL;