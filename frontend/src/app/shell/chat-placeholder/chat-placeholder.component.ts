import { ChangeDetectionStrategy, Component } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';

@Component({
  selector: 'app-chat-placeholder',
  standalone: true,
  imports: [MatIconModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="placeholder gap-4 p-7">
      <mat-icon class="placeholder__icon text-on-surface-variant">forum</mat-icon>
      <h2 class="text-title-medium m-0">Welcome to ChatApp</h2>
      <p class="text-body-medium text-on-surface-variant m-0">
        Select a channel or start a conversation to begin chatting.
      </p>
    </div>
  `,
  styles: [
    `
      .placeholder {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        height: 100%;
        text-align: center;
      }

      .placeholder__icon {
        font-size: 4rem;
        width: 4rem;
        height: 4rem;
      }
    `,
  ],
})
export class ChatPlaceholderComponent {}
