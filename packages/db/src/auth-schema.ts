import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * BetterAuth tables (task TASK-011, plan §"Auth"). Shape dictated by BetterAuth's core schema —
 * the property names below are the field names it looks up, the strings are our column names.
 *
 * These sit apart from `schema.ts` on purpose. Every *domain* table carries a non-null
 * `workspaceId` (Principle V); these do not, because they are where the tenant key comes *from*:
 * a Workspace is owned by a user (`workspace.ownerUserId` → `auth_user.id`), and a request's
 * `workspaceId` is derived from the authenticated user, never from client input.
 *
 * Table names are prefixed `auth_`: BetterAuth's default model name for a login session is
 * `session`, which is already taken here by an *agent* session. The prefix keeps the two
 * unambiguous in SQL as well as in code.
 */

/** Millisecond timestamps — what BetterAuth's SQLite adapter reads and writes as `Date`. */
const timestamp = (column: string) => integer(column, { mode: "timestamp_ms" });

export const authUser = sqliteTable("auth_user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

export const authSession = sqliteTable("auth_session", {
  id: text("id").primaryKey(),
  /** The session cookie's value. Unique so a token can be looked up directly. */
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => authUser.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

export const authAccount = sqliteTable("auth_account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => authUser.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  /** Hashed by BetterAuth (scrypt) before it ever reaches this column. */
  password: text("password"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

export const authVerification = sqliteTable("auth_verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

export const authSchema = { authUser, authSession, authAccount, authVerification };
