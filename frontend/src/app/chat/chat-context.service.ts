import { Injectable, signal } from '@angular/core';
import type { RoomDetail } from '../../../../shared/types';

/**
 * Shares the currently-open room between `RoomViewComponent` (writer)
 * and `RoomRailComponent` (reader) without a second HTTP call.
 *
 * `RoomViewComponent` calls `setCurrentRoom()` after loading the detail
 * and `clear()` on destroy. `RoomRailComponent` reads `currentRoom()`.
 */
@Injectable({ providedIn: 'root' })
export class ChatContextService {
  readonly currentRoom = signal<RoomDetail | null>(null);

  setCurrentRoom(room: RoomDetail): void {
    this.currentRoom.set(room);
  }

  clear(): void {
    this.currentRoom.set(null);
  }
}
