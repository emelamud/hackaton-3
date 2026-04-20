import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { MatDialogRef, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatRadioModule } from '@angular/material/radio';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { Router } from '@angular/router';
import { RoomsService } from './rooms.service';
import type { RoomDetail, RoomVisibility } from '../../../../shared/types';

@Component({
  selector: 'app-create-room-dialog',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatRadioModule,
    MatProgressSpinnerModule,
    MatSnackBarModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './create-room-dialog.component.html',
  styleUrl: './create-room-dialog.component.scss',
})
export class CreateRoomDialogComponent {
  private readonly fb = inject(FormBuilder);
  private readonly roomsService = inject(RoomsService);
  private readonly dialogRef = inject(MatDialogRef<CreateRoomDialogComponent, RoomDetail>);
  private readonly router = inject(Router);
  private readonly snackBar = inject(MatSnackBar);

  readonly submitting = signal(false);
  readonly nameServerError = signal<string | null>(null);

  readonly form = this.fb.group({
    name: this.fb.control('', [
      Validators.required,
      Validators.minLength(3),
      Validators.maxLength(64),
    ]),
    description: this.fb.control('', [Validators.maxLength(500)]),
    visibility: this.fb.control<RoomVisibility>('public', [Validators.required]),
  });

  constructor() {
    // Clear the server-side name error as soon as the user edits the name.
    this.form.controls.name.valueChanges.subscribe(() => {
      if (this.nameServerError()) {
        this.nameServerError.set(null);
        // Also clear the control-level flag so Material re-validates cleanly.
        const ctrl = this.form.controls.name;
        if (ctrl.hasError('nameTaken')) {
          const errors = { ...(ctrl.errors ?? {}) };
          delete errors['nameTaken'];
          ctrl.setErrors(Object.keys(errors).length > 0 ? errors : null);
        }
      }
    });
  }

  cancel(): void {
    this.dialogRef.close();
  }

  onSubmit(): void {
    if (this.form.invalid || this.submitting()) return;

    this.nameServerError.set(null);
    this.submitting.set(true);
    this.form.disable();

    const raw = this.form.getRawValue();
    const description = raw.description?.trim() ?? '';
    const payload = {
      name: raw.name!.trim(),
      ...(description ? { description } : {}),
      visibility: raw.visibility!,
    };

    this.roomsService.create(payload).subscribe({
      next: (created) => {
        // Refresh the sidebar list, then navigate and close.
        this.roomsService.refresh().subscribe({
          next: () => {
            this.dialogRef.close(created);
            this.router.navigate(['/chat', created.id]);
          },
          error: () => {
            // Navigate even if refresh failed — the sidebar can retry later.
            this.dialogRef.close(created);
            this.router.navigate(['/chat', created.id]);
          },
        });
      },
      error: (err: HttpErrorResponse) => {
        this.submitting.set(false);
        this.form.enable();
        if (err.status === 409) {
          const msg = err.error?.error ?? 'Room name already taken';
          this.nameServerError.set(msg);
          // Mark the control invalid so Material renders the mat-error block.
          this.form.controls.name.setErrors({ nameTaken: true });
          this.form.controls.name.markAsTouched();
        } else if (err.status === 400) {
          this.snackBar.open(
            err.error?.error ?? 'Please check the form and try again.',
            'Dismiss',
            { duration: 5000 },
          );
        } else {
          this.snackBar.open('Failed to create room. Please try again.', 'Dismiss', {
            duration: 5000,
          });
        }
      },
    });
  }
}
