import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, filter, from, map } from 'rxjs';
import { environment } from '../../environments/environment';
import { SocketService } from '../core/socket/socket.service';
import type {
  Message,
  MessageHistoryResponse,
  MessageSendAck,
  SendMessagePayload,
} from '@shared';

@Injectable({ providedIn: 'root' })
export class MessagesService {
  private readonly http = inject(HttpClient);
  private readonly socketService = inject(SocketService);

  private readonly baseUrl = `${environment.apiUrl}/rooms`;

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
   * Round 8: an optional `attachmentIds` array is forwarded to the server so
   * the pending attachments (previously uploaded via `POST /api/attachments`)
   * get atomically committed with the message row. Callers that don't attach
   * anything pass the default and the payload matches the pre-Round-8 shape
   * exactly.
   */
  send(roomId: string, body: string, attachmentIds?: string[]): Observable<Message> {
    const payload: SendMessagePayload = { roomId, body };
    if (attachmentIds && attachmentIds.length > 0) {
      payload.attachmentIds = attachmentIds;
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
   * Live feed of incoming messages for a specific room. The underlying socket
   * is subscribed to every room the user is a member of, so we filter client-
   * side to the room the caller is rendering.
   */
  newMessages$(roomId: string): Observable<Message> {
    return this.socketService.on('message:new').pipe(filter((m) => m.roomId === roomId));
  }
}
