import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const schemaPath = path.resolve(__dirname, "../db/schema.sql");

let pool = null;
let initPromise = null;

function getDatabaseUrl() {
  const value = typeof process.env.DATABASE_URL === "string" ? process.env.DATABASE_URL.trim() : "";
  return value || null;
}

export function isDatabaseEnabled() {
  return Boolean(getDatabaseUrl());
}

function getPool() {
  const databaseUrl = getDatabaseUrl();

  if (!databaseUrl) {
    return null;
  }

  if (!pool) {
    pool = new Pool({
      connectionString: databaseUrl,
      max: Number(process.env.DATABASE_POOL_MAX || 10),
      idleTimeoutMillis: 30_000,
      ssl: databaseUrl.includes("sslmode=require") ? { rejectUnauthorized: false } : undefined
    });
  }

  return pool;
}

export async function initializeDatabase() {
  if (!isDatabaseEnabled()) {
    return false;
  }

  if (!initPromise) {
    initPromise = (async () => {
      const client = await getPool().connect();

      try {
        const schemaSql = fs.readFileSync(schemaPath, "utf8");
        await client.query(schemaSql);
      } finally {
        client.release();
      }

      return true;
    })().catch((error) => {
      initPromise = null;
      throw error;
    });
  }

  return initPromise;
}

export async function query(text, params = []) {
  const activePool = getPool();

  if (!activePool) {
    return null;
  }

  await initializeDatabase();
  return activePool.query(text, params);
}
