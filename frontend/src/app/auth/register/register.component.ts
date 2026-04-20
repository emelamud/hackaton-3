import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import {
  ReactiveFormsModule,
  FormBuilder,
  Validators,
  AbstractControl,
  ValidationErrors,
} from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { HttpErrorResponse } from '@angular/common/http';
import { AuthService } from '../../core/auth/auth.service';

function passwordsMatch(group: AbstractControl): ValidationErrors | null {
  const password = group.get('password')?.value;
  const confirm = group.get('confirmPassword')?.value;
  return password && confirm && password !== confirm ? { passwordMismatch: true } : null;
}

@Component({
  selector: 'app-register',
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
  templateUrl: './register.component.html',
  styleUrl: './register.component.scss',
})
export class RegisterComponent {
  private readonly fb = inject(FormBuilder);
  private readonly authService = inject(AuthService);
  private readonly router = inject(Router);
  private readonly snackBar = inject(MatSnackBar);

  readonly submitting = signal(false);
  readonly serverError = signal<string | null>(null);

  readonly form = this.fb.group(
    {
      email: this.fb.control('', [Validators.required, Validators.email]),
      username: this.fb.control('', [Validators.required, Validators.minLength(3)]),
      password: this.fb.control('', [Validators.required, Validators.minLength(8)]),
      confirmPassword: this.fb.control('', [Validators.required]),
    },
    { validators: passwordsMatch },
  );

  onSubmit(): void {
    if (this.form.invalid || this.submitting()) return;

    this.serverError.set(null);
    this.submitting.set(true);
    this.form.disable();

    const { email, username, password } = this.form.getRawValue();

    this.authService
      .register({ email: email!, username: username!, password: password! })
      .subscribe({
        next: () => {
          this.router.navigate(['/chat']);
        },
        error: (err: HttpErrorResponse) => {
          this.submitting.set(false);
          this.form.enable();
          if (err.status === 409) {
            this.serverError.set(err.error?.error ?? 'Email or username is already taken.');
          } else if (err.status === 400) {
            this.serverError.set(err.error?.error ?? 'Validation failed. Check your input.');
          } else {
            this.snackBar.open('An unexpected error occurred. Please try again.', 'Dismiss', {
              duration: 5000,
            });
          }
        },
      });
  }
}
