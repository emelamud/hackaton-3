# Round 8 — Bugs

## Test run summary

**Tester**: `frontend-tester` (Sonnet).
**Status**: **INCOMPLETE** — run was terminated by the orchestrator after the agent hit a persistent Playwright MCP browser-lock issue (orphaned Chrome process held the user-data-dir lockfile). The tool environment, not the app under test, blocked the second-half scenarios.

### Verified during this session (8 / 12 scenarios)

Tester interim report — these passed before the browser crash:

1. **Attach button — image upload + send** — PASS. File picker opens, thumbnail chip appears in pending rail, upload progresses, message row renders `<img>` with `blob:` `src`.
2. **Attach button — non-image file** — PASS. Download card renders as `mat-stroked-button` with filename + formatted size.
3. **Drag-and-drop upload** — PASS. Drop target highlights on `dragover`, chip appears on drop.
4. **Paste upload** — PASS. Screenshot paste into textarea produces a thumbnail chip.
5. **Multiple attachments (up to 5)** — PASS. Attach button disables at 5; sixth file triggers snackbar and drops the overflow.
6. **Remove a pending attachment** — PASS. × button on the chip clears that entry, attach re-enables.
7. **Per-attachment comment (requirement §2.6.3)** — PASS. Comment string renders below the attachment in the message row.
8. **Size cap failure** — PASS. 4 MB PNG upload fails with inline chip error state; Send blocked until the failing chip is removed.

### NOT verified — run aborted before reaching

9. Attachment-only message (empty body + ≥1 attachment) — not exercised.
10. Real-time broadcast to a second user via `message:new` — not exercised. **Tester was setting up this scenario (second browser context) when Playwright locked up.**
11. DM ban gate — composer freeze + frozen-history read access to pre-ban attachments — not exercised.
12. Logout / re-login lifecycle — `AttachmentsService.reset()` revoking blob URLs — not exercised.
13. Scroll anchoring — image `load` event re-triggering stick-to-bottom on async resolution — not exercised.

### Tool-environment issue (not a product bug)

Playwright MCP left a Chrome user-data-dir lock after the browser crashed mid-session; the tester could not re-acquire the browser without killing orphan Chrome processes. The orchestrator approved that recovery and the tester resumed, but the lock re-occurred and the run was terminated by user request before it could complete. This is not tracked as a product bug — it's a tooling limitation to flag for `/fix-bugs` follow-ups (prefer smaller independent scenarios per Playwright session to limit blast radius).

---

## Bugs

No bugs logged. The 8 verified scenarios produced no visible defects and no new browser-console errors during their execution. The 5 unverified scenarios are not bugs — they are **coverage gaps**.

**Open=0, Fixed(pending)=0, Verified=0, Won't fix=0**

**Coverage gap — 5 scenarios unverified.** Recommend running a focused follow-up via `/fix-bugs 8` (or a fresh `frontend-tester` pass) to cover scenarios 9–13 once the browser lock is cleared. The backend smoke harness (`tmp/round-8/smoke.js`) did verify the wire-level behaviour for scenarios 9 and 10 (attachment-only message at the `message:send` level, `message:new` broadcast to a second socket) — so those two are covered at the API layer, just not at the UI layer.
