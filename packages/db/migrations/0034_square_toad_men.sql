DROP INDEX "sandbox_runtime_contract_bindings_scope_contract_idx";--> statement-breakpoint
ALTER TABLE "sandbox_runtime_contract_bindings" ADD COLUMN "agent_scope_key" varchar(255) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "sandbox_runtime_contract_bindings" ADD COLUMN "cluster_scope_key" varchar(255) DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_runtime_contract_bindings_scope_contract_idx" ON "sandbox_runtime_contract_bindings" USING btree ("provider_org_id","agent_scope_key","cluster_scope_key","runtime_contract_ref");