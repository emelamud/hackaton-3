import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatListModule } from '@angular/material/list';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ChatContextService } from './chat-context.service';
import type { RoomMember } from '../../../../shared/types';

@Component({
  selector: 'app-room-rail',
  standalone: true,
  imports: [MatIconModule, MatButtonModule, MatListModule, MatTooltipModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './room-rail.component.html',
  styleUrl: './room-rail.component.scss',
})
export class RoomRailComponent {
  private readonly chatContext = inject(ChatContextService);

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
}
