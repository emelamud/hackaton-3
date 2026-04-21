import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, tap } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { environment } from '../../../environments/environment';
import { SocketService } from '../socket/socket.service';
import type { Invitation, CreateInvitationRequest, RoomDetail } from '@shared';

/**
 * App-wide cache of the current user's pending invitations.
 *
 * Seeded by `AuthService.login()` / `register()` / silent `refresh()` via
 * `fetchInitial()`, cleared on `logout()`. Kept live via two socket
 * subscriptions wired in the constructor:
 *   - `invitation:new` — prepend (skip if id already present).
 *   - `invitation:revoked` — drop by id.
 *
 * The top-nav badge reads `pendingCount()`, the dropdown reads `pending()`.
 */
@Injectable({ providedIn: 'root' })
export class InvitationsService {
  private readonly http = inject(HttpClient);
  private readonly socketService = inject(SocketService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly baseUrl = `${environment.apiUrl}/invitations`;
  private readonly roomsBaseUrl = `${environment.apiUrl}/rooms`;

  readonly pending = signal<Invitation[]>([]);
  readonly pendingCount = computed(() => this.pending().length);

  constructor() {
    // Cold observables — subscriptions are attached for the app lifetime.
    this.socketService
      .on('invitation:new')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((invite) => {
        this.pending.update((list) =>
          list.some((i) => i.id === invite.id) ? list : [invite, ...list],
        );
      });

    this.socketService
      .on('invitation:revoked')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((payload) => {
        this.pending.update((list) => list.filter((i) => i.id !== payload.invitationId));
      });
  }

  /** Seed the pending list after login / register / silent refresh. */
  fetchInitial(): Observable<Invitation[]> {
    return this.http.get<Invitation[]>(this.baseUrl).pipe(
      tap((list) => this.pending.set(list)),
    );
  }

  accept(invitationId: string): Observable<RoomDetail> {
    return this.http
      .post<RoomDetail>(`${this.baseUrl}/${invitationId}/accept`, {})
      .pipe(tap(() => this.dropById(invitationId)));
  }

  reject(invitationId: string): Observable<void> {
    return this.http
      .post<void>(`${this.baseUrl}/${invitationId}/reject`, {})
      .pipe(tap(() => this.dropById(invitationId)));
  }

  /** Revoke (inviter only). Used from Manage Room if/when sent-invites list lands. */
  revoke(invitationId: string): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/${invitationId}`);
  }

  /** Create an invitation to a room. Exposed here so the Manage Room dialog has a single entry point. */
  createForRoom(roomId: string, body: CreateInvitationRequest): Observable<Invitation> {
    return this.http.post<Invitation>(`${this.roomsBaseUrl}/${roomId}/invitations`, body);
  }

  private dropById(invitationId: string): void {
    this.pending.update((list) => list.filter((i) => i.id !== invitationId));
  }
}
