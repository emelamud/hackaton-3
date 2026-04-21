import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import {
  MAT_DIALOG_DATA,
  MatDialogRef,
  MatDialogModule,
} from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';

export interface BlockUserDialogData {
  username: string;
}

/**
 * Confirm dialog for blocking a user. Resolves with `true` on confirm, `false`
 * on cancel. The caller wires the resolution into `UserBansService.block()`.
 *
 * Separate from `RemoveFriendDialogComponent` because the language differs
 * substantially ("they can no longer message you" vs "you can add them again
 * later") and because a shared confirm dialog is a deferred cleanup item
 * (see `Config improvements` in the round summary).
 */
@Component({
  selector: 'app-block-user-dialog',
  standalone: true,
  imports: [MatDialogModule, MatButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title class="text-title-large">Block &#64;{{ data.username }}?</h2>
    <mat-dialog-content>
      <p class="text-body-medium text-on-surface-variant m-0">
        They will no longer be able to message you. Any existing friendship and pending friend requests between you will be removed. You can unblock them later from the profile menu.
      </p>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-stroked-button type="button" [mat-dialog-close]="false">Cancel</button>
      <button mat-flat-button color="warn" type="button" [mat-dialog-close]="true">Block</button>
    </mat-dialog-actions>
  `,
})
export class BlockUserDialogComponent {
  readonly data = inject<BlockUserDialogData>(MAT_DIALOG_DATA);
  readonly dialogRef = inject(MatDialogRef<BlockUserDialogComponent, boolean>);
}
