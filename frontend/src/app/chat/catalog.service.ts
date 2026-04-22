import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import type { PublicCatalogResponse } from '@shared';

/**
 * Thin HTTP wrapper around `GET /api/rooms/catalog`.
 *
 * No local caching — the catalog is a live search page; the page component
 * owns its own accumulated list of rows and passes `cursor` back for
 * subsequent pages.
 */
@Injectable({ providedIn: 'root' })
export class CatalogService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.apiUrl}/rooms/catalog`;

  list(
    options: { q?: string; cursor?: string; limit?: number } = {},
  ): Observable<PublicCatalogResponse> {
    let params = new HttpParams();
    if (options.q && options.q.length > 0) params = params.set('q', options.q);
    if (options.cursor) params = params.set('cursor', options.cursor);
    if (options.limit != null) params = params.set('limit', String(options.limit));
    return this.http.get<PublicCatalogResponse>(this.baseUrl, { params });
  }
}
