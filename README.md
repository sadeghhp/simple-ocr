# Simple OCR

[![CI](https://github.com/sadeghhp/simple-ocr/actions/workflows/ci.yml/badge.svg)](https://github.com/sadeghhp/simple-ocr/actions/workflows/ci.yml)
[![Deploy](https://github.com/sadeghhp/simple-ocr/actions/workflows/pages.yml/badge.svg)](https://github.com/sadeghhp/simple-ocr/actions/workflows/pages.yml)

A private, browser-only OCR workspace. Upload documents, store them in your browser, send them to your own LLM provider for text extraction, and edit the results — all without a backend.

**Live demo:** [sadeghhp.github.io/simple-ocr](https://sadeghhp.github.io/simple-ocr/)

Full product spec: [docs/Browser-Only OCR Document Application.md](docs/Browser-Only%20OCR%20Document%20Application.md)

## How it works

- **Local-first** — original files (as Blobs), extracted text, edits, and settings live in IndexedDB in your browser. Nothing is uploaded anywhere except OCR requests to the provider you configure.
- **Bring your own provider** — configure any OpenAI-compatible chat-completions endpoint (OpenAI, OpenRouter, Ollama, LM Studio, …). The endpoint must allow browser (CORS) requests. Images are sent as base64 data URLs; PDFs as base64 file parts.
- **No backend, no CDN** — the app builds to a fully static export; all assets are bundled locally.

Supported files: PNG, JPEG, WebP, GIF, PDF, TXT, MD (20 MB recommended max).

## Development

```bash
npm install
npm run dev        # dev server at http://localhost:3000
npm test           # vitest suite
npm run build      # static export to out/
```

Deploy by serving the `out/` directory from any static host. GitHub Pages deploys automatically on push to `main` (see `.github/workflows/pages.yml`).

### GitHub Pages (one-time setup)

If the deploy workflow fails with `Failed to create deployment (status: 404)`, Pages is not enabled yet:

1. Open [github.com/sadeghhp/simple-ocr/settings/pages](https://github.com/sadeghhp/simple-ocr/settings/pages)
2. Under **Build and deployment**, set **Source** to **GitHub Actions** (not “Deploy from a branch”)
3. Re-run the **Deploy to GitHub Pages** workflow from the Actions tab (or push an empty commit)

The repo must be **public** on a free GitHub account (private repos need a paid plan for Pages). After the first successful deploy, the site is at [sadeghhp.github.io/simple-ocr](https://sadeghhp.github.io/simple-ocr/).

To test a GitHub Pages build locally:

```bash
GITHUB_PAGES=true npm run build && npx serve out
# open http://localhost:3000/simple-ocr/
```

## Architecture

```
src/
  app/          Next.js App Router shell (static-export compatible)
  components/   Presentation layer — no direct DB or provider access
  hooks/        React state: app context, object URLs, storage estimate, debounced save
  lib/
    db/         All IndexedDB access (documents, files, settings stores; versioned schema)
    providers/  Provider adapter + config validation (normalized results/errors)
    files/      File validation and blob conversion
    export/     Zip export/import with manifest validation
    errors.js   Normalized AppError codes → user messages
    workflows.js  Application layer orchestrating upload/process/edit/delete
```

Key properties:

- Original files are never mutated; extraction and user edits are stored separately, so edits can always be reset and files reprocessed.
- Failed OCR never deletes data; every failure is a normalized error code with a retry action.
- Provider output is always rendered as plain text (no HTML injection surface).
- Exports are zip archives (`manifest.json` + original binaries) with a format version; API keys are never included.
- API keys are stored locally and sent only to the configured endpoint — a browser app cannot keep them truly secret, so use restricted keys.
