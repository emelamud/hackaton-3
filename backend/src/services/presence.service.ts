import type { PresenceState, UserPresence } from '@shared';

// Round 7 — Presence is ephemeral by design: it is an in-memory registry that
// resets on server restart. No DB, no side-effects at import time. The socket
// handler drives this store; this module never touches the network.

type SocketActivity = 'active' | 'idle';

interface UserEntry {
  // Map<socketId, SocketActivity> — iteration order is insertion, which is fine.
  sockets: Map<string, SocketActivity>;
  // Cached aggregate — recomputed on every mutation, exposed via getUserPresence.
  aggregate: PresenceState;
}

const users = new Map<string, UserEntry>();
const socketToUser = new Map<string, string>(); // socketId → userId; O(1) disconnect lookup.

/**
 * Recompute `online | afk` based on the sockets map.
 * Caller must ensure the entry has at least one socket; the empty-sockets case
 * (→ `offline`, entry deleted) is handled outside this helper.
 */
function recomputeAggregate(entry: UserEntry): PresenceState {
  for (const activity of entry.sockets.values()) {
    if (activity === 'active') return 'online';
  }
  return 'afk';
}

export function handleConnect(
  socketId: string,
  userId: string,
): { changed: boolean; state: PresenceState } {
  socketToUser.set(socketId, userId);

  const existing = users.get(userId);
  if (!existing) {
    users.set(userId, {
      sockets: new Map([[socketId, 'active']]),
      aggregate: 'online',
    });
    return { changed: true, state: 'online' };
  }

  const prev = existing.aggregate;
  existing.sockets.set(socketId, 'active');
  const next = recomputeAggregate(existing);
  existing.aggregate = next;

  return { changed: prev !== next, state: next };
}

export function handleDisconnect(
  socketId: string,
): { userId: string | null; changed: boolean; state: PresenceState } {
  const userId = socketToUser.get(socketId);
  if (!userId) {
    // Defensive — shouldn't happen; socket was never registered.
    return { userId: null, changed: false, state: 'offline' };
  }
  socketToUser.delete(socketId);

  const entry = users.get(userId);
  if (!entry) {
    return { userId, changed: false, state: 'offline' };
  }

  entry.sockets.delete(socketId);

  if (entry.sockets.size === 0) {
    // Last socket gone → user is offline; drop the entry entirely.
    users.delete(userId);
    return { userId, changed: true, state: 'offline' };
  }

  const prev = entry.aggregate;
  const next = recomputeAggregate(entry);
  entry.aggregate = next;
  return { userId, changed: prev !== next, state: next };
}

export function setSocketActivity(
  socketId: string,
  activity: SocketActivity,
): { userId: string | null; changed: boolean; state: PresenceState } {
  const userId = socketToUser.get(socketId);
  if (!userId) {
    // Raced with disconnect — caller should no-op.
    return { userId: null, changed: false, state: 'offline' };
  }

  const entry = users.get(userId);
  if (!entry || !entry.sockets.has(socketId)) {
    return { userId: null, changed: false, state: 'offline' };
  }

  const prevActivity = entry.sockets.get(socketId);
  if (prevActivity === activity) {
    // No-op; avoid spurious recompute.
    return { userId, changed: false, state: entry.aggregate };
  }

  entry.sockets.set(socketId, activity);
  const prev = entry.aggregate;
  const next = recomputeAggregate(entry);
  entry.aggregate = next;
  return { userId, changed: prev !== next, state: next };
}

export function getUserPresence(userId: string): PresenceState {
  const entry = users.get(userId);
  return entry ? entry.aggregate : 'offline';
}

export function snapshotForUsers(userIds: string[]): UserPresence[] {
  return userIds.map((userId) => ({ userId, state: getUserPresence(userId) }));
}

/**
 * Test helper — reset the module's in-memory maps so a smoke-harness run does
 * not inherit presence rows from a previous process. Prod code never calls
 * this; it just exists so the registry stays deterministic under test.
 */
export function __resetForTests(): void {
  users.clear();
  socketToUser.clear();
}
