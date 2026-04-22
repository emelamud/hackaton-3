import { DestroyRef, Injectable, Signal, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SocketService } from '../socket/socket.service';
import type { PresenceState } from '@shared';

/**
 * App-wide server-sourced presence map.
 *
 * Keyed by userId → `'online' | 'afk' | 'offline'`. Seeded on each socket
 * connect by a `presence:snapshot` emission (per-socket, not per-user) and
 * kept live via `presence:update` broadcasts whenever a peer's aggregate
 * state transitions.
 *
 * The service is eagerly constructed by `AuthService` so the two socket
 * subscriptions are active before the first snapshot lands. `reset()` wipes
 * the map on logout — follows the same pattern as `FriendsService.reset()`
 * and `UserBansService.reset()`.
 *
 * Self-state is NOT tracked here — the server deliberately does not broadcast
 * self-presence. Self dot is driven by `PresenceActivityService.selfState`.
 */
@Injectable({ providedIn: 'root' })
export class PresenceService {
  private readonly socketService = inject(SocketService);
  private readonly destroyRef = inject(DestroyRef);

  /** Full presence map. Consumers subscribe via `stateFor(userId)` which returns a computed signal. */
  readonly presences = signal<ReadonlyMap<string, PresenceState>>(new Map());

  constructor() {
    this.socketService
      .on('presence:snapshot')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((payload) => {
        // Merge the snapshot into the existing map rather than replacing it.
        // A new tab / reconnect should not drop entries that other live
        // subscriptions populated between socket drops.
        this.presences.update((prev) => {
          const next = new Map(prev);
          for (const { userId, state } of payload.presences) next.set(userId, state);
          return next;
        });
      });

    this.socketService
      .on('presence:update')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(({ userId, state }) => {
        this.presences.update((prev) => {
          const next = new Map(prev);
          next.set(userId, state);
          return next;
        });
      });
  }

  /**
   * Reactive lookup for a single userId.
   *
   * Returns `'offline'` when the user is unknown (never seen in a snapshot
   * and no update received). Each call returns an independent `computed`
   * handle — cheap, but prefer caching at the call site if rendering a
   * many-row list.
   */
  stateFor(userId: string): Signal<PresenceState> {
    return computed(() => this.presences().get(userId) ?? 'offline');
  }

  /** Clear the map — invoked from `AuthService.clearSession()`. */
  reset(): void {
    this.presences.set(new Map());
  }
}
