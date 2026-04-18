# pi-speak repo brief artifact

This is a small React + Vite artifact project for the `pi-speak-pk` repo.

## What it contains

- an interactive repo overview in `src/App.tsx`
- custom styling in `src/App.css` and `src/index.css`
- a portable single-file deliverable at `bundle.html` that is safe to open directly in a browser

## What the artifact covers

- the main operator surfaces: `/speak`, `/mono`, `/phone`, `/remote`, `/sess`
- the main request flows for local voice and remote phone use
- the most important runtime and UI files
- current hardening progress
- the remaining live phone validation gap

## Rebuild locally

```bash
npm install
npm run build
```

Then regenerate or replace `bundle.html` with the standalone browser-safe deliverable.

## Notes

This artifact was built as a repo explainer, not as part of the extension runtime itself.
