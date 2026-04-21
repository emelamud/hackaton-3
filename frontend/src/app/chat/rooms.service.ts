import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, tap } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { environment } from '../../environments/environment';
import { SocketService } from '../core/socket/socket.service';
import type {
  Room,
  RoomDetail,
  CreateRoomRequest,
  PatchRoomRequest,
  Invitation,
  CreateInvitationRequest,
} from '@shared';

@Injectable({ providedIn: 'root' })
export class RoomsService {
  private readonly http = inject(HttpClient);
  private readonly socketService = inject(SocketService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly baseUrl = `${environment.apiUrl}/rooms`;

  /** Cached list of the caller's rooms. Left sidebar subscribes to this. */
  readonly roomsSignal = signal<Room[]>([]);

  constructor() {
    // Keep the sidebar in sync with room edits and invitation-accept broadcasts.
    this.socketService
      .on('room:updated')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((detail) => this.upsertRoom(detail));
  }

  /**
   * Insert the room at the top of the list (newest first) if absent, otherwise
   * replace the existing row in-place. Called from the `room:updated` handler
   * AND from `DmsService` (both the HTTP `openDm()` tap and the `dm:created`
   * socket subscription). The service owns `roomsSignal` — components never
   * mutate it directly.
   */
  upsertRoom(detail: RoomDetail): void {
    const sidebarShape = this.toSidebarShape(detail);
    this.roomsSignal.update((list) => {
      const idx = list.findIndex((r) => r.id === detail.id);
      if (idx === -1) {
        // Not in the list yet — happens on the accepter's first sighting after
        // `invitation:accept`, and on every first-time `dm:created` broadcast.
        return [sidebarShape, ...list];
      }
      const next = list.slice();
      next[idx] = sidebarShape;
      return next;
    });
  }

  list(): Observable<Room[]> {
    return this.http.get<Room[]>(this.baseUrl);
  }

  create(body: CreateRoomRequest): Observable<RoomDetail> {
    return this.http.post<RoomDetail>(this.baseUrl, body);
  }

  get(id: string): Observable<RoomDetail> {
    return this.http.get<RoomDetail>(`${this.baseUrl}/${id}`);
  }

  join(id: string): Observable<RoomDetail> {
    return this.http.post<RoomDetail>(`${this.baseUrl}/${id}/join`, {});
  }

  leave(id: string): Observable<void> {
    return this.http.post<void>(`${this.baseUrl}/${id}/leave`, {});
  }

  /**
   * Edit a room's name/description/visibility. Caller must be owner/admin.
   * The server emits `room:updated` to every member on success — the sidebar
   * and open room view refresh via their socket subscriptions, not from this
   * method's return value.
   */
  patch(id: string, body: PatchRoomRequest): Observable<RoomDetail> {
    return this.http.patch<RoomDetail>(`${this.baseUrl}/${id}`, body);
  }

  /** Invite a user (by username) to a private room. Member-level action. */
  createInvitation(roomId: string, body: CreateInvitationRequest): Observable<Invitation> {
    return this.http.post<Invitation>(`${this.baseUrl}/${roomId}/invitations`, body);
  }

  /** Fetch the room list and push it into the shared signal. */
  refresh(): Observable<Room[]> {
    return this.list().pipe(tap((rooms) => this.roomsSignal.set(rooms)));
  }

  private toSidebarShape(detail: RoomDetail): Room {
    return {
      id: detail.id,
      type: detail.type,
      name: detail.name,
      description: detail.description,
      visibility: detail.visibility,
      ownerId: detail.ownerId,
      createdAt: detail.createdAt,
      memberCount: detail.memberCount,
      dmPeer: detail.dmPeer,
    };
  }
}
