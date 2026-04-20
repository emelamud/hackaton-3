import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { AuthService } from '../../core/auth/auth.service';

@Component({
  selector: 'app-forgot-password',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    RouterLink,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatSnackBarModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './forgot-password.component.html',
  styleUrl: './forgot-password.component.scss',
})
export class ForgotPasswordComponent {
  private readonly fb = inject(FormBuilder);
  private readonly authService = inject(AuthService);
  private readonly snackBar = inject(MatSnackBar);

  readonly submitting = signal(false);
  readonly submitted = signal(false);

  readonly form = this.fb.group({
    email: this.fb.control('', [Validators.required, Validators.email]),
  });

  onSubmit(): void {
    if (this.form.invalid || this.submitting()) return;

    this.submitting.set(true);
    this.form.disable();

    const { email } = this.form.getRawValue();

    this.authService.forgotPassword({ email: email! }).subscribe({
      next: () => {
        this.submitting.set(false);
        this.submitted.set(true);
      },
      error: () => {
        this.submitting.set(false);
        this.form.enable();
        this.snackBar.open('An unexpected error occurred. Please try again.', 'Dismiss', {
          duration: 5000,
        });
      },
    });
  }
}
