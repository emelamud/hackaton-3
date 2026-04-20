import {
  HttpEvent,
  HttpHandlerFn,
  HttpInterceptorFn,
  HttpRequest,
  HttpErrorResponse,
} from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { Observable, throwError, switchMap, catchError } from 'rxjs';
import { AuthService } from './auth.service';

export const authInterceptor: HttpInterceptorFn = (
  req: HttpRequest<unknown>,
  next: HttpHandlerFn,
): Observable<HttpEvent<unknown>> => {
  const authService = inject(AuthService);
  const router = inject(Router);

  // Only attach token to /api/ requests
  const isApiRequest = req.url.includes('/api/');
  const token = authService.getAccessToken();

  const authReq = isApiRequest
    ? req.clone({
        setHeaders: token ? { Authorization: `Bearer ${token}` } : {},
        withCredentials: true,
      })
    : req;

  return next(authReq).pipe(
    catchError((error: HttpErrorResponse) => {
      // Only handle 401 on /api/ requests (but skip the refresh endpoint itself)
      if (error.status === 401 && isApiRequest && !req.url.includes('/api/auth/refresh')) {
        return authService.refresh().pipe(
          switchMap((res) => {
            if (!res) {
              // Refresh failed — clear session and redirect
              router.navigate(['/login']);
              return throwError(() => error);
            }
            const newToken = authService.getAccessToken();
            const retryReq = newToken
              ? req.clone({ setHeaders: { Authorization: `Bearer ${newToken}` } })
              : req;
            return next(retryReq);
          }),
          catchError(() => {
            router.navigate(['/login']);
            return throwError(() => error);
          }),
        );
      }
      return throwError(() => error);
    }),
  );
};
