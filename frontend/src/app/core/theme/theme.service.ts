import { DOCUMENT } from '@angular/common';
import { Injectable, inject, signal } from '@angular/core';

export type ThemeMode = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'theme-mode';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly document = inject(DOCUMENT);

  readonly mode = signal<ThemeMode>(this.read());

  constructor() {
    this.apply(this.mode());
  }

  set(mode: ThemeMode): void {
    this.mode.set(mode);
    this.document.defaultView?.localStorage.setItem(STORAGE_KEY, mode);
    this.apply(mode);
  }

  private read(): ThemeMode {
    const stored = this.document.defaultView?.localStorage.getItem(STORAGE_KEY);
    return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
  }

  private apply(mode: ThemeMode): void {
    const html = this.document.documentElement;
    html.classList.remove('theme-light', 'theme-dark');
    if (mode === 'light') html.classList.add('theme-light');
    if (mode === 'dark') html.classList.add('theme-dark');
  }
}
