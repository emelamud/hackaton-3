import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatDialogRef, MatDialogModule } from '@angular/material/dialog';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { UserBansService } from './user-bans.service';

/**
 * List-and-unblock surface opened from the top-nav profile menu.
 * Per-row busy state tracks in-flight unblocks so the button disables
 * while the HTTP call is pending.
 */
@Component({
  selector: 'app-blocked-users-dialog',
  standalone: true,
  imports: [
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatSnackBarModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="blocked-users-dialog__header px-5 pt-4 gap-2">
      <h2 mat-dialog-title class="text-title-large m-0">Blocked users</h2>
      <button
        mat-icon-button
        type="button"
        class="ml-auto"
        aria-label="Close dialog"
        (click)="close()"
      >
        <mat-icon>close</mat-icon>
      </button>
    </header>

    <mat-dialog-content class="blocked-users-dialog__content p-5">
      @if (userBansService.blocks().length === 0) {
        <div class="blocked-users-dialog__empty py-5 gap-2">
          <mat-icon class="text-on-surface-variant">block</mat-icon>
          <p class="text-body-medium text-on-surface-variant m-0">
            You haven't blocked anyone.
          </p>
        </div>
      } @else {
        <ul class="blocked-users-dialog__list">
          @for (ban of userBansService.blocks(); track ban.userId) {
            <li class="blocked-user-row px-3 py-3 gap-3 border-b-outline-variant">
              <span class="blocked-user-row__avatar bg-primary text-on-primary text-label-large">
                {{ (ban.username || '?')[0].toUpperCase() }}
              </span>
              <span class="blocked-user-row__name text-body-medium">
                {{ ban.username || '…' }}
              </span>
              <button
                mat-stroked-button
                type="button"
                class="ml-auto"
                [disabled]="isBusy(ban.userId)"
                (click)="onUnblock(ban.userId)"
              >
                @if (isBusy(ban.userId)) {
                  <mat-progress-spinner diameter="18" mode="indeterminate" />
                } @else {
                  Unblock
                }
              </button>
            </li>
          }
        </ul>
      }
    </mat-dialog-content>

    <mat-dialog-actions align="end" class="px-5 pb-4">
      <button mat-stroked-button type="button" (click)="close()">Close</button>
    </mat-dialog-actions>
  `,
  styles: [
    `
      :host {
        display: block;
      }

      .blocked-users-dialog__header {
        display: flex;
        align-items: center;
      }

      .blocked-users-dialog__content {
        max-height: 60vh;
        overflow-y: auto;
      }

      .blocked-users-dialog__empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
      }

      .blocked-users-dialog__list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
      }

      .blocked-user-row {
        display: flex;
        align-items: center;
        min-width: 0;
      }

      .blocked-user-row__avatar {
        width: 2rem;
        height: 2rem;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        font-weight: 500;
      }

      .blocked-user-row__name {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    `,
  ],
})
export class BlockedUsersDialogComponent {
  protected readonly userBansService = inject(UserBansService);
  private readonly dialogRef = inject(MatDialogRef<BlockedUsersDialogComponent>);
  private readonly snackBar = inject(MatSnackBar);

  readonly busyIds = signal<ReadonlySet<string>>(new Set());

  isBusy(userId: string): boolean {
    return this.busyIds().has(userId);
  }

  onUnblock(userId: string): void {
    if (this.isBusy(userId)) return;
    this.markBusy(userId, true);
    this.userBansService.unblock(userId).subscribe({
      next: () => this.markBusy(userId, false),
      error: () => {
        this.markBusy(userId, false);
        this.snackBar.open('Failed to unblock. Please try again.', 'Dismiss', {
          duration: 5000,
        });
      },
    });
  }

  close(): void {
    this.dialogRef.close();
  }

  private markBusy(userId: string, busy: boolean): void {
    this.busyIds.update((set) => {
      const next = new Set(set);
      if (busy) next.add(userId);
      else next.delete(userId);
      return next;
    });
  }
}
