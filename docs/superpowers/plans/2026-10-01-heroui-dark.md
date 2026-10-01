# HeroUI Dark Dashboard Implementation Plan

> **For agentic workers:** Use subagent-driven-development for scoped tasks, review resulting changes, then verify the integrated page.

**Goal:** Deliver the user-approved dark Meme Scout dashboard using HeroUI v3 controls.

**Architecture:** Keep scanner/data state intact. Centralize reusable UI primitives in `dashboard/app/ui.tsx`, update page composition, and rebuild CSS around the existing semantic selectors. Preserve risk colors and evidence states.

**Tech Stack:** React 19, HeroUI v3, Tailwind 4, TypeScript, Vinext.

### Task 1: Dependencies and controls

- [x] Install `@heroui/react` and `@heroui/styles` in `dashboard`.
- [x] Add client UI primitives for button, input, tabs, select and modal using HeroUI's installed types. Keep controlled selection, form submit, disabled and accessible label behavior.
- [x] Migrate controls in `page.tsx`, `live-tape.tsx`, and `bubble-map.tsx` away from the old components.

### Task 2: Dark visual system

- [x] Replace the global CSS theme with charcoal surfaces, violet accent, restrained borders and consistent radii/spacing.
- [x] Style toolbar, statistics, chain controls, LIVE TAPE, candidates and overlays.
- [x] Retain responsive full-width table scrolling and existing evidence hover details; support reduced motion and visible keyboard focus.

### Task 3: Composition and review

- [x] Improve header and workspace hierarchy with concise titles, panel labels and connected spacing.
- [x] Review all migrated callbacks and external links against the existing behavior.
- [x] Run `npm --prefix dashboard run typecheck`, `npm --prefix dashboard run lint`, `npm --prefix dashboard test`, and `npm --prefix dashboard run build`.
- [x] Inspect the running local app and interact with tabs, filters, settings, block confirmation and bubble maps; fix observed issues before delivery.

### Task 4: Bubble-map behavior

- [x] Local allowed hosts open an interactive preview on hover, preserve focus, and support pinned click/keyboard opening.
- [x] Deployments use a direct new-tab InsightX link with no embed or metrics request.
- [x] Add a host-selection regression test and verify real local and deployed-host branches.
- [x] Verify constrained popover placement, scrolling, and keyboard dismissal at desktop/mobile widths.

**Verification:** 243 tests pass; typecheck, lint and production build pass. Browser QA covered main controls, settings, block cancellation, local real-map loading, mouse hover, keyboard focus restoration and direct links on a non-whitelisted local alias. At 390×600 the popover stays at x=16..374 with internal scrolling, its website link remains reachable, and the page has no horizontal overflow.
