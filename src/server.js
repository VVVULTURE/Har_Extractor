const express = require("express");
const path    = require("path");
const crypto  = require("crypto");
const { EventEmitter } = require("events");
const { crawlSite } = require("./crawler.js");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// HAR upload/extraction (option 2) is entirely client-side — see public/index.html.
// Website crawling (option 1) needs a real browser, so that part runs here.
app.use(express.static(path.join(__dirname, "../public")));

// ── Crawl job store ────────────────────────────────────────────────
// In-memory only: this is a locally-run personal tool, not a multi-user
// service, so jobs don't need to survive a restart.
const jobs = new Map(); // id -> job

const JOB_TTL_MS = 30 * 60 * 1000; // drop abandoned jobs after 30 min

function createJob() {
  const id = crypto.randomUUID();
  const job = {
    id,
    emitter: new EventEmitter(),
    log: [],
    status: "running", // running | done | error
    zip: null,
    createdAt: Date.now(),
  };
  job.emitter.setMaxListeners(50);
  jobs.set(id, job);
  return job;
}

function emitEvent(job, event) {
  job.log.push(event);
  job.emitter.emit("event", event);
}

setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.createdAt < cutoff) jobs.delete(id);
  }
}, 5 * 60 * 1000).unref();

// ── Start a crawl ──────────────────────────────────────────────────
app.post("/api/crawl", (req, res) => {
  const { url, maxPages } = req.body || {};

  if (typeof url !== "string" || !url.trim()) {
    return res.status(400).json({ error: "Missing url" });
  }

  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    return res.status(400).json({ error: "Invalid URL" });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return res.status(400).json({ error: "URL must start with http:// or https://" });
  }

  const safeMaxPages = Math.min(Math.max(parseInt(maxPages, 10) || 1, 1), 50);

  const job = createJob();
  res.json({ jobId: job.id });

  crawlSite({
    startUrl: parsed.toString(),
    maxPages: safeMaxPages,
    onEvent: (evt) => emitEvent(job, evt),
  })
    .then((result) => {
      job.zip = result.zipBuffer;
      job.status = "done";
      emitEvent(job, {
        type: "done",
        files: result.manifest,
        totalBytes: result.totalBytes,
        pagesCrawled: result.pagesCrawled,
      });
    })
    .catch((err) => {
      job.status = "error";
      emitEvent(job, { type: "error", message: err.message || String(err) });
    });
});

// ── Progress stream (SSE) ─────────────────────────────────────────
app.get("/api/crawl/:id/events", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).end();

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });

  for (const evt of job.log) {
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
  }

  if (job.status !== "running") {
    res.end();
    return;
  }

  const onEvent = (evt) => {
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
    if (evt.type === "done" || evt.type === "error") {
      cleanup();
      res.end();
    }
  };
  const cleanup = () => job.emitter.off("event", onEvent);

  job.emitter.on("event", onEvent);
  req.on("close", cleanup);
});

// ── Download the finished ZIP ─────────────────────────────────────
app.get("/api/crawl/:id/zip", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).end();
  if (job.status !== "done" || !job.zip) {
    return res.status(409).json({ error: "Crawl not finished yet" });
  }

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", 'attachment; filename="site-extracted.zip"');
  res.send(job.zip);
});

app.listen(PORT, () => {
  console.log(`HAR Extractor running on http://localhost:${PORT}`);
});
