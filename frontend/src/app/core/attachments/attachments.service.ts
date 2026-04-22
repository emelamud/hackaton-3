import { Injectable, Signal, inject, signal } from '@angular/core';
import { HttpClient, HttpEvent, HttpEventType } from '@angular/common/http';
import { Observable, filter, firstValueFrom, map } from 'rxjs';
import { environment } from '../../../environments/environment';
import type { Attachment, UploadAttachmentResponse } from '@shared';

/**
 * Shape of upload progress events streamed by `upload()`.
 *
 * The composer subscribes to this stream and drives the per-chip progress bar
 * from `progress` events; a `final` event carries the committed `Attachment`.
 */
export type UploadEvent =
  | { kind: 'progress'; progress: number }
  | { kind: 'final'; attachment: Attachment };

/**
 * Owns REST calls to `POST /api/attachments` + the blob-cache + object-URL
 * lifecycle for `GET /api/attachments/:id`.
 *
 * The auth interceptor (see `core/auth/auth.interceptor.ts`) is responsible
 * for attaching `Authorization: Bearer <accessToken>` on every request — this
 * service never touches the token directly.
 *
 * Lifecycle: eagerly constructed in `AuthService` so its `reset()` slot is
 * wired before the first logout. `reset()` revokes every live object URL (so
 * cross-session blob leaks can't occur) and empties the blob cache.
 */
@Injectable({ providedIn: 'root' })
export class AttachmentsService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.apiUrl}/attachments`;

  /** Signals per attachmentId, keyed by id. Cached so repeated lookups are cheap. */
  private readonly signalCache = new Map<string, ReturnType<typeof signal<string | null>>>();
  /** In-flight fetch promises keyed by attachmentId — dedupes concurrent reads. */
  private readonly pending = new Map<string, Promise<string | null>>();
  /** Live blob cache. Retained for the lifetime of a login session. */
  private readonly blobCache = new Map<string, Blob>();
  /** Live object URL cache. `reset()` revokes every entry. */
  private readonly objectUrlCache = new Map<string, string>();

  /**
   * Upload a single file with progress events. Returns a cold Observable that
   * emits `{ kind: 'progress' }` entries while the body uploads, and finally
   * a single `{ kind: 'final' }` with the committed attachment row.
   *
   * Errors propagate as `HttpErrorResponse`. The composer maps 413 / 400 /
   * 403 to user-facing strings.
   */
  upload(file: File, roomId: string, comment: string | null): Observable<UploadEvent> {
    const form = new FormData();
    form.append('file', file);
    form.append('roomId', roomId);
    if (comment !== null && comment.length > 0) form.append('comment', comment);

    return this.http
      .post<UploadAttachmentResponse>(this.baseUrl, form, {
        reportProgress: true,
        observe: 'events',
      })
      .pipe(
        map((ev): UploadEvent | null => this.mapHttpEventToUploadEvent(ev)),
        filter((ev): ev is UploadEvent => ev !== null),
      );
  }

  /**
   * Reactive lookup for the object URL of an attachment. Returns a signal that
   * starts as `null` and resolves to a `blob:` URL once the download completes.
   * On 403 / 404 the signal stays `null` forever (the template renders a
   * placeholder card).
   *
   * The underlying fetch is deduped: two `<img>` tags referencing the same
   * `attachmentId` share a single HTTP request AND a single signal.
   */
  objectUrlFor(attachmentId: string): Signal<string | null> {
    const existing = this.signalCache.get(attachmentId);
    if (existing) return existing.asReadonly();

    const sig = signal<string | null>(null);
    this.signalCache.set(attachmentId, sig);

    // Seed from cache if we already fetched before.
    const cachedUrl = this.objectUrlCache.get(attachmentId);
    if (cachedUrl) {
      sig.set(cachedUrl);
      return sig.asReadonly();
    }

    // Kick off the fetch once per attachmentId; swallow errors so the signal
    // stays `null` and the template shows the placeholder.
    this.ensureFetched(attachmentId)
      .then((url) => {
        if (url) sig.set(url);
      })
      .catch(() => {
        // Explicit catch to satisfy `no-floating-promises`; the signal remains
        // null, which the template handles as the error placeholder.
      });

    return sig.asReadonly();
  }

  /**
   * Clear all cached blobs and revoke every live object URL. Called from
   * `AuthService.clearSession()` on logout + failed refresh.
   */
  reset(): void {
    for (const url of this.objectUrlCache.values()) {
      URL.revokeObjectURL(url);
    }
    this.objectUrlCache.clear();
    this.blobCache.clear();
    this.pending.clear();
    // Reset per-id signals so a post-logout, post-login fetch starts fresh.
    for (const sig of this.signalCache.values()) {
      sig.set(null);
    }
    this.signalCache.clear();
  }

  private async ensureFetched(attachmentId: string): Promise<string | null> {
    const inFlight = this.pending.get(attachmentId);
    if (inFlight) return inFlight;

    const promise = this.fetchBlob(attachmentId)
      .then((blob) => {
        if (blob === null) return null;
        this.blobCache.set(attachmentId, blob);
        const url = URL.createObjectURL(blob);
        this.objectUrlCache.set(attachmentId, url);
        return url;
      })
      .finally(() => {
        this.pending.delete(attachmentId);
      });

    this.pending.set(attachmentId, promise);
    return promise;
  }

  private async fetchBlob(attachmentId: string): Promise<Blob | null> {
    try {
      return await firstValueFrom(
        this.http.get(`${this.baseUrl}/${attachmentId}`, { responseType: 'blob' }),
      );
    } catch {
      // 403 (lost access) / 404 (orphan sweep / missing row) / network error.
      // Return null so the signal stays null and the template shows the
      // placeholder card. No retry — the user can refresh to try again.
      return null;
    }
  }

  private mapHttpEventToUploadEvent(event: HttpEvent<UploadAttachmentResponse>): UploadEvent | null {
    if (event.type === HttpEventType.UploadProgress) {
      const total = event.total ?? 0;
      const progress = total > 0 ? event.loaded / total : 0;
      return { kind: 'progress', progress };
    }
    if (event.type === HttpEventType.Response) {
      const body = event.body;
      if (body) {
        return { kind: 'final', attachment: body.attachment };
      }
    }
    return null;
  }
}
