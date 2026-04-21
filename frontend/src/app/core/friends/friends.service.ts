import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, forkJoin, map, tap } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { environment } from '../../../environments/environment';
import { SocketService } from '../socket/socket.service';
import type { Friend, FriendRequest, CreateFriendRequestBody } from '@shared';

/**
 * App-wide cache of the current user's friends + pending friend requests.
 *
 * Seeded by `AuthService.login()` / `register()` / silent `refresh()` via
 * `fetchInitial()`, cleared on `logout()`. Kept live via five socket
 * subscriptions wired in the constructor:
 *   - `friend:request:new` — prepend to `incomingRequests`.
 *   - `friend:request:cancelled` — drop from `incomingRequests` by id.
 *   - `friend:request:rejected` — drop from `outgoingRequests` by id.
 *   - `friend:request:accepted` — drop from whichever pending list held the
 *     id, prepend `payload.friend` to `friends` (dedupe by userId).
 *   - `friend:removed` — drop from `friends` by userId.
 *
 * Round 4 fixed the `SocketService.on()` pre-connect trap so subscribing in
 * the constructor is safe even though this service is constructed before
 * `SocketService.connect()` is called.
 */
@Injectable({ providedIn: 'root' })
export class FriendsService {
  private readonly http = inject(HttpClient);
  private readonly socketService = inject(SocketService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly friendsUrl = `${environment.apiUrl}/friends`;
  private readonly requestsUrl = `${environment.apiUrl}/friend-requests`;

  readonly friends = signal<Friend[]>([]);
  readonly incomingRequests = signal<FriendRequest[]>([]);
  readonly outgoingRequests = signal<FriendRequest[]>([]);

  readonly incomingCount = computed(() => this.incomingRequests().length);
  readonly outgoingCount = computed(() => this.outgoingRequests().length);
  readonly friendCount = computed(() => this.friends().length);

  constructor() {
    this.socketService
      .on('friend:request:new')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((request) => {
        this.incomingRequests.update((list) =>
          list.some((r) => r.id === request.id) ? list : [request, ...list],
        );
      });

    this.socketService
      .on('friend:request:cancelled')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((payload) => {
        this.incomingRequests.update((list) =>
          list.filter((r) => r.id !== payload.requestId),
        );
      });

    this.socketService
      .on('friend:request:rejected')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((payload) => {
        this.outgoingRequests.update((list) =>
          list.filter((r) => r.id !== payload.requestId),
        );
      });

    this.socketService
      .on('friend:request:accepted')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((payload) => {
        // The event fires to BOTH sides — drop by id from whichever list held it.
        this.incomingRequests.update((list) =>
          list.filter((r) => r.id !== payload.requestId),
        );
        this.outgoingRequests.update((list) =>
          list.filter((r) => r.id !== payload.requestId),
        );
        // Dedupe by userId (the accept API also prepends — this is belt-and-suspenders).
        this.friends.update((list) =>
          list.some((f) => f.userId === payload.friend.userId)
            ? list
            : [payload.friend, ...list],
        );
      });

    this.socketService
      .on('friend:removed')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((payload) => {
        this.friends.update((list) => list.filter((f) => f.userId !== payload.userId));
      });
  }

  /** Seed the three lists after login / register / silent refresh. */
  fetchInitial(): Observable<void> {
    return forkJoin({
      friends: this.http.get<Friend[]>(this.friendsUrl),
      incoming: this.http.get<FriendRequest[]>(`${this.requestsUrl}/incoming`),
      outgoing: this.http.get<FriendRequest[]>(`${this.requestsUrl}/outgoing`),
    }).pipe(
      tap(({ friends, incoming, outgoing }) => {
        this.friends.set(friends);
        this.incomingRequests.set(incoming);
        this.outgoingRequests.set(outgoing);
      }),
      map(() => undefined),
    );
  }

  sendRequest(body: CreateFriendRequestBody): Observable<FriendRequest> {
    return this.http.post<FriendRequest>(this.requestsUrl, body).pipe(
      tap((request) => {
        // Optimistically append to outgoing so the Add Friend dialog and the
        // sidebar summary reflect it even before the server-side socket fires.
        this.outgoingRequests.update((list) =>
          list.some((r) => r.id === request.id) ? list : [request, ...list],
        );
      }),
    );
  }

  acceptRequest(id: string): Observable<Friend> {
    return this.http.post<Friend>(`${this.requestsUrl}/${id}/accept`, {}).pipe(
      tap((friend) => {
        // Drop from incoming immediately + prepend to friends. The
        // friend:request:accepted socket event will also fire back to this
        // user but the dedupe guards above keep state consistent.
        this.incomingRequests.update((list) => list.filter((r) => r.id !== id));
        this.friends.update((list) =>
          list.some((f) => f.userId === friend.userId) ? list : [friend, ...list],
        );
      }),
    );
  }

  rejectRequest(id: string): Observable<void> {
    return this.http.post<void>(`${this.requestsUrl}/${id}/reject`, {}).pipe(
      tap(() => {
        this.incomingRequests.update((list) => list.filter((r) => r.id !== id));
      }),
    );
  }

  cancelRequest(id: string): Observable<void> {
    return this.http.delete<void>(`${this.requestsUrl}/${id}`).pipe(
      tap(() => {
        this.outgoingRequests.update((list) => list.filter((r) => r.id !== id));
      }),
    );
  }

  removeFriend(userId: string): Observable<void> {
    return this.http.delete<void>(`${this.friendsUrl}/${userId}`).pipe(
      tap(() => {
        this.friends.update((list) => list.filter((f) => f.userId !== userId));
      }),
    );
  }

  /** Clear all state — invoked from `AuthService.clearSession()`. */
  reset(): void {
    this.friends.set([]);
    this.incomingRequests.set([]);
    this.outgoingRequests.set([]);
  }

  /**
   * Mirror the server-side ban side effects locally for the BLOCKER's tabs.
   *
   * `POST /api/user-bans` atomically severs any friendship and cancels any
   * pending friend requests between the two users. The server emits
   * `friend:removed` to the victim only, so the blocker's own tabs never
   * receive a matching socket event. This helper drops the matching rows
   * locally so the blocker's sidebar and outgoing-pending list stay in sync
   * without a full refetch.
   *
   * Called from `UserBansService.block()` — it's a cross-service concern so
   * we expose a named method rather than having `UserBansService` reach into
   * the private signals.
   */
  handleBlockSideEffects(userId: string): void {
    this.friends.update((list) => list.filter((f) => f.userId !== userId));
    this.outgoingRequests.update((list) =>
      list.filter((r) => r.toUserId !== userId),
    );
    this.incomingRequests.update((list) =>
      list.filter((r) => r.fromUserId !== userId),
    );
  }
}
