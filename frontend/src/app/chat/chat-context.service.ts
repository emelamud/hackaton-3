import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SocketService } from '../core/socket/socket.service';
import type { RoomDetail } from '../../../../shared/types';

/**
 * Shares the currently-open room between `RoomViewComponent` (writer)
 * and `RoomRailComponent` (reader) without a second HTTP call.
 *
 * `RoomViewComponent` calls `setCurrentRoom()` after loading the detail
 * and `clear()` on destroy. `RoomRailComponent` reads `currentRoom()`.
 *
 * Round 4: also subscribes to `room:updated` and refreshes `currentRoom()`
 * in-place when the open room's detail changes server-side (PATCH, invite
 * accept). Sidebar updates are handled independently by `RoomsService`.
 */
@Injectable({ providedIn: 'root' })
export class ChatContextService {
  private readonly socketService = inject(SocketService);
  private readonly destroyRef = inject(DestroyRef);

  readonly currentRoom = signal<RoomDetail | null>(null);

  constructor() {
    this.socketService
      .on<RoomDetail>('room:updated')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((detail) => {
        const open = this.currentRoom();
        if (open && open.id === detail.id) {
          this.currentRoom.set(detail);
        }
      });
  }

  setCurrentRoom(room: RoomDetail): void {
    this.currentRoom.set(room);
  }

  clear(): void {
    this.currentRoom.set(null);
  }
}
