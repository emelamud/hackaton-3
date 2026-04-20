import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: 'design-system',
    loadComponent: () =>
      import('./design-system/design-system.component').then((m) => m.DesignSystemComponent),
  },
  { path: '', pathMatch: 'full', redirectTo: 'design-system' },
];
