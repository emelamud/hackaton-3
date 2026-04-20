import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { RoomsSidebarComponent } from './rooms-sidebar.component';
import { RoomRailComponent } from './room-rail.component';

@Component({
  selector: 'app-chat-layout',
  standalone: true,
  imports: [RouterOutlet, RoomsSidebarComponent, RoomRailComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './chat-layout.component.html',
  styleUrl: './chat-layout.component.scss',
})
export class ChatLayoutComponent {}
