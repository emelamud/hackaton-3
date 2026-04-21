import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import {
  MAT_DIALOG_DATA,
  MatDialogRef,
  MatDialogModule,
} from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';

export interface RemoveFriendDialogData {
  username: string;
}

@Component({
  selector: 'app-remove-friend-dialog',
  standalone: true,
  imports: [MatDialogModule, MatButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title class="text-title-large">Remove &#64;{{ data.username }}?</h2>
    <mat-dialog-content>
      <p class="text-body-medium text-on-surface-variant m-0">
        They will be removed from your friends list. You can add them again later.
      </p>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-stroked-button type="button" [mat-dialog-close]="false">Cancel</button>
      <button mat-flat-button color="warn" type="button" [mat-dialog-close]="true">Remove</button>
    </mat-dialog-actions>
  `,
})
export class RemoveFriendDialogComponent {
  readonly data = inject<RemoveFriendDialogData>(MAT_DIALOG_DATA);
  readonly dialogRef = inject(MatDialogRef<RemoveFriendDialogComponent, boolean>);
}
