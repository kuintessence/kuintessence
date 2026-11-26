CREATE TABLE "netdrive_storage_daily" (
	"day" date NOT NULL,
	"owner_id" uuid NOT NULL,
	"byte_seconds" numeric NOT NULL,
	CONSTRAINT "netdrive_storage_daily_day_owner_id_pk" PRIMARY KEY("day","owner_id")
);
