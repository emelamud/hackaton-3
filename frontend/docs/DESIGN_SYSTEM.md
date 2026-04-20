# Design System

This document is the source of truth for the visual language of the frontend. It is built on **Angular Material (M3, azure/blue palette, Roboto, density 0)**. Every screen must follow the rules below.

Product context: the app is a **chat app**. UX reference is **Slack** — desktop-first, dense, persistent sidenav, main message stream, optional right rail.

---

## 1. Hard rules

1. **Never use `--mat-sys-*` CSS variables in component code.** Use the utility classes defined in `frontend/src/styles/`. If you think you need a raw token, you are wrong — extend the utilities instead. *Narrow exception:* for pseudo-class states (`:hover`, `:focus`, `:active`, `:disabled`) where utilities cannot reach, import the token map via `@use 'styles/tokens' as *;` and reference `map.get($ds-colors, <role>)`. Still never write `var(--mat-sys-*)` directly.
2. **Never use hex colors** (`#fff`, `rgb(...)`, named colors). Use color utilities (`bg-*`, `text-*`, `border-*`).
3. **Never use `px`.** Use `rem`. The utility classes are already in rem. Custom SCSS must use rem.
4. **Prefer `mat-*` components over raw HTML** for buttons, inputs, cards, dialogs, lists, tables, toolbars, sidenavs. Custom HTML is allowed only for pure layout (`div`, `section`, `main`, `aside`, `header`, `footer`).
5. **Use spacing utilities before custom margin/padding.** Only fall back to custom SCSS when the geometry is genuinely outside the 4px grid.
6. **Every screen must be responsive.** Desktop-first. Collapse to mobile behavior below `md` (905px).
7. **Never inline styles** (`style="..."`) for color, spacing, or typography. Utilities only.

---

## 2. Color utilities

All color utilities resolve to Material M3 role tokens. Because M3 tokens auto-swap under `color-scheme: dark`, these utilities are dark-mode safe for free.

### Role pairs

Each role has a paired `on-*` variant for text/icons placed on top of that color.

| Class | Role | When to use |
|---|---|---|
| `bg-primary` / `text-on-primary` | primary | main brand surface (primary action buttons, selected nav item) |
| `bg-primary-container` / `text-on-primary-container` | primary container | softer brand surface (tag, selected row highlight) |
| `bg-secondary` / `text-on-secondary` | secondary | de-emphasised accents |
| `bg-secondary-container` / `text-on-secondary-container` | secondary container | softer secondary (chips, filters) |
| `bg-tertiary` / `text-on-tertiary` | tertiary | contrast accent (badges, highlights, presence "online") |
| `bg-tertiary-container` / `text-on-tertiary-container` | tertiary container | softer tertiary |
| `bg-error` / `text-on-error` | error | destructive confirmation, error banners |
| `bg-error-container` / `text-on-error-container` | error container | error hints, inline error rows |

### Surfaces

| Class | Role | When to use |
|---|---|---|
| `bg-background` / `text-on-background` | background | window background (body) |
| `bg-surface` / `text-on-surface` | surface | default content surface (main message pane) |
| `text-on-surface-variant` | surface variant text | secondary text, metadata, timestamps |
| `bg-surface-dim` | dim surface | deeper context panels |
| `bg-surface-bright` | bright surface | elevated light panels |
| `bg-surface-container-lowest` | surface container lowest | subtle nested surface |
| `bg-surface-container-low` | surface container low | message composer bar |
| `bg-surface-container` | surface container | cards, inactive list items |
| `bg-surface-container-high` | surface container high | **Slack-like sidenav**, hovered list items |
| `bg-surface-container-highest` | surface container highest | active nav item, emphasised card |

### Lines

| Class | Role | When to use |
|---|---|---|
| `border-outline` | outline | primary divider, input border |
| `border-outline-variant` | outline variant | subtle divider between list rows |

### Inverse (for snackbars, tooltips)

| Class | Role |
|---|---|
| `bg-inverse-surface` / `text-inverse-on-surface` | inverse surface (tooltips, snackbars) |
| `text-inverse-primary` | inverse primary (action link on inverse surface) |

### Chat-app palette mapping (Slack-like)

| Surface | Class |
|---|---|
| Window background | `bg-background` |
| Sidenav (channels/DMs) | `bg-surface-container-high` |
| Active channel item | `bg-surface-container-highest` |
| Main message pane | `bg-surface` |
| Message composer | `bg-surface-container-low` with `border-outline-variant` top border |
| Timestamp / author meta | `text-on-surface-variant` |
| Unread badge | `bg-primary` + `text-on-primary` |
| Online presence dot | `bg-tertiary` |
| Away presence dot | `bg-outline` |
| Offline presence dot | `bg-surface-dim` |

---

## 3. Typography utilities

15 classes, one per M3 typescale role. Each class sets `font-size`, `line-height`, `font-weight`, `letter-spacing`, and `font-family` in one declaration.

| Class | Size (rem / px) | Line height | Weight | Usage |
|---|---|---|---|---|
| `text-display-large` | 3.562 / 57 | 4rem | 400 | hero numbers (rare) |
| `text-display-medium` | 2.812 / 45 | 3.25rem | 400 | marketing only |
| `text-display-small` | 2.25 / 36 | 2.75rem | 400 | marketing only |
| `text-headline-large` | 2 / 32 | 2.5rem | 400 | **page title** |
| `text-headline-medium` | 1.75 / 28 | 2.25rem | 400 | major section |
| `text-headline-small` | 1.5 / 24 | 2rem | 400 | **section title** |
| `text-title-large` | 1.375 / 22 | 1.75rem | 400 | **card / dialog title** |
| `text-title-medium` | 1 / 16 | 1.5rem | 500 | **list item title, channel name** |
| `text-title-small` | 0.875 / 14 | 1.25rem | 500 | sub-section title |
| `text-body-large` | 1 / 16 | 1.5rem | 400 | long-form text |
| `text-body-medium` | 0.875 / 14 | 1.25rem | 400 | **default body, message body** |
| `text-body-small` | 0.75 / 12 | 1rem | 400 | captions |
| `text-label-large` | 0.875 / 14 | 1.25rem | 500 | **button label** |
| `text-label-medium` | 0.75 / 12 | 1rem | 500 | form labels |
| `text-label-small` | 0.688 / 11 | 1rem | 500 | **timestamps, meta** |

Chat-app ladder:

- Channel name in header: `text-title-medium`
- Message author: `text-title-small`
- Message body: `text-body-medium`
- Timestamp / "edited" / reactions count: `text-label-small text-on-surface-variant`

---

## 4. Spacing utilities

Scale is **4px-based, rem-only**. Nine steps plus `auto`.

| Token | rem | px |
|---|---|---|
| `0` | 0 | 0 |
| `1` | 0.25 | 4 |
| `2` | 0.5 | 8 |
| `3` | 0.75 | 12 |
| `4` | 1 | 16 |
| `5` | 1.5 | 24 |
| `6` | 2 | 32 |
| `7` | 3 | 48 |
| `8` | 4 | 64 |
| `auto` | auto | — |

### Classes

Margin: `m-*`, `mt-*`, `mr-*`, `mb-*`, `ml-*`, `mx-*`, `my-*`
Padding: `p-*`, `pt-*`, `pr-*`, `pb-*`, `pl-*`, `px-*`, `py-*`
Gap (for flex / grid containers): `gap-*`, `row-gap-*`, `column-gap-*`

Examples:
- `p-4` → padding 1rem on all sides
- `mx-auto` → horizontal auto margin (center)
- `gap-2` → 0.5rem gap in flex/grid
- `py-3 px-4` → 0.75rem vertical, 1rem horizontal padding

No negative margins. No responsive variants (`md:` / `sm:`). Handle responsive layout at the component SCSS level with media queries.

---

## 5. Responsive

Mobile-first is NOT our default — this is a desktop-native chat app. Design for desktop first, then collapse.

### Breakpoints (Material window size classes)

| Name | Min width | Use |
|---|---|---|
| `xs` | 0 | phone portrait |
| `sm` | 600px | phone landscape / small tablet |
| `md` | 905px | tablet / small desktop — **sidenav collapse point** |
| `lg` | 1240px | desktop |
| `xl` | 1440px | large desktop |

### How to write media queries

Always in rem. Breakpoints converted to rem assuming 16px root:

```scss
// Below md — collapse sidenav to overlay
@media (max-width: 56.5rem) {
  .app-shell__sidenav { /* mode="over" */ }
}

// lg and up — show right rail
@media (min-width: 77.5rem) {
  .app-shell__rail { display: block; }
}
```

`sm 37.5rem · md 56.5rem · lg 77.5rem · xl 90rem`

### Layout rules

- Prefer `display: flex` or `display: grid` for all layout.
- `mat-sidenav-container` handles the shell responsive behavior; switch `mode="side"` → `mode="over"` below `md`.
- Forms: single-column always. No side-by-side fields below `sm`.

---

## 6. Dark mode

M3 tokens switch automatically based on `color-scheme`. The `ThemeService` manages this.

Modes:
- `system` (default) — follows `prefers-color-scheme`.
- `light` — forces `color-scheme: light` on `<html>`.
- `dark` — forces `color-scheme: dark` on `<html>`.

Persisted in `localStorage` under the key `theme-mode`.

As long as you use utility classes only, dark mode works without any extra work in your component.

---

## 7. Component recipes

### 7.1 App shell (Slack-like)

```html
<mat-sidenav-container class="app-shell">
  <mat-sidenav mode="side" opened class="app-shell__sidenav bg-surface-container-high">
    <!-- workspace switcher, channel list, DM list -->
  </mat-sidenav>
  <mat-sidenav-content class="bg-surface">
    <header class="app-shell__topbar px-4 py-3 border-outline-variant">
      <h1 class="text-title-medium m-0">#general</h1>
    </header>
    <main class="app-shell__main">
      <!-- message list -->
    </main>
    <footer class="app-shell__composer bg-surface-container-low p-3">
      <!-- composer -->
    </footer>
  </mat-sidenav-content>
</mat-sidenav-container>
```

Below `md`: switch sidenav to `mode="over"` with a hamburger button in the topbar.

### 7.2 Channel / DM list item

```html
<button class="channel-item px-3 py-2 gap-2" [class.channel-item--active]="isActive">
  <mat-icon class="text-on-surface-variant">tag</mat-icon>
  <span class="text-body-medium">general</span>
  <span *ngIf="unread" class="unread-badge ml-auto bg-primary text-on-primary px-2 text-label-small">{{ unread }}</span>
</button>
```

- Default: `text-on-surface-variant`.
- Hover: `bg-surface-container-highest`.
- Active: `bg-surface-container-highest text-on-surface`.

### 7.3 Message row

```html
<article class="message px-4 py-2 gap-3">
  <img class="message__avatar" [src]="avatar" alt="" />
  <div class="message__body">
    <header class="gap-2">
      <span class="text-title-small">{{ authorName }}</span>
      <time class="text-label-small text-on-surface-variant">{{ timestamp }}</time>
    </header>
    <p class="text-body-medium m-0">{{ content }}</p>
  </div>
</article>
```

### 7.4 Inline composer

```html
<form class="composer gap-2">
  <mat-form-field appearance="outline" class="composer__input">
    <textarea matInput cdkTextareaAutosize [cdkAutosizeMinRows]="1" [cdkAutosizeMaxRows]="6"
              placeholder="Message #general"></textarea>
  </mat-form-field>
  <button mat-icon-button type="button" aria-label="Attach">
    <mat-icon>attach_file</mat-icon>
  </button>
  <button mat-flat-button color="primary" type="submit">Send</button>
</form>
```

### 7.5 Forms

- Always `<mat-form-field appearance="outline">`.
- Label goes in `<mat-label>`, never as placeholder-only.
- Required indicator: `required` attribute on the control; Material shows the `*`.
- Validation: use `<mat-error>` for errors, `<mat-hint>` for hints.
- Single column. One `mat-form-field` per row unless the two fields are semantically paired (e.g. first/last name).

```html
<form [formGroup]="form" class="p-5 gap-4">
  <mat-form-field appearance="outline">
    <mat-label>Email</mat-label>
    <input matInput type="email" formControlName="email" required />
    <mat-error *ngIf="form.controls.email.hasError('required')">Email is required</mat-error>
  </mat-form-field>
  <div class="gap-3 mt-5">
    <button mat-stroked-button type="button">Cancel</button>
    <button mat-flat-button color="primary" type="submit">Save</button>
  </div>
</form>
```

### 7.6 Buttons — decision table

| Variant | Use for |
|---|---|
| `mat-flat-button` + `color="primary"` | primary action per view (Send, Save, Create) |
| `mat-stroked-button` | secondary action (Cancel, Dismiss) |
| `mat-button` (text) | tertiary / low-emphasis action (inline links, "Learn more") |
| `mat-raised-button` | rare — only when elevation improves scannability on a busy surface |
| `mat-icon-button` | icon-only actions (attach, more, close) |
| `mat-fab` / `mat-mini-fab` | floating primary action (compose) |

One primary button per screen, max.

### 7.7 Lists and tables

- Channel / DM / member lists → native `<ul>` / `<button>` with utility classes (lighter than `mat-list` for chat density).
- Data tables → `mat-table` with `matSort` + `mat-paginator`.
- Row density in tables: density 0 default; consider `-2` for dense logs.

### 7.8 Dialogs

- Open with `MatDialog.open(MyDialogComponent, { width: '28rem' })`.
- Structure: `<h2 mat-dialog-title class="text-title-large">`, `<mat-dialog-content>`, `<mat-dialog-actions align="end">`.
- Actions: `mat-button` (cancel) + `mat-flat-button color="primary"` (confirm).

### 7.9 Snackbars

- `MatSnackBar.open(message, action?, { duration: 5000 })`.
- Use for transient confirmations ("Message sent"). Never for errors that require action.

### 7.10 States

| State | Recipe |
|---|---|
| Loading (inline) | `<mat-progress-spinner diameter="24">` + `text-body-medium text-on-surface-variant` caption |
| Loading (full pane) | Skeleton rows using `bg-surface-container` boxes with pulse animation |
| Empty | Centered block: `mat-icon` (large, `text-on-surface-variant`) + `text-title-medium` headline + `text-body-medium text-on-surface-variant` description + CTA button |
| Error | `bg-error-container text-on-error-container` card with retry button |

### 7.11 Icons

Use **Material Icons** (ligatures). Loaded via `<link>` in `index.html`.

```html
<mat-icon>send</mat-icon>
<mat-icon>tag</mat-icon>
<mat-icon>person</mat-icon>
```

Size matches containing text; to adjust, apply a utility on the parent, not the icon itself.

---

## 8. File layout

```
frontend/src/styles/
├── _tokens.scss               # re-exports var(--mat-sys-*) → $ds-* SCSS vars
├── _utilities-color.scss      # bg-*, text-*, border-*
├── _utilities-typography.scss # text-<role>
├── _utilities-spacing.scss    # m-*, p-*, gap-*
└── _theme.scss                # color-scheme wiring + .theme-light / .theme-dark

frontend/src/styles.scss       # @use '@angular/material' + the partials above
```

---

## 9. Don'ts

- Don't write `color: #<hex>`. Use `text-*` utility.
- Don't write `background: var(--mat-sys-surface)`. Use `bg-surface`.
- Don't write `padding: 16px` or `margin-top: 24px`. Use `p-4` or `mt-5`.
- Don't roll your own button. Use `mat-button` + variants.
- Don't hand-pick a hex from the azure palette. Use role utilities.
- Don't ship a screen without opening it below `md` to check the layout.
- Don't add `!important` to win a specificity fight with Material — compose your utility on the correct element instead.
