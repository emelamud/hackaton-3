import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { DatePipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import type { FriendRequest } from '@shared';

/**
 * Dumb presentation row used inside the top-nav friend-requests dropdown.
 * Parent wires `(accept)` / `(reject)` to `FriendsService` calls.
 */
@Component({
  selector: 'app-friend-request-item',
  standalone: true,
  imports: [DatePipe, MatButtonModule, MatIconModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './friend-request-item.component.html',
  styleUrl: './friend-request-item.component.scss',
})
export class FriendRequestItemComponent {
  @Input({ required: true }) request!: FriendRequest;
  @Input() busy = false;

  @Output() readonly accept = new EventEmitter<FriendRequest>();
  @Output() readonly reject = new EventEmitter<FriendRequest>();

  onAccept(event: Event): void {
    event.stopPropagation();
    this.accept.emit(this.request);
  }

  onReject(event: Event): void {
    event.stopPropagation();
    this.reject.emit(this.request);
  }
}
