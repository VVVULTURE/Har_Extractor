# HAR//EXTRACT

A tool that reconstructs a website's filesystem into a downloadable ZIP archive, two ways:

1. **Crawl a URL** — point it at a live page and it drives a real headless browser (Puppeteer), recording every network response the page actually makes. This catches files a page fetches dynamically from JavaScript (e.g. a loop that requests `part1`, `part2`, ... one at a time) that would never appear as literal text anywhere a static link-scraper could find them.
2. **Upload a `.har` file** — parsed and zipped entirely in the browser from a HAR you already captured in DevTools. No file data leaves the browser for this path.

## Features

- **Crawl mode**: real headless-browser capture of every network response (any MIME type, any origin), with live progress streamed to the UI, same-origin multi-page crawling, and automatic fallback re-fetching for large response bodies that Chrome's DevTools protocol would otherwise fail to hand back
- **HAR mode**: drag-and-drop or file-picker `.har` upload, fully client-side parsing and ZIP creation, no HAR contents sent to the server
- Both modes share the same URL → local-path resolution (`public/pathUtils.js`), so a resource is never silently dropped because two different origins or two different query strings happened to produce the same filename — collisions are disambiguated, never discarded
- Displays an extraction manifest: entry/page count, extractable file count, MIME types, sizes, and a text/binary badge
- Creates and downloads a compressed ZIP archive
- Responsive dark interface with progress and error states

## How it works

### Crawl mode
1. Enter a URL and (optionally) a max page count, then click **Crawl**.
2. The server launches headless Chromium, navigates to the URL, and records every response — including ones issued after the page's `load` event, as long as new network activity keeps arriving.
3. Progress streams back to the browser over Server-Sent Events as files are captured.
4. When the browser goes quiet, the server zips everything and the manifest renders; click **Download ZIP**.

### HAR mode
1. Select or drop a `.har` file into the application.
2. The browser parses the HAR JSON and examines its response entries.
3. Entries with a captured response body are converted into local paths.
4. The application displays an extraction manifest.
5. Select **Download ZIP** to create and save the reconstructed archive — built entirely client-side using the bundled [`fflate`](https://github.com/101arrowz/fflate) library.

## Requirements

- Node.js 18 or newer
- npm
- Crawl mode downloads a Chromium build via Puppeteer on first `npm install` (or reuses one already cached locally)
- A modern browser with support for the File API, `URL`, `TextEncoder`, `atob`, `EventSource`, and client-side downloads

## Local development

Clone the repository and install dependencies:

```bash
git clone https://github.com/VVVULTURE/Har_Extractor.git
cd Har_Extractor
npm install
```

Start the server:

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

For development with Node's file-watching mode:

```bash
npm run dev
```

The server uses the `PORT` environment variable when provided; otherwise it listens on port `3000`.

## Deployment

The repository includes a [`render.yaml`](./render.yaml) configuration for Render. It defines a Node web service that runs:

- Build command: `npm install`
- Start command: `npm start`
- Health check path: `/`

Note: crawl mode needs enough memory/disk for a headless Chromium instance and whatever it downloads (bounded by the safety caps below) — a free-tier instance may not be sufficient for large sites.

## Project structure

```text
.
├── public/
│   ├── index.html       # UI + client-side HAR processing logic
│   ├── pathUtils.js      # URL → local-path resolution, shared by browser and server
│   └── fflate.min.js     # Bundled ZIP creation library (browser)
├── src/
│   ├── server.js         # Express server: static files + crawl job API (SSE + zip download)
│   └── crawler.js        # Headless-browser crawl implementation (Puppeteer)
├── package.json
└── render.yaml            # Render deployment configuration
```

## HAR compatibility

The extractor expects a standard HAR structure with entries under:

```json
{
  "log": {
    "entries": []
  }
}
```

For each entry, it uses the request URL and response content fields, including `text`, `mimeType`, and optional `encoding`. Base64-encoded response bodies are decoded before being added to the ZIP.

Entries with no captured response body, or with a URL that can't be resolved to a path, are skipped. Everything else is included — a path collision (e.g. two origins serving the same route, or the same route with different query strings) is disambiguated with a numeric suffix rather than dropped.

## Crawl mode safety limits

Crawling drives a real browser against a URL you supply, so the server enforces hard caps regardless of what's requested: up to 50 pages, 3000 files, and 2 GB of captured data per crawl job, with per-navigation and per-page-settle timeouts. Crawl jobs and their in-memory results are dropped after 30 minutes.

## Privacy and security

- HAR data is read directly from the selected local file; the server never receives its contents.
- Crawl mode *does* send data through the server — it has to, since a real browser drives the fetch — but nothing is persisted beyond the in-memory job TTL, and this tool is meant to run locally for personal use, not as a shared multi-tenant service.
- URL paths are sanitized before being used as archive paths: illegal filesystem characters are stripped, and parent-directory (`..`) segments are collapsed.

Always treat HAR files (and crawl output from an authenticated page) as sensitive: they may contain cookies, authorization headers, query parameters, and other private request data. Avoid sharing generated archives unless their contents have been reviewed.

## License

No license file is currently included in this repository. Add a license before distributing or reusing the project under specific open-source terms.
