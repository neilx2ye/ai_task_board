#!/usr/bin/env node
/* global process */
/**
 * Create a local account without opening public registration.
 *
 *   sudo -u ai-task-board DATABASE_URL=postgresql:///ai_task_board?host=/var/run/postgresql \
 *     node scripts/create-user.mjs user@example.com 'a-strong-password'
 *
 * The password hash format matches lib/auth/password.ts, so the account can
 * sign in through the normal login flow.
 */
import { randomBytes, randomUUID, scrypt } from "node:crypto";

import { Client } from "pg";

const [email, password] = process.argv.slice(2);
const connectionString =
  process.env.DATABASE_URL ??
  "postgresql:///ai_task_board?host=/var/run/postgresql";

if (!email || !password) {
  console.error(
    "Usage: node scripts/create-user.mjs <email> <password>",
  );
  process.exit(2);
}
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error("Email format is invalid");
  process.exit(2);
}
if (password.length < 8) {
  console.error("Password must contain at least 8 characters");
  process.exit(2);
}

function derive(value, salt) {
  return new Promise((resolve, reject) => {
    scrypt(value, salt, 64, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

const client = new Client({ connectionString });
await client.connect();
try {
  const salt = randomBytes(16).toString("hex");
  const hash = await derive(password, salt);
  const passwordHash = `scrypt$${salt}$${hash.toString("hex")}`;
  const id = randomUUID();
  const normalized = email.trim().toLowerCase();
  try {
    await client.query(
      `insert into auth.users (id, email, raw_user_meta_data, password_hash)
       values ($1::uuid, $2, jsonb_build_object('name', split_part($2, '@', 1)), $3)`,
      [id, normalized, passwordHash],
    );
  } catch (error) {
    if (error?.code === "23505") {
      console.error("An account with this email already exists");
      process.exit(1);
    }
    throw error;
  }
  const workspace = await client.query(
    `select workspace_id from public.workspace_members where user_id = $1::uuid limit 1`,
    [id],
  );
  console.log(`created user ${id} (${normalized})`);
  console.log(
    `workspace ${workspace.rows[0]?.workspace_id ?? "missing"} attached by the onboarding trigger`,
  );
} finally {
  await client.end();
}
