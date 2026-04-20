import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  OnDestroy,
  signal,
  ViewChild,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpErrorResponse } from '@angular/common/http';
import { switchMap } from 'rxjs';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatButtonModule } from '@angular/material/button';
import { RoomsService } from './rooms.service';
import { ChatContextService } from './chat-context.service';
import { MessageListComponent } from './message-list.component';
import { MessageComposerComponent } from './message-composer.component';
import type { Message, RoomDetail } from '../../../../shared/types';

@Component({
  selector: 'app-room-view',
  standalone: true,
  imports: [
    MatIconModule,
    MatProgressSpinnerModule,
    MatSnackBarModule,
    MatButtonModule,
    MessageListComponent,
    MessageComposerComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './room-view.component.html',
  styleUrl: './room-view.component.scss',
})
export class RoomViewComponent implements OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly roomsService = inject(RoomsService);
  private readonly chatContext = inject(ChatContextService);
  private readonly snackBar = inject(MatSnackBar);
  private readonly destroyRef = inject(DestroyRef);

  readonly loading = signal(false);
  readonly loadError = signal(false);
  readonly room = signal<RoomDetail | null>(null);

  @ViewChild(MessageListComponent) messageList?: MessageListComponent;

  constructor() {
    this.route.paramMap
      .pipe(
        switchMap((params) => {
          const id = params.get('roomId')!;
          this.loading.set(true);
          this.loadError.set(false);
          this.room.set(null);
          this.chatContext.clear();
          return this.roomsService.get(id);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (detail) => {
          this.room.set(detail);
          this.chatContext.setCurrentRoom(detail);
          this.loading.set(false);
        },
        error: (err: HttpErrorResponse) => {
          this.loading.set(false);
          this.loadError.set(true);
          if (err.status === 403) {
            this.snackBar.open("You don't have access to this room.", 'Dismiss', {
              duration: 5000,
            });
            this.router.navigate(['/chat']);
          } else if (err.status === 404) {
            this.snackBar.open('Room not found.', 'Dismiss', { duration: 5000 });
            this.router.navigate(['/chat']);
          } else if (err.status !== 401) {
            // 401 is handled by the interceptor (refresh + retry / logout).
            this.snackBar.open('Failed to load room. Please try again.', 'Dismiss', {
              duration: 5000,
            });
          }
        },
      });
  }

  /**
   * Forward the composer's ack result straight into the list.
   * The server broadcast excludes the sender socket, so this is how the
   * sender sees their own message.
   */
  onMessageSent(message: Message): void {
    this.messageList?.appendMessage(message);
  }

  ngOnDestroy(): void {
    this.chatContext.clear();
  }
}
