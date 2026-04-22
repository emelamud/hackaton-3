import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').unique().notNull(),
  username: text('username').unique().notNull(),
  passwordHash: text('password_hash').notNull(),
  // Bumped on every successful password reset; embedded in reset JWTs as `v`.
  // Mismatch → token rejected, giving single-use semantics for reset tokens.
  passwordResetTokenVersion: integer('password_reset_token_version').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  refreshTokenHash: text('refresh_token_hash').notNull(),
  userAgent: text('user_agent'),
  ipAddress: text('ip_address'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  expiresAt: timestamp('expires_at').notNull(),
});

export const roomVisibility = pgEnum('room_visibility', ['public', 'private']);
export const roomRole = pgEnum('room_role', ['owner', 'admin', 'member']);
// Round 6 — discriminator so DMs can share the `rooms` table without a
// dedicated `dm_rooms` table. Default `'channel'` lets the migration backfill
// pre-existing rows in a single statement.
export const roomType = pgEnum('room_type', ['channel', 'dm']);

export const rooms = pgTable(
  'rooms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: roomType('type').notNull().default('channel'),
    // `name` is nullable for DMs (Round 6). Postgres treats NULLs as distinct
    // by default, so the existing unique index still safely covers channels.
    name: text('name').unique(),
    description: text('description'),
    visibility: roomVisibility('visibility').notNull(),
    // `owner_id` is nullable for DMs (Round 6) — DMs have two `member` rows
    // and no owner / admin concept.
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    nameLowerIdx: uniqueIndex('rooms_name_lower_idx').on(sql`lower(${table.name})`),
    // DB-level invariants mirroring the task requirement: channels must carry
    // both `name` and `owner_id`; DMs must carry neither (stored as NULL).
    channelNameRequired: check(
      'rooms_channel_name_required',
      sql`(${table.type} = 'channel' AND ${table.name} IS NOT NULL) OR ${table.type} = 'dm'`,
    ),
    channelOwnerRequired: check(
      'rooms_channel_owner_required',
      sql`(${table.type} = 'channel' AND ${table.ownerId} IS NOT NULL) OR ${table.type} = 'dm'`,
    ),
  }),
);

export const roomMembers = pgTable(
  'room_members',
  {
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: roomRole('role').notNull(),
    joinedAt: timestamp('joined_at').defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.roomId, table.userId] }),
  }),
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    // Needed for ORDER BY created_at history queries; Round 5 cursor pagination
    // will rely on this compound index.
    roomCreatedIdx: index('messages_room_created_idx').on(table.roomId, table.createdAt),
  }),
);

export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    invitedUserId: uuid('invited_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    invitedByUserId: uuid('invited_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    // One pending invitation per (room, invitee) pair.
    roomInviteeIdx: uniqueIndex('invitations_room_invitee_idx').on(
      table.roomId,
      table.invitedUserId,
    ),
    // GET /api/invitations filters by invited_user_id.
    invitedUserIdx: index('invitations_invited_user_idx').on(table.invitedUserId),
  }),
);

export const friendships = pgTable(
  'friendships',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    friendUserId: uuid('friend_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    // Symmetric two-row design (Q1 = 1b). Composite PK doubles as the
    // `(user_id, friend_user_id)` lookup index for `GET /api/friends`.
    pk: primaryKey({ columns: [table.userId, table.friendUserId] }),
    // Guard against self-friendship rows at the DB level.
    selfFriendship: check(
      'friendships_no_self',
      sql`${table.userId} <> ${table.friendUserId}`,
    ),
  }),
);

export const friendRequests = pgTable(
  'friend_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fromUserId: uuid('from_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    toUserId: uuid('to_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // `message` has no length constraint at the DB level — zod enforces 500 in
    // the route layer so validation errors carry the usual envelope.
    message: text('message'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    // Unordered-pair uniqueness — catches both the "resend same direction"
    // and the "counter-request from the other side" cases with one 23505.
    pairIdx: uniqueIndex('friend_requests_pair_idx').on(
      sql`LEAST(${table.fromUserId}, ${table.toUserId})`,
      sql`GREATEST(${table.fromUserId}, ${table.toUserId})`,
    ),
    // Backs `GET /api/friend-requests/incoming`.
    toUserIdx: index('friend_requests_to_user_idx').on(table.toUserId),
    // Backs `GET /api/friend-requests/outgoing`.
    fromUserIdx: index('friend_requests_from_user_idx').on(table.fromUserId),
  }),
);

// Round 6 — DMs live in `rooms` with `type='dm'`; this side-table stores the
// canonicalised (user_a_id < user_b_id) pair and backs the idempotent
// `POST /api/dm` upsert. `rooms.id` is the FK so cascading a room delete
// cleans up the pair row too.
export const directMessages = pgTable(
  'direct_messages',
  {
    roomId: uuid('room_id')
      .primaryKey()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    userAId: uuid('user_a_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    userBId: uuid('user_b_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    // Primary lookup for the upsert path: exact equality on the canonical
    // pair. The columns are stored pre-canonicalised (min/max), so a plain
    // btree index on (user_a_id, user_b_id) suffices — no functional
    // LEAST/GREATEST index needed.
    pairIdx: uniqueIndex('direct_messages_pair_idx').on(table.userAId, table.userBId),
    noSelf: check('direct_messages_no_self', sql`${table.userAId} <> ${table.userBId}`),
    // Defence-in-depth against a caller passing non-canonicalised values.
    canonicalOrder: check(
      'direct_messages_canonical_order',
      sql`${table.userAId} < ${table.userBId}`,
    ),
  }),
);

// Round 8 — attachments. One row per uploaded file. Starts as `pending`
// (invisible to the chat UI); flips to `attached` with `message_id` set
// inside the same transaction as the `messages` insert via the
// `message:send` handler. Dual FKs cascade on room / message delete —
// on-disk files are NOT unlinked by the cascade (future rounds must
// `DELETE … RETURNING storage_path` and `fs.unlink` explicitly).
export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    uploaderId: uuid('uploader_id')
      .notNull()
      .references(() => users.id),
    messageId: uuid('message_id').references(() => messages.id, {
      onDelete: 'cascade',
    }),
    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    kind: text('kind', { enum: ['image', 'file'] }).notNull(),
    comment: text('comment'),
    storagePath: text('storage_path').notNull(),
    status: text('status', { enum: ['pending', 'attached'] })
      .notNull()
      .default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    attachedAt: timestamp('attached_at', { withTimezone: true }),
  },
  (table) => ({
    // Backs the Round 9 pagination batch-load
    // (SELECT … WHERE message_id = ANY($ids) AND status='attached').
    attachmentsMessageIdx: index('attachments_message_idx').on(table.messageId),
    // Partial index for the orphan-sweep cron — keeps the scan cheap without
    // bloating the main hot path (`status='attached'` rows dominate).
    attachmentsPendingSweepIdx: index('attachments_pending_sweep_idx')
      .on(table.status, table.createdAt)
      .where(sql`status = 'pending'`),
  }),
);

// Round 6 — directional user-to-user bans. Creating a row severs friendship
// and drops pending friend-requests in the same transaction. DM message-send
// + DM create consult this table in either direction.
export const userBans = pgTable(
  'user_bans',
  {
    blockerUserId: uuid('blocker_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    blockedUserId: uuid('blocked_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    // Composite PK doubles as `GET /api/user-bans` lookup index.
    pk: primaryKey({ columns: [table.blockerUserId, table.blockedUserId] }),
    // Backs the "is this caller banned by anyone" / DM message-send reverse
    // direction — `WHERE blocked_user_id = $callerId` needs a dedicated index
    // because the composite PK only helps when `blocker_user_id` is the
    // leading column.
    blockedUserIdx: index('user_bans_blocked_user_idx').on(table.blockedUserId),
    noSelf: check(
      'user_bans_no_self',
      sql`${table.blockerUserId} <> ${table.blockedUserId}`,
    ),
  }),
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type RoomRow = typeof rooms.$inferSelect;
export type NewRoomRow = typeof rooms.$inferInsert;
export type RoomMemberRow = typeof roomMembers.$inferSelect;
export type NewRoomMemberRow = typeof roomMembers.$inferInsert;
export type MessageRow = typeof messages.$inferSelect;
export type NewMessageRow = typeof messages.$inferInsert;
export type InvitationRow = typeof invitations.$inferSelect;
export type NewInvitationRow = typeof invitations.$inferInsert;
export type FriendshipRow = typeof friendships.$inferSelect;
export type NewFriendshipRow = typeof friendships.$inferInsert;
export type FriendRequestRow = typeof friendRequests.$inferSelect;
export type NewFriendRequestRow = typeof friendRequests.$inferInsert;
export type DirectMessageRow = typeof directMessages.$inferSelect;
export type NewDirectMessageRow = typeof directMessages.$inferInsert;
export type UserBanRow = typeof userBans.$inferSelect;
export type NewUserBanRow = typeof userBans.$inferInsert;
export type AttachmentRow = typeof attachments.$inferSelect;
export type NewAttachmentRow = typeof attachments.$inferInsert;
