import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, tap } from 'rxjs';
import { environment } from '../../environments/environment';
import type { Room, RoomDetail, CreateRoomRequest } from '../../../../shared/types';

@Injectable({ providedIn: 'root' })
export class RoomsService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.apiUrl}/rooms`;

  /** Cached list of the caller's rooms. Left sidebar subscribes to this. */
  readonly roomsSignal = signal<Room[]>([]);

  list(): Observable<Room[]> {
    return this.http.get<Room[]>(this.baseUrl);
  }

  create(body: CreateRoomRequest): Observable<RoomDetail> {
    return this.http.post<RoomDetail>(this.baseUrl, body);
  }

  get(id: string): Observable<RoomDetail> {
    return this.http.get<RoomDetail>(`${this.baseUrl}/${id}`);
  }

  join(id: string): Observable<RoomDetail> {
    return this.http.post<RoomDetail>(`${this.baseUrl}/${id}/join`, {});
  }

  leave(id: string): Observable<void> {
    return this.http.post<void>(`${this.baseUrl}/${id}/leave`, {});
  }

  /** Fetch the room list and push it into the shared signal. */
  refresh(): Observable<Room[]> {
    return this.list().pipe(tap((rooms) => this.roomsSignal.set(rooms)));
  }
}
