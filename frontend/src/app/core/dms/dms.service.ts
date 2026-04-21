import { DestroyRef, Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, tap } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { environment } from '../../../environments/environment';
import { SocketService } from '../socket/socket.service';
import { RoomsService } from '../../chat/rooms.service';
import type { OpenDmRequest, RoomDetail } from '@shared';

/**
 * Thin wrapper around `POST /api/dm` plus a `dm:created` socket subscription
 * that keeps `RoomsService.roomsSignal` in sync.
 *
 * Eagerly constructed so the `dm:created` subscription is active before the
 * first DM arrives — `AuthService` injects this service in its constructor.
 */
@Injectable({ providedIn: 'root' })
export class DmsService {
  private readonly http = inject(HttpClient);
  private readonly roomsService = inject(RoomsService);
  private readonly socketService = inject(SocketService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly baseUrl = `${environment.apiUrl}/dm`;

  constructor() {
    this.socketService
      .on('dm:created')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((room) => this.roomsService.upsertRoom(room));
  }

  /**
   * Upsert DM with the target user. Returns the `RoomDetail`; caller navigates
   * to `/chat/:id` on success. The first-time create path emits `dm:created`
   * to both participants' tabs; the idempotent re-hit does not — so we
   * optimistically merge into the rooms signal here too for instant UX.
   */
  openDm(toUserId: string): Observable<RoomDetail> {
    const body: OpenDmRequest = { toUserId };
    return this.http.post<RoomDetail>(this.baseUrl, body).pipe(
      tap((room) => this.roomsService.upsertRoom(room)),
    );
  }
}
