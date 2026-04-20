import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { DatePipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import type { Invitation } from '../../../../../shared/types';

/**
 * Dumb presentation row used inside the top-nav invitations dropdown.
 * Parent wires `(accept)` / `(reject)` to `InvitationsService` calls.
 */
@Component({
  selector: 'app-invitation-item',
  standalone: true,
  imports: [DatePipe, MatButtonModule, MatIconModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './invitation-item.component.html',
  styleUrl: './invitation-item.component.scss',
})
export class InvitationItemComponent {
  @Input({ required: true }) invitation!: Invitation;
  @Input() busy = false;

  @Output() readonly accept = new EventEmitter<Invitation>();
  @Output() readonly reject = new EventEmitter<Invitation>();

  onAccept(event: Event): void {
    event.stopPropagation();
    this.accept.emit(this.invitation);
  }

  onReject(event: Event): void {
    event.stopPropagation();
    this.reject.emit(this.invitation);
  }
}
