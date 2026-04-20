import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import {
  ReactiveFormsModule,
  FormBuilder,
  Validators,
  AbstractControl,
  ValidationErrors,
} from '@angular/forms';
import { Router, RouterLink, ActivatedRoute } from '@angular/router';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { HttpErrorResponse } from '@angular/common/http';
import { AuthService } from '../../core/auth/auth.service';

function passwordsMatch(group: AbstractControl): ValidationErrors | null {
  const password = group.get('newPassword')?.value;
  const confirm = group.get('confirmPassword')?.value;
  return password && confirm && password !== confirm ? { passwordMismatch: true } : null;
}

@Component({
  selector: 'app-reset-password',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    RouterLink,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatProgressSpinnerModule,
    MatSnackBarModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './reset-password.component.html',
  styleUrl: './reset-password.component.scss',
})
export class ResetPasswordComponent {
  private readonly fb = inject(FormBuilder);
  private readonly authService = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly snackBar = inject(MatSnackBar);

  readonly submitting = signal(false);
  readonly serverError = signal<string | null>(null);

  private readonly resetToken = this.route.snapshot.queryParamMap.get('token') ?? '';

  readonly form = this.fb.group(
    {
      newPassword: this.fb.control('', [Validators.required, Validators.minLength(8)]),
      confirmPassword: this.fb.control('', [Validators.required]),
    },
    { validators: passwordsMatch },
  );

  onSubmit(): void {
    if (this.form.invalid || this.submitting()) return;
    if (!this.resetToken) {
      this.serverError.set('Invalid or missing reset token. Please request a new link.');
      return;
    }

    this.serverError.set(null);
    this.submitting.set(true);
    this.form.disable();

    const { newPassword } = this.form.getRawValue();

    this.authService
      .resetPassword({ token: this.resetToken, password: newPassword! })
      .subscribe({
        next: () => {
          this.snackBar.open('Password reset successfully. Please sign in.', 'OK', {
            duration: 5000,
          });
          this.router.navigate(['/login']);
        },
        error: (err: HttpErrorResponse) => {
          this.submitting.set(false);
          this.form.enable();
          if (err.status === 400) {
            this.serverError.set(
              err.error?.error ?? 'Reset token is invalid or has expired.',
            );
          } else {
            this.snackBar.open('An unexpected error occurred. Please try again.', 'Dismiss', {
              duration: 5000,
            });
          }
        },
      });
  }
}
