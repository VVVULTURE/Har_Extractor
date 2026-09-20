/*
 * pathUtils — shared between the browser (public/index.html, via <script>)
 * and the server (src/crawler.js, via require()). Keeping one copy avoids
 * the client and server ever disagreeing on how a URL maps to a zip path.
 *
 * Exports: urlToLocalPath(rawUrl), dedupePath(path, usedSet)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.HarExtractPathUtils = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Characters illegal in Windows filenames, plus control chars and any
  // stray path separators that could otherwise split a segment apart.
  var ILLEGAL_CHARS = /[\x00-\x1f<>:"|?*\\/]/g;

  function sanitizeSegment(seg) {
    var cleaned = seg.replace(ILLEGAL_CHARS, '_');
    // Windows forbids segments that are only dots/spaces or that end in one.
    cleaned = cleaned.replace(/[. ]+$/, '') || '_';
    return cleaned;
  }

  // Deterministic FNV-1a hash -> 8 hex chars. Used to keep long/unsafe
  // query strings from producing unreasonably long filenames.
  function shortHash(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h +
        ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) | 0;
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  /**
   * Convert a full URL into a relative, collision-resistant, filesystem-safe
   * local path:
   *   - hostname becomes the top-level folder (prevents two different
   *     origins serving the same pathname from overwriting each other)
   *   - the query string (if any) is folded into the filename so that
   *     e.g. "css2?family=A" and "css2?family=B" no longer collide
   *   - every path segment is sanitised for illegal filesystem characters
   */
  function urlToLocalPath(rawUrl) {
    var parsed;
    try {
      parsed = new URL(rawUrl);
    } catch (e) {
      return null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }

    var host = sanitizeSegment(parsed.hostname || 'unknown-host');

    var pathname = parsed.pathname || '/';
    pathname = pathname.replace(/^\/+/, '');
    if (!pathname) pathname = 'index.html';
    if (pathname.endsWith('/')) pathname += 'index.html';
    pathname = pathname.replace(/\0/g, '');

    var parts = pathname.split('/').reduce(function (acc, part) {
      if (part === '..') acc.pop();
      else if (part && part !== '.') acc.push(sanitizeSegment(part));
      return acc;
    }, []);

    if (parts.length === 0) parts.push('index.html');

    var query = parsed.search; // includes leading '?', or ''
    if (query && query.length > 1) {
      var lastIdx = parts.length - 1;
      var last = parts[lastIdx];
      var dotIdx = last.lastIndexOf('.');
      var base = dotIdx > 0 ? last.slice(0, dotIdx) : last;
      var ext = dotIdx > 0 ? last.slice(dotIdx) : '';

      var qSuffix = query.slice(1).replace(/[^A-Za-z0-9._-]/g, '_');
      if (qSuffix.length > 60) qSuffix = shortHash(query);

      parts[lastIdx] = base + '__' + qSuffix + ext;
    }

    return [host].concat(parts).join('/');
  }

  /**
   * Guarantee a unique path within `usedSet` by appending _2, _3, ... before
   * the extension if `path` was already taken. Never silently drops a file.
   */
  function dedupePath(candidatePath, usedSet) {
    if (!usedSet.has(candidatePath)) {
      usedSet.add(candidatePath);
      return candidatePath;
    }
    var slashIdx = candidatePath.lastIndexOf('/');
    var dotIdx = candidatePath.lastIndexOf('.');
    var hasExt = dotIdx > slashIdx;
    var base = hasExt ? candidatePath.slice(0, dotIdx) : candidatePath;
    var ext = hasExt ? candidatePath.slice(dotIdx) : '';

    var n = 2;
    var candidate;
    do {
      candidate = base + '_' + n + ext;
      n++;
    } while (usedSet.has(candidate));
    usedSet.add(candidate);
    return candidate;
  }

  return {
    urlToLocalPath: urlToLocalPath,
    dedupePath: dedupePath,
    shortHash: shortHash,
    sanitizeSegment: sanitizeSegment,
  };
});
