import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import {
  MAT_DIALOG_DATA,
  MatDialogRef,
  MatDialogModule,
} from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatRadioModule } from '@angular/material/radio';
import { MatTabsModule } from '@angular/material/tabs';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { AuthService } from '../core/auth/auth.service';
import { InvitationsService } from '../core/invitations/invitations.service';
import { RoomsService } from './rooms.service';
import type {
  PatchRoomRequest,
  RoomDetail,
  RoomVisibility,
} from '../../../../shared/types';

export interface ManageRoomDialogData {
  room: RoomDetail;
  /** Optional — open directly on a specific tab. Round 4: 'invitations' | 'settings'. */
  initialTab?: 'invitations' | 'settings';
}

@Component({
  selector: 'app-manage-room-dialog',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatIconModule,
    MatRadioModule,
    MatTabsModule,
    MatProgressSpinnerModule,
    MatSnackBarModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './manage-room-dialog.component.html',
  styleUrl: './manage-room-dialog.component.scss',
})
export class ManageRoomDialogComponent {
  private readonly fb = inject(FormBuilder);
  private readonly roomsService = inject(RoomsService);
  private readonly invitationsService = inject(InvitationsService);
  private readonly authService = inject(AuthService);
  private readonly snackBar = inject(MatSnackBar);
  private readonly dialogRef = inject(MatDialogRef<ManageRoomDialogComponent, RoomDetail | null>);

  readonly data = inject<ManageRoomDialogData>(MAT_DIALOG_DATA);

  /** Signal-wrapped snapshot — updates when the dialog receives a fresh detail. */
  readonly room = signal<RoomDetail>(this.data.room);

  readonly initialTabIndex = this.data.initialTab === 'invitations' ? 0 : this.data.initialTab === 'settings' ? 1 : 0;

  // ------- Role derivation -------
  readonly callerRole = computed(() => {
    const me = this.authService.currentUser();
    if (!me) return null;
    return this.room().members.find((m) => m.userId === me.id)?.role ?? null;
  });
  readonly canEditSettings = computed(() => {
    const role = this.callerRole();
    return role === 'owner' || role === 'admin';
  });

  // ------- Invitations tab state -------
  readonly inviteSubmitting = signal(false);
  readonly inviteSuccessUsername = signal<string | null>(null);

  readonly inviteForm = this.fb.group({
    username: this.fb.control('', [Validators.required, Validators.minLength(1)]),
  });

  // ------- Settings tab state -------
  readonly settingsSubmitting = signal(false);

  readonly settingsForm = this.fb.group({
    name: this.fb.control(this.data.room.name, [
      Validators.required,
      Validators.minLength(3),
      Validators.maxLength(64),
    ]),
    description: this.fb.control(this.data.room.description ?? '', [Validators.maxLength(500)]),
    visibility: this.fb.control<RoomVisibility>(this.data.room.visibility, [Validators.required]),
  });

  constructor() {
    // Disable settings fields up-front for non-owner/admins.
    if (!this.canEditSettings()) {
      this.settingsForm.disable();
    }

    // Reset any 409 nameTaken flag once the user edits the field.
    this.settingsForm.controls.name.valueChanges.subscribe(() => {
      const ctrl = this.settingsForm.controls.name;
      if (ctrl.hasError('nameTaken')) {
        const errors = { ...(ctrl.errors ?? {}) };
        delete errors['nameTaken'];
        ctrl.setErrors(Object.keys(errors).length > 0 ? errors : null);
      }
    });

    // Clear invite server error as soon as the user edits the username.
    this.inviteForm.controls.username.valueChanges.subscribe(() => {
      const ctrl = this.inviteForm.controls.username;
      if (ctrl.hasError('serverError')) {
        const errors = { ...(ctrl.errors ?? {}) };
        delete errors['serverError'];
        ctrl.setErrors(Object.keys(errors).length > 0 ? errors : null);
      }
      if (this.inviteSuccessUsername()) this.inviteSuccessUsername.set(null);
    });
  }

  // ------- Actions -------

  close(): void {
    this.dialogRef.close(null);
  }

  submitInvite(): void {
    if (this.inviteForm.invalid || this.inviteSubmitting()) return;
    const username = (this.inviteForm.controls.username.value ?? '').trim();
    if (!username) {
      this.inviteForm.controls.username.setErrors({ required: true });
      this.inviteForm.controls.username.markAsTouched();
      return;
    }

    this.inviteSubmitting.set(true);
    this.inviteSuccessUsername.set(null);
    this.inviteForm.disable();

    this.invitationsService.createForRoom(this.room().id, { username }).subscribe({
      next: () => {
        this.inviteSubmitting.set(false);
        this.inviteSuccessUsername.set(username);
        this.inviteForm.enable();
        this.inviteForm.reset({ username: '' });
        this.inviteForm.controls.username.markAsPristine();
        this.inviteForm.controls.username.markAsUntouched();
      },
      error: (err: HttpErrorResponse) => {
        this.inviteSubmitting.set(false);
        this.inviteForm.enable();
        const serverMsg = err.error?.error ?? 'Failed to send invitation.';
        // Mirror the Round-2 409 pattern — set control error + render under the field.
        const ctrl = this.inviteForm.controls.username;
        ctrl.setErrors({ serverError: serverMsg });
        ctrl.markAsTouched();
      },
    });
  }

  submitSettings(): void {
    if (!this.canEditSettings()) return;
    if (this.settingsForm.invalid || this.settingsSubmitting() || !this.settingsForm.dirty) {
      return;
    }

    const body = this.buildPatchBody();
    if (!body) {
      // Nothing actually changed — close silently.
      this.dialogRef.close(null);
      return;
    }

    this.settingsSubmitting.set(true);
    this.settingsForm.disable();

    this.roomsService.patch(this.room().id, body).subscribe({
      next: (detail) => {
        this.settingsSubmitting.set(false);
        this.dialogRef.close(detail);
      },
      error: (err: HttpErrorResponse) => {
        this.settingsSubmitting.set(false);
        this.settingsForm.enable();
        if (err.status === 409) {
          const msg = err.error?.error ?? 'Room name already taken';
          this.settingsForm.controls.name.setErrors({ nameTaken: msg });
          this.settingsForm.controls.name.markAsTouched();
        } else if (err.status === 403) {
          this.snackBar.open(
            err.error?.error ?? 'Only room owners and admins can edit room settings',
            'Dismiss',
            { duration: 5000 },
          );
        } else if (err.status === 400) {
          this.snackBar.open(
            err.error?.error ?? 'Please check the form and try again.',
            'Dismiss',
            { duration: 5000 },
          );
        } else {
          this.snackBar.open('Failed to save room settings. Please try again.', 'Dismiss', {
            duration: 5000,
          });
        }
      },
    });
  }

  /** Returns `null` if nothing changed. Maps an empty description to explicit `null`. */
  private buildPatchBody(): PatchRoomRequest | null {
    const raw = this.settingsForm.getRawValue();
    const current = this.room();
    const body: PatchRoomRequest = {};

    const nextName = (raw.name ?? '').trim();
    if (nextName && nextName.toLowerCase() !== current.name.toLowerCase()) {
      body.name = nextName;
    } else if (nextName && nextName !== current.name) {
      // Same name, different casing — the server treats this as a no-op but we
      // still let it through so the user sees the change they made.
      body.name = nextName;
    }

    const nextDescription = (raw.description ?? '').trim();
    const curDescription = current.description ?? '';
    if (nextDescription !== curDescription) {
      body.description = nextDescription === '' ? null : nextDescription;
    }

    if (raw.visibility && raw.visibility !== current.visibility) {
      body.visibility = raw.visibility;
    }

    return Object.keys(body).length === 0 ? null : body;
  }

  /** For template use — renders the correct server-error string when present. */
  nameServerError(): string | null {
    const err = this.settingsForm.controls.name.errors?.['nameTaken'];
    return typeof err === 'string' ? err : err ? 'Room name already taken' : null;
  }

  inviteServerError(): string | null {
    const err = this.inviteForm.controls.username.errors?.['serverError'];
    return typeof err === 'string' ? err : null;
  }
}
