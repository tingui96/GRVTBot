// Per-user GRVTClient factory with LRU cache.
//
// Multi-tenant: each user has their own GRVT API credentials
// encrypted in the DB. This factory decrypts them, creates a
// GRVTClient instance, logs it in (cookie auth), and caches
// it for 5 minutes to avoid re-decrypting on every request.
//
// Usage:
//   const client = await getGrvtClientForUser(userId, db);
//   const balance = await client.getBalance();
//
// When a user updates their credentials:
//   invalidateGrvtClient(userId);  // drops cache entry
//
// When a running bot's user updates their creds:
//   engine.rebindGrvtClient(userId);  // replaces instance refs

import { GRVTClient, type GrvtClientCreds } from './client.js';
import { decryptCredentialFields } from '../auth/crypto.js';
import type { GridBotDB } from '../database/db.js';

interface CacheEntry {
  client: GRVTClient;
  expiresAt: number;
}

const cache = new Map<number, CacheEntry>();
const TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Get or create a GRVTClient for the given user. Decrypts their
 * stored credentials, creates + logs in the client, and caches it.
 * Throws if the user has no stored credentials.
 */
export async function getGrvtClientForUser(
  userId: number,
  gridBotDb: GridBotDB
): Promise<GRVTClient> {
  // Cache hit?
  const hit = cache.get(userId);
  if (hit && hit.expiresAt > Date.now()) {
    return hit.client;
  }

  // Read encrypted creds from DB.
  const row = await gridBotDb.getGrvtCredentialsRaw(userId);
  if (!row) {
    throw new Error(`User ${userId} has no GRVT credentials configured`);
  }

  // Decrypt.
  const plain = decryptCredentialFields(row);

  // Create client with explicit creds.
  const creds: GrvtClientCreds = {
    apiKey: plain.apiKey,
    apiSecret: plain.apiSecret,
    tradingAddress: plain.tradingAddress,
    accountId: plain.accountId,
    subAccountId: plain.subAccountId,
  };
  const client = new GRVTClient(creds);

  // Login (obtain cookie).
  const ok = await client.login();
  if (!ok) {
    throw new Error(`GRVT login failed for user ${userId}`);
  }

  // Cache.
  cache.set(userId, { client, expiresAt: Date.now() + TTL_MS });

  // Touch last_used_at (fire and forget).
  gridBotDb.touchGrvtCredentialsLastUsed(userId).catch(() => {});

  return client;
}

/** Drop the cached client for a user. Call when they update creds. */
export function invalidateGrvtClient(userId: number): void {
  cache.delete(userId);
}

/** Drop all cached clients. Call on server shutdown. */
export function invalidateAll(): void {
  cache.clear();
}
