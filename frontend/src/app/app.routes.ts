import { Routes } from '@angular/router';
import { authGuard } from './core/auth/auth.guard';
import { guestGuard } from './core/auth/guest.guard';

export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    redirectTo: 'login',
  },
  {
    path: 'login',
    loadComponent: () => import('./auth/login/login.component').then((m) => m.LoginComponent),
    canActivate: [guestGuard],
  },
  {
    path: 'register',
    loadComponent: () =>
      import('./auth/register/register.component').then((m) => m.RegisterComponent),
    canActivate: [guestGuard],
  },
  {
    path: 'forgot-password',
    loadComponent: () =>
      import('./auth/forgot-password/forgot-password.component').then(
        (m) => m.ForgotPasswordComponent,
      ),
    canActivate: [guestGuard],
  },
  {
    path: 'reset-password',
    loadComponent: () =>
      import('./auth/reset-password/reset-password.component').then(
        (m) => m.ResetPasswordComponent,
      ),
    canActivate: [guestGuard],
  },
  {
    // Shell wraps all authenticated pages
    path: '',
    loadComponent: () => import('./shell/shell.component').then((m) => m.ShellComponent),
    canActivate: [authGuard],
    children: [
      {
        path: 'chat',
        loadComponent: () =>
          import('./shell/chat-placeholder/chat-placeholder.component').then(
            (m) => m.ChatPlaceholderComponent,
          ),
      },
      {
        path: 'sessions',
        loadComponent: () =>
          import('./sessions/sessions.component').then((m) => m.SessionsComponent),
      },
    ],
  },
  {
    path: 'design-system',
    loadComponent: () =>
      import('./design-system/design-system.component').then((m) => m.DesignSystemComponent),
  },
  {
    path: '**',
    redirectTo: 'login',
  },
];
