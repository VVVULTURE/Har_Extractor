# HAR//EXTRACT

A browser-based HAR (HTTP Archive) extractor that reconstructs captured response bodies into a downloadable ZIP archive.

HAR//EXTRACT parses `.har` files locally in the browser, displays an extraction manifest, and preserves the paths derived from each captured request URL. File contents are never uploaded to the server.

## Features

- Drag-and-drop or file-picker support for `.har` files
- Fully client-side HAR parsing and extraction
- No HAR contents sent to or stored on the server
- Extracts response bodies from `log.entries`
- Supports UTF-8 text and Base64-encoded response bodies
- Converts request URLs into local filesystem paths
- Removes duplicate paths and skips empty response bodies
- Displays entry count, extractable file count, MIME types, encodings, and sizes
- Creates and downloads a compressed ZIP archive in the browser
- Responsive dark interface with extraction progress and error states

## How it works

1. Select or drop a `.har` file into the application.
2. The browser parses the HAR JSON and examines its response entries.
3. Entries with non-empty response bodies are converted into local paths.
4. The application displays an extraction manifest.
5. Select **Download ZIP** to create and save the reconstructed archive.

The server only serves the static application. HAR processing and ZIP generation happen client-side using the bundled [`fflate`](https://github.com/101arrowz/fflate) library.

## Requirements

- Node.js 18 or newer
- npm
- A modern browser with support for the File API, `URL`, `TextEncoder`, `atob`, and client-side downloads

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

You can deploy the repository to Render using the included Blueprint configuration.

## Project structure

```text
.
├── public/
│   ├── index.html       # Client-side application UI and HAR processing logic
│   └── fflate.min.js    # Bundled ZIP creation library
├── src/
│   └── server.js        # Express static file server
├── package.json
└── render.yaml          # Render deployment configuration
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

For each entry, it uses the request URL and response content fields, including `text`, `size`, `mimeType`, and optional `encoding`. Base64-encoded response bodies are decoded before being added to the ZIP.

Entries without a response body, entries with a zero content size, invalid URLs, or duplicate local paths are not included in the output archive.

## Privacy and security

- HAR data is read directly from the selected local file.
- The Express server does not receive uploaded HAR contents.
- ZIP creation takes place in the browser.
- URL paths are sanitized before being used as archive paths, including removal of null bytes and collapsing of parent-directory segments.

Always treat HAR files as sensitive: they may contain cookies, authorization headers, query parameters, and other private request data. Avoid sharing generated archives unless their contents have been reviewed.

## License

No license file is currently included in this repository. Add a license before distributing or reusing the project under specific open-source terms.
