import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatListModule } from '@angular/material/list';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { ChatContextService } from './chat-context.service';
import {
  ManageRoomDialogComponent,
  type ManageRoomDialogData,
} from './manage-room-dialog.component';
import { PresenceDotComponent } from '../shared/presence-dot.component';
import type { RoomMember } from '@shared';

@Component({
  selector: 'app-room-rail',
  standalone: true,
  imports: [
    MatIconModule,
    MatButtonModule,
    MatListModule,
    MatTooltipModule,
    MatDialogModule,
    PresenceDotComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './room-rail.component.html',
  styleUrl: './room-rail.component.scss',
})
export class RoomRailComponent {
  private readonly chatContext = inject(ChatContextService);
  private readonly dialog = inject(MatDialog);

  readonly room = this.chatContext.currentRoom;

  readonly ownerUsername = computed<string | null>(() => {
    const r = this.room();
    if (!r) return null;
    return r.members.find((m) => m.role === 'owner')?.username ?? null;
  });

  readonly members = computed<RoomMember[]>(() => this.room()?.members ?? []);

  roleLabel(member: RoomMember): string | null {
    if (member.role === 'owner') return 'Owner';
    if (member.role === 'admin') return 'Admin';
    return null;
  }

  openManageDialog(initialTab: 'invitations' | 'settings' = 'settings'): void {
    const r = this.room();
    if (!r) return;
    const data: ManageRoomDialogData = { room: r, initialTab };
    this.dialog.open(ManageRoomDialogComponent, {
      data,
      width: '32rem',
      maxWidth: '95vw',
      autoFocus: 'first-tabbable',
      restoreFocus: true,
    });
  }
}
