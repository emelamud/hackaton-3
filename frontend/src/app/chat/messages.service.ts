import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, filter, from, map } from 'rxjs';
import { environment } from '../../environments/environment';
import { SocketService } from '../core/socket/socket.service';
import type {
  EditMessageRequest,
  Message,
  MessageDeletedPayload,
  MessageHistoryResponse,
  MessageSendAck,
  SendMessagePayload,
} from '@shared';

@Injectable({ providedIn: 'root' })
export class MessagesService {
  private readonly http = inject(HttpClient);
  private readonly socketService = inject(SocketService);

  private readonly baseUrl = `${environment.apiUrl}/rooms`;
  private readonly messagesUrl = `${environment.apiUrl}/messages`;

  /**
   * Return a page of messages for the given room. Oldest first.
   *
   * Round 9: the endpoint response is now `MessageHistoryResponse`
   * (`{ messages, hasMore }`) rather than a bare array, and accepts
   * `?before=<messageId>` + `?limit=<1..100>` query params for paginate-
   * upwards behaviour.
   *
   * Callers:
   *  - `MessageListComponent.loadInitial()` passes no cursor → newest page.
   *  - `MessageListComponent.loadMore()` passes `{ before: oldestLoadedId }`
   *    to fetch the next older slice.
   */
  getHistory(
    roomId: string,
    options: { before?: string; limit?: number } = {},
  ): Observable<MessageHistoryResponse> {
    let params = new HttpParams();
    if (options.before) {
      params = params.set('before', options.before);
    }
    if (options.limit != null) {
      params = params.set('limit', String(options.limit));
    }
    return this.http.get<MessageHistoryResponse>(`${this.baseUrl}/${roomId}/messages`, {
      params,
    });
  }

  /**
   * Send a message via socket ack. Resolves with the persisted `Message`
   * from the server on success; errors with an `Error` whose `message`
   * is the verbatim ack error string from the contract.
   *
   * Round 8: optional `attachmentIds` forward the freshly-uploaded
   * pending attachments so they commit atomically with the message row.
   *
   * Round 10: optional `replyToId` references another message in the same
   * room; server rejects cross-room or unknown ids with the ack string
   * `'Invalid reply target'`. Moved `attachmentIds` into an options object
   * so a caller can pass `replyToId` without threading a positional `undefined`.
   */
  send(
    roomId: string,
    body: string,
    options?: { attachmentIds?: string[]; replyToId?: string },
  ): Observable<Message> {
    const payload: SendMessagePayload = { roomId, body };
    if (options?.attachmentIds && options.attachmentIds.length > 0) {
      payload.attachmentIds = options.attachmentIds;
    }
    if (options?.replyToId) {
      payload.replyToId = options.replyToId;
    }
    return from(
      this.socketService.emitWithAck<SendMessagePayload, MessageSendAck>('message:send', payload),
    ).pipe(
      map((ack) => {
        if (ack.ok) return ack.message;
        throw new Error(ack.error);
      }),
    );
  }

  /**
   * Edit your own message body. Author-only; the server rejects non-authors
   * with 403. Returns the fully-hydrated `Message` (attachments + replyTo
   * re-hydrated, `editedAt` populated).
   */
  edit(messageId: string, body: string): Observable<Message> {
    const payload: EditMessageRequest = { body };
    return this.http.patch<Message>(`${this.messagesUrl}/${messageId}`, payload);
  }

  /**
   * Delete your own message. Author-only; server cascades attachments and
   * flips `reply_to_id` to NULL on replying messages. The `message:delete`
   * broadcast includes every socket in the room (including the caller's own
   * tab); `MessageListComponent` treats the incoming no-op as a redundant
   * reconcile.
   */
  delete(messageId: string): Observable<void> {
    return this.http.delete<void>(`${this.messagesUrl}/${messageId}`);
  }

  /**
   * Live feed of incoming messages for a specific room. The underlying socket
   * is subscribed to every room the user is a member of, so we filter client-
   * side to the room the caller is rendering.
   */
  newMessages$(roomId: string): Observable<Message> {
    return this.socketService.on('message:new').pipe(filter((m) => m.roomId === roomId));
  }

  /**
   * Live feed of edited messages across every room the caller is subscribed
   * to. The consumer must filter on `roomId` — a single `MessageListComponent`
   * only cares about its current room.
   */
  editedMessages$(): Observable<Message> {
    return this.socketService.on('message:edit');
  }

  /**
   * Live feed of deleted-message notifications. Same cross-room semantics as
   * `editedMessages$()` — consumer filters on `roomId`.
   */
  deletedMessages$(): Observable<MessageDeletedPayload> {
    return this.socketService.on('message:delete');
  }
}
