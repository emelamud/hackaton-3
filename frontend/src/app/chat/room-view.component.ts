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
import { SocketService } from '../core/socket/socket.service';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatButtonModule } from '@angular/material/button';
import { MatMenuModule } from '@angular/material/menu';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { RoomsService } from './rooms.service';
import { ChatContextService } from './chat-context.service';
import { MessageListComponent } from './message-list.component';
import { MessageComposerComponent } from './message-composer.component';
import { UserBansService } from '../core/user-bans/user-bans.service';
import { UnreadService } from '../core/unread/unread.service';
import {
  BlockUserDialogComponent,
  type BlockUserDialogData,
} from '../core/user-bans/block-user-dialog.component';
import { PresenceDotComponent } from '../shared/presence-dot.component';
import type { Message, RoomDetail } from '@shared';

@Component({
  selector: 'app-room-view',
  standalone: true,
  imports: [
    MatIconModule,
    MatProgressSpinnerModule,
    MatSnackBarModule,
    MatButtonModule,
    MatMenuModule,
    MatDialogModule,
    MessageListComponent,
    MessageComposerComponent,
    PresenceDotComponent,
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
  private readonly socketService = inject(SocketService);
  private readonly snackBar = inject(MatSnackBar);
  private readonly destroyRef = inject(DestroyRef);
  private readonly userBansService = inject(UserBansService);
  private readonly unreadService = inject(UnreadService);
  private readonly dialog = inject(MatDialog);

  readonly loading = signal(false);
  readonly loadError = signal(false);
  readonly room = signal<RoomDetail | null>(null);

  @ViewChild(MessageListComponent) messageList?: MessageListComponent;

  constructor() {
    // Round 12: `paramMap` is an observable stream, so this fires both on
    // first enter AND on `/chat/<A>` → `/chat/<B>` swaps where Angular reuses
    // the RoomViewComponent instance (same route, new param). `setActiveRoom`
    // follows the latest id; `UnreadService` debounces the accompanying
    // mark-read POST so rapid swaps don't spam the server.
    this.route.paramMap
      .pipe(
        switchMap((params) => {
          const id = params.get('roomId')!;
          this.loading.set(true);
          this.loadError.set(false);
          this.room.set(null);
          this.chatContext.clear();
          this.unreadService.setActiveRoom(id);
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

    // Round 12: listen for live `message:new` events for the currently-open
    // room and re-mark it read. `MessageListComponent` handles its own append
    // subscription independently; this subscription is a side-effect only
    // (no append). `UnreadService.onLiveMessageInActiveRoom` debounces the
    // POST internally. Subscribe to the raw socket stream unfiltered and
    // gate on `this.room().id` at emission time so room-swaps don't leak
    // stale mark-read calls.
    this.socketService
      .on('message:new')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((msg) => {
        const current = this.room();
        if (current && msg.roomId === current.id) {
          this.unreadService.onLiveMessageInActiveRoom(msg.roomId);
        }
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

  /**
   * Block the DM peer via the header overflow. After success we stay on the
   * DM page — the composer freezes and the existing history remains visible.
   */
  blockDmPeer(): void {
    const current = this.room();
    if (!current || current.type !== 'dm' || !current.dmPeer) return;
    const peer = current.dmPeer;
    const data: BlockUserDialogData = { username: peer.username };
    this.dialog
      .open<BlockUserDialogComponent, BlockUserDialogData, boolean>(BlockUserDialogComponent, {
        width: '28rem',
        data,
        autoFocus: 'first-tabbable',
        restoreFocus: true,
      })
      .afterClosed()
      .subscribe((confirmed) => {
        if (!confirmed) return;
        this.userBansService.block(peer.userId).subscribe({
          error: () => {
            this.snackBar.open('Failed to block user. Please try again.', 'Dismiss', {
              duration: 5000,
            });
          },
        });
      });
  }

  ngOnDestroy(): void {
    this.chatContext.clear();
    this.unreadService.setActiveRoom(null);
  }
}
