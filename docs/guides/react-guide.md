# React Rules (agent)

Scope: `clients/dapp/`. Stack: React 18 + TS, Vite, wagmi/viem, TanStack Query, Tailwind v4, Vitest+RTL, Playwright.

Optimize: error visibility, runtime safety, minimum external surface. Not DX.

## Prime directives
1. No new runtime dep without a linked issue. Reuse `package.json`.
2. Fail loud at the boundary. No silent fallbacks (this is a dapp; users lose money).
3. Make invalid states unrepresentable via types.
4. Smallest API: fewest exports, props, hooks, files.
5. Deterministic render: no `Date.now`, `Math.random`, `process.env`, locale formatters inside render — inject them.

## Dependencies — banned
- UI libs (MUI, Radix, shadcn, Headless UI, …). Use `<button>` + Tailwind.
- State libs (Redux, Zustand, Jotai, MobX). TanStack Query + `useState` only.
- Form libs (react-hook-form, Formik). Native `<form>`.
- Router, animation libs, icon packs (inline SVG), lodash/date-fns (write the one fn in `lib/`).
- Wrapper components around native elements until ≥3 non-trivial call sites exist.
- Barrel `index.ts` re-exports.

## Types
- `strict: true`. No `any`, no `!`, no `// @ts-ignore`. `as` only for `as const` or post-guard I/O parse.
- viem `Address`/`Hex`/`Hash` end-to-end. Parse external input via `isAddress`/`getAddress`/`isHex`.
- Discriminated unions, not optional bags:
  ```ts
  type R<T> = {status:'idle'}|{status:'pending'}|{status:'success';data:T}|{status:'error';error:Error}
  ```
- `readonly` props and arrays. Mutate by replacement.
- No `enum` — string-literal unions.
- Every discriminant `switch` ends with `default: return assertNever(x)`.

## Components
- Named exports only, filename = PascalCase export. No default exports.
- Function components only. No `React.FC`. `type Props = Readonly<{...}>`.
- Caps: ≤150 lines, ≤8 props. Split when exceeded.
- No inline component defs inside another component (remounts every render).
- No prop spreading except forwarding DOM props to one native element.
- No `dangerouslySetInnerHTML`.
- No `memo`/`useMemo`/`useCallback` without a measured reason; comment why on the line.

## State & data
- Server state → TanStack Query. Local UI state → `useState`. No third category, no store.
- `queryKey: ['<resource>', chainId, address, ...]` — `chainId` mandatory (cache bleed = correctness bug).
- Mutations: explicit `invalidateQueries` in `onSuccess`. No ad-hoc `refetch()`. `retry: 0` (double-spend risk).
- Chain reads/writes via wagmi hooks. Raw viem only in `lib/`.
- `useSimulateContract` before every `useWriteContract`.
- `useEffect` is only for subscribing to a non-React external with cleanup. Never for fetching, derivation, or event response.
- `useReducer` only with a documented transition table comment.

## Rendering
- Early-return every not-ready state; `query.data` used only after the guards:
  ```tsx
  if (!isConnected) return <ConnectPrompt/>
  if (q.isPending) return <Skeleton/>
  if (q.error) return <ErrorPanel error={q.error}/>
  return <Detail data={q.data}/>
  ```
- `key` = stable domain id (`vault.address`, `tx.hash`). Never array index.
- Guard numeric truthy: `count > 0 && <X/>`, never `count && <X/>`.
- Max one ternary per JSX expression.
- `<form onSubmit>` always set; non-submit `<button type="button">`.
- `target="_blank"` requires `rel="noopener noreferrer"`.
- Semantic HTML: `<button>`/`<a>`/`<label>`. `<div onClick>` banned.

## Errors & async
- No empty `catch`. Log + one-line reason if intentionally ignored.
- No floating promises. `await` in async handler, or explicit `void` with comment.
- Surface viem/wagmi `shortMessage` verbatim. Never replace with "Something went wrong".
- Error boundaries at top-level flow boundaries only; fallback must show error text.

## Styling
- Tailwind inline. No CSS-in-JS. New `.css` files require a reason.
- No design-system kit; build from native elements.

## Tests
- RTL `getByRole({name})`. No class selectors. `data-testid` only when no accessible name.
- Mock only the network boundary (MSW, wagmi mock connector). Never mock our hooks/components.
- Every new component: ≥1 test for primary failure path, not just happy path.
- No `setTimeout` sleeps; use `findBy*`/`waitFor`.
- Playwright for wallet/clipboard/network e2e; Vitest+RTL for component logic.

## Layout
```
src/components/*.tsx   # render only, no fetching primitives
src/lib/*.ts           # pure logic + hooks
src/main.tsx           # bootstrap
src/styles.css         # global
```
One symbol per file. A file is component OR hook/lib, never both.

## Pre-PR self-check
1. New runtime dep? → stop, justify.
2. All async either in a query or awaited? No floating promises.
3. Every discriminated union has `assertNever`?
4. Every `key` is a domain id?
5. Every `useEffect` subscribes to an external? Else delete.
6. Every write tx simulated first; `retry: 0`?
7. Every `queryKey` includes `chainId`?
8. Errors surfaced verbatim?
9. Anything (component, prop, hook, file) deletable without breaking tests? → delete it.

Any failure = not ready.
