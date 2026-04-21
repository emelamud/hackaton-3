CREATE TYPE "public"."room_type" AS ENUM('channel', 'dm');--> statement-breakpoint
CREATE TABLE "direct_messages" (
	"room_id" uuid PRIMARY KEY NOT NULL,
	"user_a_id" uuid NOT NULL,
	"user_b_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "direct_messages_no_self" CHECK ("direct_messages"."user_a_id" <> "direct_messages"."user_b_id"),
	CONSTRAINT "direct_messages_canonical_order" CHECK ("direct_messages"."user_a_id" < "direct_messages"."user_b_id")
);
--> statement-breakpoint
CREATE TABLE "user_bans" (
	"blocker_user_id" uuid NOT NULL,
	"blocked_user_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_bans_blocker_user_id_blocked_user_id_pk" PRIMARY KEY("blocker_user_id","blocked_user_id"),
	CONSTRAINT "user_bans_no_self" CHECK ("user_bans"."blocker_user_id" <> "user_bans"."blocked_user_id")
);
--> statement-breakpoint
ALTER TABLE "rooms" ALTER COLUMN "name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "rooms" ALTER COLUMN "owner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "type" "room_type" DEFAULT 'channel' NOT NULL;--> statement-breakpoint
ALTER TABLE "direct_messages" ADD CONSTRAINT "direct_messages_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "direct_messages" ADD CONSTRAINT "direct_messages_user_a_id_users_id_fk" FOREIGN KEY ("user_a_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "direct_messages" ADD CONSTRAINT "direct_messages_user_b_id_users_id_fk" FOREIGN KEY ("user_b_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_bans" ADD CONSTRAINT "user_bans_blocker_user_id_users_id_fk" FOREIGN KEY ("blocker_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_bans" ADD CONSTRAINT "user_bans_blocked_user_id_users_id_fk" FOREIGN KEY ("blocked_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "direct_messages_pair_idx" ON "direct_messages" USING btree ("user_a_id","user_b_id");--> statement-breakpoint
CREATE INDEX "user_bans_blocked_user_idx" ON "user_bans" USING btree ("blocked_user_id");--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_channel_name_required" CHECK (("rooms"."type" = 'channel' AND "rooms"."name" IS NOT NULL) OR "rooms"."type" = 'dm');--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_channel_owner_required" CHECK (("rooms"."type" = 'channel' AND "rooms"."owner_id" IS NOT NULL) OR "rooms"."type" = 'dm');