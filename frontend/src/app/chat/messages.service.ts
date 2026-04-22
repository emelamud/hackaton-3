import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, filter, from, map } from 'rxjs';
import { environment } from '../../environments/environment';
import { SocketService } from '../core/socket/socket.service';
import type { Message, MessageSendAck, SendMessagePayload } from '@shared';

@Injectable({ providedIn: 'root' })
export class MessagesService {
  private readonly http = inject(HttpClient);
  private readonly socketService = inject(SocketService);

  private readonly baseUrl = `${environment.apiUrl}/rooms`;

  /** Return the up-to-50 most-recent messages for a room, oldest first. */
  getRecent(roomId: string): Observable<Message[]> {
    return this.http.get<Message[]>(`${this.baseUrl}/${roomId}/messages`);
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
