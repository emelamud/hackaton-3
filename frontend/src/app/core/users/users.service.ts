import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import type { UserSearchResult } from '@shared';

/**
 * Minimal HTTP wrapper for the user-search endpoint.
 *
 * Search is a one-shot query triggered by the Add Friend dialog, so the
 * service holds no reactive state — callers own debouncing and result caching.
 */
@Injectable({ providedIn: 'root' })
export class UsersService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.apiUrl}/users`;

  /**
   * `q` is the username prefix. Caller is responsible for enforcing the
   * minimum 2-character length — the backend returns 400 under that bound.
   */
  search(q: string): Observable<UserSearchResult[]> {
    const params = new HttpParams().set('q', q);
    return this.http.get<UserSearchResult[]>(`${this.baseUrl}/search`, { params });
  }
}
