import { ChangeDetectionStrategy, Component } from '@angular/core';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';

/**
 * Confirm dialog for the per-message Delete action. Resolves with `true` on
 * confirm, `false` on cancel. The caller wires the resolution into
 * `MessagesService.delete()`.
 *
 * The Delete button uses `color="warn"` — Material maps `warn` onto the M3
 * `error` role token, so the destructive-action styling is inherited from the
 * design system (no hand-picked hex). Kept tiny (no `.html` / `.scss` files)
 * because the dialog is one sentence + two buttons.
 */
@Component({
  selector: 'app-message-delete-dialog',
  standalone: true,
  imports: [MatDialogModule, MatButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title class="text-title-large">Delete this message?</h2>
    <mat-dialog-content>
      <p class="text-body-medium text-on-surface-variant m-0">
        This can't be undone.
      </p>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-stroked-button type="button" [mat-dialog-close]="false">Cancel</button>
      <button mat-flat-button color="warn" type="button" [mat-dialog-close]="true">Delete</button>
    </mat-dialog-actions>
  `,
})
export class MessageDeleteDialogComponent {
  readonly dialogRef!: MatDialogRef<MessageDeleteDialogComponent, boolean>;
}
