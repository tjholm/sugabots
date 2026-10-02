CREATE TABLE "sandbox_allowed_host" (
	"workspace_id" uuid,
	"host" text,
	"added_by_id" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_allowed_host_pkey" PRIMARY KEY("workspace_id","host")
);
--> statement-breakpoint
ALTER TABLE "sandbox_allowed_host" ADD CONSTRAINT "sandbox_allowed_host_workspace_id_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sandbox_allowed_host" ADD CONSTRAINT "sandbox_allowed_host_added_by_id_user_id_fkey" FOREIGN KEY ("added_by_id") REFERENCES "user"("id") ON DELETE SET NULL;