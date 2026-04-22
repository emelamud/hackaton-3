import { DestroyRef, Injectable, Signal, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, tap } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { environment } from '../../../environments/environment';
import { SocketService } from '../socket/socket.service';
import type { MarkRoomReadResponse, UnreadCount } from '@shared';

/**
 * App-wide per-room unread counter.
 *
 * Seeded via `initialize()` after auth lands, mutated by three hooks:
 *   - `message:new` socket subscription — bumps the count for any room that
 *     is NOT currently open AND whose author is not the caller.
 *   - `room:read` socket subscription — clears the count for the named room;
 *     lets a second tab stay in sync when the first tab marks a room read.
 *   - `setActiveRoom(roomId)` — called by `RoomViewComponent` on route enter;
 *     optimistically clears the count + POSTs `/rooms/:id/read` (debounced).
 *
 * The counts map is exposed as a read-only signal; sidebar rows subscribe
 * via `unreadByRoomId().get(roomId)`. Absence = 0; components pass
 * `|| null` so the `[matBadge]` binding hides the dot on zero.
 */
@Injectable({ providedIn: 'root' })
export class UnreadService {
  private readonly http = inject(HttpClient);
  private readonly socketService = inject(SocketService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly baseUrl = environment.apiUrl;

  /**
   * Caller's user id — pushed in by `AuthService` via `setCurrentUserId()`
   * after login / register / refresh / restored-session hydration. Held as a
   * plain field (not `inject(AuthService)`) to keep `UnreadService` free of
   * a DI cycle: `AuthService` eagerly injects `UnreadService`, so the reverse
   * edge would re-trigger NG0200 the moment any component that injects
   * `UnreadService` mounts while `AuthService` is still constructing.
   */
  private currentUserId: string | null = null;

  /** Count per room id. Absent key = 0. */
  private readonly counts = signal<ReadonlyMap<string, number>>(new Map());

  /** The currently-viewed room id (set by `RoomViewComponent`). `null` when no room is open. */
  private readonly activeRoomId = signal<string | null>(null);

  /** Debounce guard — last markRead timestamp per room (ms epoch). Rate-limits hot paths. */
  private readonly lastMarkReadAt = new Map<string, number>();
  private static readonly MARK_READ_DEBOUNCE_MS = 500;

  /** Public read-only signal for template bindings. */
  readonly unreadByRoomId = this.counts.asReadonly();

  /** Convenience selector for a single room id — useful when a template binds to one cell. */
  countFor(roomId: string): Signal<number> {
    return computed(() => this.counts().get(roomId) ?? 0);
  }

  constructor() {
    // Live increment on `message:new` for rooms that are NOT currently open.
    // Also skip own-message echoes — the sender socket doesn't receive its own
    // broadcast, but OTHER tabs of the same user do, and we must not bump the
    // badge in the sender's other tabs.
    this.socketService
      .on('message:new')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((msg) => {
        if (msg.roomId === this.activeRoomId()) return;
        if (msg.userId === this.currentUserId) return;
        this.increment(msg.roomId);
      });

    // Multi-tab sync — when ANY of the user's tabs marks a room read, all
    // tabs receive `room:read` and clear the badge.
    this.socketService
      .on('room:read')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((payload) => {
        this.clearCount(payload.roomId);
      });
  }

  /**
   * Seed the caller's user id. Called by `AuthService` after every mutation
   * of `currentUser` (login / register / refresh / restored-session hydrate /
   * clearSession indirectly via `reset()`).
   */
  setCurrentUserId(userId: string | null): void {
    this.currentUserId = userId;
  }

  /** Called once from the post-auth init path (mirrors `FriendsService.fetchInitial()`). */
  initialize(): Observable<UnreadCount[]> {
    return this.http.get<UnreadCount[]>(`${this.baseUrl}/unread`).pipe(
      tap((list) => {
        const next = new Map<string, number>();
        for (const row of list) {
          if (row.unreadCount > 0) next.set(row.roomId, row.unreadCount);
        }
        this.counts.set(next);
      }),
    );
  }

  /** Called by `RoomViewComponent` on route enter / swap / destroy. */
  setActiveRoom(roomId: string | null): void {
    this.activeRoomId.set(roomId);
    if (roomId) this.markRoomRead(roomId);
  }

  /** Called by `RoomViewComponent` when a `message:new` arrives in the active room. */
  onLiveMessageInActiveRoom(roomId: string): void {
    this.markRoomRead(roomId);
  }

  /** Wipe all counts — used on logout / session reset. */
  reset(): void {
    this.counts.set(new Map());
    this.activeRoomId.set(null);
    this.lastMarkReadAt.clear();
    this.currentUserId = null;
  }

  private markRoomRead(roomId: string): void {
    const now = Date.now();
    const last = this.lastMarkReadAt.get(roomId) ?? 0;
    if (now - last < UnreadService.MARK_READ_DEBOUNCE_MS) return;
    this.lastMarkReadAt.set(roomId, now);

    // Optimistic clear — no rollback needed. A failed POST just means the
    // server cursor stays where it was and the next `message:new` repaints
    // the badge. Multi-tab sync piggybacks on the `room:read` echo.
    this.clearCount(roomId);

    this.http
      .post<MarkRoomReadResponse>(`${this.baseUrl}/rooms/${roomId}/read`, {})
      .subscribe({
        error: () => {
          // Silent — future `message:new` will re-accrue. No snackbar: this is
          // fire-and-forget UX.
        },
      });
  }

  private clearCount(roomId: string): void {
    this.counts.update((map) => {
      if (!map.has(roomId)) return map;
      const next = new Map(map);
      next.delete(roomId);
      return next;
    });
  }

  private increment(roomId: string): void {
    this.counts.update((map) => {
      const next = new Map(map);
      next.set(roomId, (map.get(roomId) ?? 0) + 1);
      return next;
    });
  }
}
