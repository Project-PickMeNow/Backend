-- CreateTable
CREATE TABLE "stats" (
    "id" UUID NOT NULL,
    "total_rooms" BIGINT NOT NULL DEFAULT 0,
    "total_plays" BIGINT NOT NULL DEFAULT 0,
    "total_participants" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "stats_pkey" PRIMARY KEY ("id")
);
