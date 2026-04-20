---
name: design-system
description: Frontend design system for the chat app — Angular Material M3 (azure/blue), utility classes, Slack-inspired layout. Invoke before writing any Angular component/template/SCSS.
---

# Design System Skill

Full reference: **`frontend/docs/DESIGN_SYSTEM.md`**. Read it. This file is the short imperative version.

Product: chat app. UX reference: **Slack**. Desktop-first, dense, persistent sidenav, main message stream, optional right rail.

---

## Hard rules — non-negotiable

1. **Never use `--mat-sys-*`** CSS variables in component code (templates, `:host`, component SCSS). Narrow exception: for `:hover`/`:focus`/`:active`/`:disabled` pseudo-classes, import the token map: `@use 'styles/tokens' as *;` then `background-color: map.get($ds-colors, surface-container-highest);`. Never `var(--mat-sys-*)` directly.
2. **Never use hex / rgb / named colors.** Use `bg-*`, `text-*`, `border-*` utilities.
3. **Never use `px`.** Rem only. Utility classes are already rem.
4. **Prefer `mat-*` components** over raw HTML for buttons, inputs, cards, dialogs, lists, tables, toolbars, sidenavs.
5. **Use spacing utilities before custom margin/padding.** Only fall back to custom SCSS when the geometry is outside the 4px grid.
6. **Every screen must be responsive.** Desktop-first. Collapse behavior below `md` (56.5rem / 905px).
7. **No inline styles** (`style="..."`) for color, spacing, or typography.

---

## Color utilities (role-based)

Backgrounds: `bg-<role>` · Text: `text-<role>` · Borders: `border-<role>`, `border-t-<role>`, `border-r-<role>`, `border-b-<role>`, `border-l-<role>` (only `outline`, `outline-variant`, `primary`, `error`).

Roles available:
`primary`, `on-primary`, `primary-container`, `on-primary-container`,
`secondary`, `on-secondary`, `secondary-container`, `on-secondary-container`,
`tertiary`, `on-tertiary`, `tertiary-container`, `on-tertiary-container`,
`error`, `on-error`, `error-container`, `on-error-container`,
`background`, `on-background`,
`surface`, `on-surface`, `on-surface-variant`,
`surface-dim`, `surface-bright`,
`surface-container-lowest`, `surface-container-low`, `surface-container`, `surface-container-high`, `surface-container-highest`,
`outline`, `outline-variant`,
`inverse-surface`, `inverse-on-surface`, `inverse-primary`.

**Chat-app palette map:** sidenav → `bg-surface-container-high`; main pane → `bg-surface`; composer → `bg-surface-container-low`; metadata → `text-on-surface-variant`; unread badge → `bg-primary text-on-primary`; online dot → `bg-tertiary`.

---

## Typography utilities

`text-display-large/medium/small` · `text-headline-large/medium/small` · `text-title-large/medium/small` · `text-body-large/medium/small` · `text-label-large/medium/small`.

Each class sets font-family + size + line-height + weight + tracking in one.

**Chat ladder:** channel name `text-title-medium`; message author `text-title-small`; message body `text-body-medium`; timestamp `text-label-small text-on-surface-variant`.

---

## Spacing utilities (4px grid, rem-only)

Scale: `0 1 2 3 4 5 6 7 8 auto` → `0, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4 rem` (and `auto`).

- Margin: `m-*`, `mt-*`, `mr-*`, `mb-*`, `ml-*`, `mx-*`, `my-*`
- Padding: `p-*`, `pt-*`, `pr-*`, `pb-*`, `pl-*`, `px-*`, `py-*`
- Gap (flex/grid): `gap-*`, `row-gap-*`, `column-gap-*`

No negative margins. No responsive variants. Handle responsive layout with media queries in component SCSS (rem-based, `sm 37.5rem · md 56.5rem · lg 77.5rem · xl 90rem`).

---

## Required component patterns

- **Forms:** `<mat-form-field appearance="outline">` always. `<mat-label>` always. `<mat-error>` for errors. Single-column.
- **Buttons:** primary action = `mat-flat-button color="primary"`; cancel/secondary = `mat-stroked-button`; text-only = `mat-button`; icon-only = `mat-icon-button`. One primary per screen.
- **Dialogs:** `MatDialog.open(Cmp, { width: '28rem' })`. Title `text-title-large`. Actions `align="end"`.
- **Snackbars:** `MatSnackBar.open(msg, action, { duration: 5000 })`. Transient only — never for errors that require action.
- **Icons:** `<mat-icon>name</mat-icon>` using Material Icons ligatures.

---

## Dark mode

Free — M3 tokens auto-swap via `color-scheme`. `ThemeService` (`src/app/core/theme/theme.service.ts`) manages `light`/`dark`/`system`. As long as you use utility classes, dark mode works with zero extra work.

---

## Before submitting

- [ ] No `--mat-sys-*` in your templates or component SCSS (except via `$ds-colors` map for pseudo-classes).
- [ ] No hex, no `rgb()`, no named colors.
- [ ] No `px` anywhere.
- [ ] Every color / spacing / typography value comes from a utility class.
- [ ] Screen was checked at width < 56.5rem for responsive behavior.
- [ ] Uses `mat-*` components for all standard UI primitives.
