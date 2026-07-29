import fs from "node:fs/promises";

/**
 * Parsing for the two subtitle formats the course ships: SubRip (.srt) and
 * WebVTT (.vtt). They differ only in small details, so one parser handles both.
 *
 * The whole point of this module is that **timestamps survive**. The old
 * document pipeline collapsed a file to one long string; here every line keeps
 * the millisecond range it was spoken in, which is what makes a citation
 * clickable later on.
 */

// 00:01:02,345 (SRT) or 00:01:02.345 (VTT), and VTT's hour-less 01:02.345.
const TIMESTAMP = /(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})/;

// A cue's timing line: "<start> --> <end>" plus optional VTT cue settings.
const TIMING_LINE = new RegExp(
  `^\\s*${TIMESTAMP.source}\\s*-->\\s*${TIMESTAMP.source}\\s*(.*)$`
);

/** WebVTT blocks that carry no dialogue and should be skipped entirely. */
const VTT_NON_CUE = /^(WEBVTT|NOTE|STYLE|REGION)\b/;

/**
 * Turn a matched timestamp into milliseconds.
 * Fractions are padded, not truncated: ".5" means 500ms, not 5ms.
 */
function toMs(hours, minutes, seconds, fraction) {
  const ms = Number(String(fraction).padEnd(3, "0").slice(0, 3));
  return (
    Number(hours ?? 0) * 3_600_000 +
    Number(minutes) * 60_000 +
    Number(seconds) * 1000 +
    ms
  );
}

/**
 * Strip WebVTT inline markup so the embedded text is clean prose.
 * Handles voice spans (`<v Speaker>`), styling tags and karaoke timestamps.
 */
function stripCueMarkup(text) {
  return text
    .replace(/<\/?[cvibu](?:\.[^>\s]+)?(?:\s+[^>]*)?>/gi, "")
    .replace(/<\d{1,3}:\d{1,2}:\d{1,2}[.,]\d{1,3}>/g, "")
    .replace(/<\/?ruby(?:\s+[^>]*)?>|<\/?rt(?:\s+[^>]*)?>/gi, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

/**
 * Parse SRT or WebVTT text into an ordered list of cues.
 *
 * Malformed blocks are skipped rather than thrown on — a single bad cue in a
 * 700-cue lecture shouldn't cost us the whole lesson.
 *
 * @param {string} raw
 * @returns {Array<{ index: number, startMs: number, endMs: number, text: string }>}
 */
export function parseSubtitles(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return [];

  const normalised = raw
    .replace(/^﻿/, "") // strip BOM
    .replace(/\r\n?/g, "\n"); // CRLF / CR -> LF

  const cues = [];

  for (const block of normalised.split(/\n{2,}/)) {
    const lines = block.split("\n");

    // Find the timing line. It's line 0 in VTT, line 1 in SRT (after the
    // sequence number), and line 1 in VTT too when the cue has an identifier.
    const timingAt = lines.findIndex((line) => TIMING_LINE.test(line));
    if (timingAt === -1) continue;

    // A NOTE/STYLE block can contain something that looks like a timing line
    // in its body; drop the block if it is introduced as a non-cue.
    if (VTT_NON_CUE.test(lines[0].trim()) && timingAt > 0) continue;

    const m = lines[timingAt].match(TIMING_LINE);
    const startMs = toMs(m[1], m[2], m[3], m[4]);
    const endMs = toMs(m[5], m[6], m[7], m[8]);

    const text = stripCueMarkup(lines.slice(timingAt + 1).join(" "))
      .replace(/\s+/g, " ")
      .trim();

    if (!text) continue;

    cues.push({ index: cues.length, startMs, endMs, text });
  }

  return cues;
}

/** Read a .srt/.vtt file from disk and parse it. */
export async function readSubtitleFile(filePath) {
  return parseSubtitles(await fs.readFile(filePath, "utf8"));
}

/**
 * Format milliseconds as a timecode for display and for citations.
 * Hours are only shown when the lesson is actually an hour long.
 *
 * @example formatTimecode(262000) // "04:22"
 * @example formatTimecode(3862000) // "1:04:22"
 */
export function formatTimecode(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n) => String(n).padStart(2, "0");

  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}
