CREATE TABLE "sandbox_lease" (
	"sandbox_id" uuid,
	"holder" text,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sandbox_lease_pkey" PRIMARY KEY("sandbox_id","holder")
);
--> statement-breakpoint
ALTER TABLE "sandbox" ADD COLUMN "paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sandbox" ADD COLUMN "last_used_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "sandbox_lease" ADD CONSTRAINT "sandbox_lease_sandbox_id_sandbox_id_fkey" FOREIGN KEY ("sandbox_id") REFERENCES "sandbox"("id") ON DELETE CASCADE;