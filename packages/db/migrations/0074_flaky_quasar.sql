ALTER TABLE "federation_budgets" DROP CONSTRAINT "federation_budget_conservation";--> statement-breakpoint
ALTER TABLE "federation_reservations" DROP CONSTRAINT "federation_reservation_amount";--> statement-breakpoint
ALTER TABLE "federation_budgets" ADD CONSTRAINT "federation_budget_conservation" CHECK ("federation_budgets"."limit"::text ~ '^(0|[1-9][0-9]{0,37})$'
        AND "federation_budgets"."available"::text ~ '^(0|[1-9][0-9]{0,37})$'
        AND "federation_budgets"."reserved"::text ~ '^(0|[1-9][0-9]{0,37})$'
        AND "federation_budgets"."limit" = "federation_budgets"."available" + "federation_budgets"."reserved");--> statement-breakpoint
ALTER TABLE "federation_reservations" ADD CONSTRAINT "federation_reservation_amount" CHECK ("federation_reservations"."amount"::text ~ '^(0|[1-9][0-9]{0,37})$' AND "federation_reservations"."attempt" > 0);