'use strict';

const path = require('path');
const puppeteer = require('puppeteer');
const { zip } = require('fflate');
const { urlToLocalPath, dedupePath } = require(
  path.join(__dirname, '..', 'public', 'pathUtils.js')
);

// Safety caps — this tool runs a real browser against a URL the caller
// supplies, so these bound worst-case time/memory regardless of what the
// client asked for.
const HARD_MAX_PAGES = 50;
const HARD_MAX_FILES = 3000;
const HARD_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB — real sites (e.g. a
  // WebGL game split into 20+ chunked asset files) can easily be several
  // hundred MB; this is a locally-run personal tool, not a shared service.
const NAV_TIMEOUT_MS = 45000;
const CDP_BUFFER_TIMEOUT_MS = 10000;     // the fast path — should fail fast if it fails
const FALLBACK_FETCH_TIMEOUT_MS = 180000; // the slow path — large files over a real network
const IDLE_THRESHOLD_MS = 1500;   // quiet period that counts as "settled"
const MAX_SETTLE_MS = 5 * 60 * 1000; // cap on how long we'll wait for a page to settle —
  // generous because sites that fetch many large files one at a time (not in
  // parallel) can legitimately take minutes to finish issuing every request.

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

/**
 * Chrome's DevTools Protocol only keeps a limited amount of response body
 * data in its "inspector cache" before evicting it — and the limit that
 * matters is on Puppeteer's own internal session, which is not something
 * a second CDP session can override. Multi-megabyte assets (game data
 * files, video, etc.) routinely get evicted before response.buffer() is
 * called, failing with "Request content was evicted from inspector cache"
 * even though the browser successfully downloaded the file moments ago.
 *
 * The reliable fix is to re-fetch the same URL directly, bypassing CDP's
 * body cache entirely. This covers the common case (public, unauthenticated
 * assets) fully; cookies are forwarded so most same-site authenticated
 * assets work too. It won't help for resources that truly require
 * browser-only state (e.g. client certs) — those are skipped with a
 * warning like any other unrecoverable entry.
 */
async function fetchBody(response, cookieHeader) {
  try {
    return await withTimeout(response.buffer(), CDP_BUFFER_TIMEOUT_MS);
  } catch {
    const req = response.request();
    const headers = { 'User-Agent': (req.headers() || {})['user-agent'] || '' };
    if (cookieHeader) headers.Cookie = cookieHeader;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FALLBACK_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(response.url(), {
        method: req.method(),
        headers,
        signal: controller.signal,
      });
      const arrayBuf = await res.arrayBuffer();
      return Buffer.from(arrayBuf);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Crawl a site with a real headless browser and capture every network
 * response body it makes, including ones assembled from URLs that are
 * built dynamically in JavaScript (e.g. a loop that fetches
 * "part1", "part2", ... one at a time) — a static HTML/CSS link scraper
 * cannot see those because the URLs never appear as literal text anywhere
 * on the page.
 *
 * @param {object} opts
 * @param {string} opts.startUrl
 * @param {number} [opts.maxPages]
 * @param {(evt: object) => void} [opts.onEvent] progress callback
 */
async function crawlSite({ startUrl, maxPages = 1, onEvent = () => {} }) {
  const cappedMaxPages = Math.min(Math.max(parseInt(maxPages, 10) || 1, 1), HARD_MAX_PAGES);
  const startOrigin = new URL(startUrl).origin;

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const visitedPages = new Set();
  const capturedUrls = new Set();
  const usedPaths = new Set();
  const files = []; // { url, localPath, mimeType, size, bytes }
  let totalBytes = 0;
  const pageQueue = [startUrl];
  let pagesCrawled = 0;
  let capExceeded = false;

  try {
    while (pageQueue.length > 0 && pagesCrawled < cappedMaxPages && !capExceeded) {
      const pageUrl = pageQueue.shift();
      const normalizedForVisit = pageUrl.split('#')[0];
      if (visitedPages.has(normalizedForVisit)) continue;
      visitedPages.add(normalizedForVisit);
      pagesCrawled++;

      onEvent({ type: 'page-start', url: pageUrl, index: pagesCrawled, total: cappedMaxPages });

      const page = await browser.newPage();
      await page.setCacheEnabled(false);
      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/131.0.0.0 Safari/537.36 HarExtractCrawler/1.0'
      );
      await page.setViewport({ width: 1366, height: 900 });

      let lastActivity = Date.now();
      let cookieHeader = '';
      const pending = [];

      page.on('response', (response) => {
        lastActivity = Date.now();
        const task = (async () => {
          if (capExceeded) return;
          const reqUrl = response.url();
          if (capturedUrls.has(reqUrl)) return;
          if (files.length >= HARD_MAX_FILES) { capExceeded = true; return; }

          let buf;
          try {
            buf = await fetchBody(response, cookieHeader);
          } catch {
            return; // no body available (redirect, opaque, websocket upgrade, etc.)
          }
          if (!buf || buf.length === 0) return;
          if (totalBytes + buf.length > HARD_MAX_TOTAL_BYTES) { capExceeded = true; return; }

          capturedUrls.add(reqUrl);

          const localPathRaw = urlToLocalPath(reqUrl);
          if (!localPathRaw) return;
          const localPath = dedupePath(localPathRaw, usedPaths);

          const headers = response.headers();
          const mimeType = headers['content-type'] || 'application/octet-stream';

          files.push({ url: reqUrl, localPath, mimeType, size: buf.length, bytes: buf });
          totalBytes += buf.length;

          onEvent({
            type: 'asset',
            url: reqUrl,
            localPath,
            mimeType,
            size: buf.length,
            totalFiles: files.length,
            totalBytes,
          });
        })();
        pending.push(task);
      });

      page.on('requestfailed', (request) => {
        const failure = request.failure();
        onEvent({
          type: 'warn',
          message: `Request failed: ${request.url()}${failure ? ' (' + failure.errorText + ')' : ''}`,
        });
      });

      try {
        await page.goto(pageUrl, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
      } catch (err) {
        onEvent({ type: 'warn', message: `Navigation issue for ${pageUrl}: ${err.message}` });
      }

      try {
        const cookies = await page.cookies();
        cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      } catch {
        // non-fatal — fallback fetches just won't carry a session
      }

      // Keep waiting as long as new network activity keeps arriving — this
      // is what catches sites that fetch additional files in JS after the
      // page's "load" event fires (e.g. a loading-bar style asset fetcher).
      const settleStart = Date.now();
      while (
        Date.now() - lastActivity < IDLE_THRESHOLD_MS &&
        Date.now() - settleStart < MAX_SETTLE_MS &&
        !capExceeded
      ) {
        await sleep(250);
      }

      await Promise.allSettled(pending);

      // Discover same-origin links for further crawling.
      if (pagesCrawled < cappedMaxPages && !capExceeded) {
        try {
          const links = await page.$$eval('a[href]', (as) => as.map((a) => a.href));
          for (const link of links) {
            try {
              const abs = new URL(link);
              if (abs.protocol !== 'http:' && abs.protocol !== 'https:') continue;
              if (abs.origin !== startOrigin) continue;
              const normalized = abs.toString().split('#')[0];
              if (!visitedPages.has(normalized) && !pageQueue.includes(normalized)) {
                pageQueue.push(normalized);
              }
            } catch {
              // malformed href, ignore
            }
          }
        } catch {
          // page navigated away / closed already, ignore
        }
      }

      await page.close();
      onEvent({ type: 'page-done', url: pageUrl, filesSoFar: files.length, bytesSoFar: totalBytes });
    }

    if (capExceeded) {
      onEvent({
        type: 'warn',
        message: 'Safety limit reached (max files or max total size) — stopping crawl early.',
      });
    }

    onEvent({ type: 'status', message: 'Compressing ZIP archive…' });

    const zipInput = {};
    for (const f of files) zipInput[f.localPath] = new Uint8Array(f.bytes);

    const zipBuffer = await new Promise((resolve, reject) => {
      zip(zipInput, { level: 6 }, (err, data) => {
        if (err) reject(err);
        else resolve(Buffer.from(data));
      });
    });

    return {
      zipBuffer,
      totalBytes,
      pagesCrawled,
      manifest: files.map((f) => ({
        path: f.localPath,
        url: f.url,
        mimeType: f.mimeType,
        size: f.size,
      })),
    };
  } finally {
    await browser.close();
  }
}

module.exports = { crawlSite };
