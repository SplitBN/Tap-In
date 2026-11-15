# Tap In

Personal gym / food / supplement log. Installable web app (PWA), local-first, works offline.
Spec and science sources: [docs/SPEC.md](docs/SPEC.md).

```bash
npm install
npm run dev      # http://localhost:5173 (also on your LAN)
npm run build    # static output in dist/ — deploy to GitHub Pages or Cloudflare Pages
```

- Exercise library: [free-exercise-db](https://github.com/yuhonas/free-exercise-db) (Unlicense), rebuilt with `node scripts/build-exercises.mjs <exercises.json>`.
- Icons: edit `public/icon.svg`, then `node scripts/icons.mjs`.
