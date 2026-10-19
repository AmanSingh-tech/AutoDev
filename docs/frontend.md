# Frontend conventions

How the web app handles motion, feedback, phones and awkward data. The rules follow Emil
Kowalski's design-engineering skills (emil-design-eng, mobile-native, break-ui, ask-sonner).

## Motion

Tokens live in `packages/ui/tailwind-preset.cjs`:

| Token | Value | Use |
|---|---|---|
| `ease-out` | `cubic-bezier(0.23, 1, 0.32, 1)` | Anything entering or responding (the default) |
| `ease-in-out` | `cubic-bezier(0.77, 0, 0.175, 1)` | Something moving across the screen |
| `animate-enter` | 220 ms, fade + 6 px rise | A new message, answer or panel arriving |
| `animate-fade` | 200 ms fade | Content swapping in place; the reduced-motion fallback for `enter` |
| `animate-pulse-dot` | 1.1 s, linear | The dots in `<Pending>` |

Rules:

- **Name the properties.** `transition-[color,background-color,transform]`, never `transition-all`.
- **No ease-in** for UI, and keep UI motion under 300 ms.
- **Buttons press**: `active:scale-[0.97]` over 150 ms, already in `<Button>`. It works for touch,
  because `:active` fires on press.
- **Animate arrivals, not lists.** `useArrivals(ids, scope)` (`apps/web/src/lib/use-arrivals.ts`)
  marks only items that appeared after the list loaded. Page loads and chat switches appear at once.
- **Don't animate** things people do dozens of times a day: tab switches, filters, board view
  toggles, keyboard actions.
- **Reduced motion**: pair `animate-enter` with `motion-reduce:animate-fade`; movement goes,
  opacity stays.
- **Waiting**: `<Pending label="…" />` from `@autodev/ui` instead of bare "Loading…" text when a
  wait can take seconds.

## Toasts

One `<Toaster theme="system" richColors closeButton />` in `apps/web/src/app/layout.tsx`. Never mount
another.

- **Use a toast** for the outcome of an action that has no natural place on the page: saved,
  removed, cancelled, opened a PR. Include an action when the outcome can be reversed (the prompt
  guide's rewrite has **Undo**).
- **Keep errors inline** when they belong to a form or a card, so they stay next to what failed.
- Call `toast()` from event handlers or mutation callbacks, never from server code.

## Phones

Baseline in `apps/web/src/app/layout.tsx` (`viewport` export) and `globals.css`:

- `viewport-fit=cover` with `env(safe-area-inset-*)` padding on the header and page bottom.
- One `theme-color` per color scheme.
- No tap highlight. Buttons and summaries can't be text-selected by a long press, and they skip
  the double-tap delay (`touch-action: manipulation`).
- Inputs are 16 px on touch screens, so iOS doesn't zoom in. Zoom itself is never disabled.
- `hover:` styles only apply on devices that can hover (`future.hoverOnlyWhenSupported`).
- `min-h-dvh`, never `min-h-screen`.
- Tab rows (`Main`, `Repository`, `Settings`) scroll sideways on narrow screens (`.no-scrollbar`).

Emulation can't reproduce sticky hover, the tap delay, safe areas or input zoom. Check those on a
real phone: run the stack, open `http://<your LAN IP>:3000`, and use Safari's or Chrome's remote
inspector.

## Awkward data

`pnpm db:seed:worst` creates the org `northwind-industries-holdings-europe`:

- long and accented names, an unbreakable class name and URL, CJK, Arabic and emoji titles;
- one-letter logins, missing names and avatars;
- 1,000 tasks, an empty repo and a repo with exactly one task;
- a 4,000-character room message and an answer with 20 sources;
- an exceeded budget.

Sign in on the mock GitHub as `aleksandra-wisniewska-kowalczyk` to see it
(`http://localhost:4010/_login-as?login=aleksandra-wisniewska-kowalczyk`). The demo users don't
see it, so the demo and the end-to-end tests are unaffected. `pnpm db:seed:worst --remove` deletes
it.

Patterns it drove:

| Data | Rule |
|---|---|
| Long words and paths in titles, messages, Markdown | `[overflow-wrap:anywhere]` (it also stops a long word from widening a grid or flex parent) |
| Text inside table cells | `break-words` instead (`anywhere` lets the column shrink until words split), with a `min-w-*` floor on the main column |
| Grids with tables or code inside | `grid-cols-1` as the base, so columns are `minmax(0, 1fr)` |
| File paths | Truncate in the middle, keep the full path in `title` and `aria-label` |
| Many sources | Show 5, then "N more" |
| Board card titles | `line-clamp-4` with the full title in `title` |
| Badges, keys, times | `whitespace-nowrap`; let the row wrap instead |
