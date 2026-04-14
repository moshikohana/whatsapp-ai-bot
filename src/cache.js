'use strict';

/**
 * Simple TTL cache for tool results (Calendar, Gmail, Contacts).
 * Write operations (add, delete, send, etc.) invalidate relevant cache keys.
 */

const DEFAULT_TTL = 5 * 60 * 1000; // 5 minutes

class ToolCache {
  constructor() {
    this.store = new Map(); // key → { data, expiresAt }
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Get cached value, or null if expired/missing
   */
  get(key) {
    const entry = this.store.get(key);
    if (!entry) { this.misses++; return null; }
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      this.misses++;
      return null;
    }
    this.hits++;
    return entry.data;
  }

  /**
   * Cache a value with optional TTL
   */
  set(key, data, ttl = DEFAULT_TTL) {
    this.store.set(key, { data, expiresAt: Date.now() + ttl });
  }

  /**
   * Invalidate all keys matching a prefix
   * e.g. invalidate('calendar') clears 'calendar:today', 'calendar:week', etc.
   */
  invalidate(prefix) {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }

  /**
   * Clear entire cache
   */
  clear() {
    this.store.clear();
  }

  /**
   * Stats for monitoring
   */
  getStats() {
    const total = this.hits + this.misses;
    return {
      entries: this.store.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? Math.round((this.hits / total) * 100) + '%' : 'N/A',
    };
  }
}

// Singleton instance
const cache = new ToolCache();

/**
 * Build a cache key from tool name + action + relevant params
 */
function cacheKey(tool, action, params = {}) {
  const parts = [tool, action];
  // Include relevant params in key (sorted for consistency)
  for (const k of Object.keys(params).sort()) {
    if (params[k] != null) parts.push(`${k}=${params[k]}`);
  }
  return parts.join(':');
}

/**
 * Read-only actions that are safe to cache
 */
const CACHEABLE_ACTIONS = {
  calendar: new Set(['today', 'week', 'events', 'search']),
  gmail: new Set(['unread', 'search', 'read', 'stats']),
  contacts: new Set(['search', 'list', 'details']),
};

/**
 * Write actions that should invalidate the cache for their tool
 */
const WRITE_ACTIONS = {
  calendar: new Set(['add', 'delete']),
  gmail: new Set(['send', 'reply', 'mark_read', 'trash', 'star']),
};

/**
 * Wrap a tool handler with caching logic.
 * Read-only actions → check cache first.
 * Write actions → invalidate cache after execution.
 */
function withCache(toolName, handler) {
  const cacheable = CACHEABLE_ACTIONS[toolName];
  const writable = WRITE_ACTIONS[toolName];
  if (!cacheable) return handler; // Tool not cacheable, return as-is

  return async (input) => {
    const { action, ...params } = input;

    // Write action → execute then invalidate
    if (writable && writable.has(action)) {
      const result = await handler(input);
      cache.invalidate(toolName);
      return result;
    }

    // Read action → check cache
    if (cacheable.has(action)) {
      const key = cacheKey(toolName, action, params);
      const cached = cache.get(key);
      if (cached) {
        console.log(`📋 Cache hit: ${key}`);
        return cached;
      }
      const result = await handler(input);
      cache.set(key, result);
      return result;
    }

    // Unknown action → pass through
    return handler(input);
  };
}

module.exports = { cache, withCache };
