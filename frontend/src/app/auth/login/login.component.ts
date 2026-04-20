import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { Router, RouterLink, ActivatedRoute } from '@angular/router';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { HttpErrorResponse } from '@angular/common/http';
import { AuthService } from '../../core/auth/auth.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    RouterLink,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatCheckboxModule,
    MatProgressSpinnerModule,
    MatSnackBarModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './login.component.html',
  styleUrl: './login.component.scss',
})
export class LoginComponent {
  private readonly fb = inject(FormBuilder);
  private readonly authService = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly snackBar = inject(MatSnackBar);

  readonly submitting = signal(false);
  readonly serverError = signal<string | null>(null);

  readonly form = this.fb.group({
    email: this.fb.control('', [Validators.required, Validators.email]),
    password: this.fb.control('', [Validators.required]),
    keepSignedIn: this.fb.control(false),
  });

  onSubmit(): void {
    if (this.form.invalid || this.submitting()) return;

    this.serverError.set(null);
    this.submitting.set(true);
    this.form.disable();

    const { email, password, keepSignedIn } = this.form.getRawValue();

    this.authService
      .login({ email: email!, password: password!, keepSignedIn: keepSignedIn ?? false })
      .subscribe({
        next: () => {
          const returnUrl =
            this.route.snapshot.queryParamMap.get('returnUrl') ?? '/chat';
          this.router.navigateByUrl(returnUrl);
        },
        error: (err: HttpErrorResponse) => {
          this.submitting.set(false);
          this.form.enable();
          if (err.status === 401) {
            this.serverError.set(err.error?.error ?? 'Invalid email or password.');
          } else {
            this.snackBar.open('An unexpected error occurred. Please try again.', 'Dismiss', {
              duration: 5000,
            });
          }
        },
      });
  }
}
