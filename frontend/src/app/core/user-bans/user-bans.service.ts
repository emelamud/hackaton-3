import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, map, tap } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { environment } from '../../../environments/environment';
import { SocketService } from '../socket/socket.service';
import { FriendsService } from '../friends/friends.service';
import type { UserBan, CreateUserBanRequest } from '@shared';

/**
 * App-wide cache of the current user's outgoing blocks PLUS the set of peers
 * who have banned the caller (learned only from live socket events — the
 * server deliberately does not expose a "who blocked me" list).
 *
 * `blocks()` — list the caller has actively blocked (from `GET /api/user-bans`).
 * `incomingBans()` — set of userIds who have blocked the caller, built from
 *   live `user:ban:applied` / `user:ban:removed` events. Plus one more path:
 *   when the DM composer receives a `"Personal messaging is blocked"` ack
 *   mid-send, `markIncoming(peerUserId)` is called to freeze the composer
 *   retroactively (covers the "banned while offline" race).
 *
 * `isBanned(userId)` — true when EITHER direction is active; used by the DM
 * composer, friend-row, and sidebar to decide freeze UX.
 *
 * Seeded by `AuthService.login()` / `register()` / silent `refresh()` via
 * `fetchInitial()`, cleared on `logout()`.
 */
@Injectable({ providedIn: 'root' })
export class UserBansService {
  private readonly http = inject(HttpClient);
  private readonly socketService = inject(SocketService);
  private readonly friendsService = inject(FriendsService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly baseUrl = `${environment.apiUrl}/user-bans`;

  readonly blocks = signal<UserBan[]>([]);
  readonly incomingBans = signal<ReadonlySet<string>>(new Set());

  readonly isBanned = (userId: string): boolean =>
    this.blocks().some((b) => b.userId === userId) || this.incomingBans().has(userId);

  constructor() {
    this.socketService
      .on('user:ban:applied')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((payload) => {
        this.incomingBans.update((set) => {
          const next = new Set(set);
          next.add(payload.userId);
          return next;
        });
      });

    this.socketService
      .on('user:ban:removed')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((payload) => {
        this.incomingBans.update((set) => {
          const next = new Set(set);
          next.delete(payload.userId);
          return next;
        });
      });
  }

  /** Seed the outgoing `blocks` list after login / register / silent refresh. */
  fetchInitial(): Observable<void> {
    return this.http.get<UserBan[]>(this.baseUrl).pipe(
      tap((list) => this.blocks.set(list)),
      map(() => undefined),
    );
  }

  block(userId: string): Observable<void> {
    const body: CreateUserBanRequest = { userId };
    return this.http.post<void>(this.baseUrl, body).pipe(
      tap(() => {
        // Optimistically append a stub row so `isBanned()` flips immediately;
        // the full `UserBan` with username lands on the next `fetchInitial()`
        // (we refetch below to stay authoritative).
        this.blocks.update((list) =>
          list.some((b) => b.userId === userId)
            ? list
            : [{ userId, username: '', createdAt: new Date().toISOString() }, ...list],
        );
        // The ban transaction on the server atomically severs any existing
        // friendship and drops pending friend-requests — but `friend:removed`
        // only fires to the VICTIM (per contract). The blocker does not get
        // a self-event, so we mirror the deletion locally to keep the
        // friend list / outgoing-request list in sync.
        this.friendsService.handleBlockSideEffects(userId);
        // Refresh in the background so the "Blocked users" dialog has usernames.
        this.fetchInitial().subscribe({ error: () => undefined });
      }),
    );
  }

  unblock(userId: string): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/${userId}`).pipe(
      tap(() => {
        this.blocks.update((list) => list.filter((b) => b.userId !== userId));
      }),
    );
  }

  /**
   * Retroactive freeze path: the DM composer's `message:send` ack came back
   * `"Personal messaging is blocked"`, so we learn the peer banned us without
   * a prior `user:ban:applied` event (happens when the ban landed while the
   * caller was offline).
   */
  markIncoming(userId: string): void {
    this.incomingBans.update((set) => {
      if (set.has(userId)) return set;
      const next = new Set(set);
      next.add(userId);
      return next;
    });
  }

  /** Clear all state — invoked from `AuthService.clearSession()`. */
  reset(): void {
    this.blocks.set([]);
    this.incomingBans.set(new Set());
  }
}
