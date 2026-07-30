import test from "node:test";
import assert from "node:assert/strict";
import { parseSubtitles, formatTimecode } from "../src/subtitles.js";

test("parses SubRip cues with comma-separated milliseconds", () => {
  const cues = parseSubtitles(
    ["1", "00:00:00,000 --> 00:00:03,540", "Hello everyone.", "", "2", "00:00:04,260 --> 00:00:07,740", "Second line.", ""].join("\n")
  );

  assert.equal(cues.length, 2);
  assert.deepEqual(cues[0], { index: 0, startMs: 0, endMs: 3540, text: "Hello everyone." });
  assert.equal(cues[1].startMs, 4260);
  assert.equal(cues[1].index, 1);
});

test("parses WebVTT cues with dot-separated milliseconds", () => {
  const cues = parseSubtitles(
    ["WEBVTT", "", "00:00:00.000 --> 00:00:03.540", "Hello everyone.", "", "00:01:02.100 --> 00:01:04.000", "Later on.", ""].join("\n")
  );

  assert.equal(cues.length, 2);
  assert.equal(cues[0].startMs, 0);
  assert.equal(cues[1].startMs, 62100);
});

test("SRT and VTT of the same content produce identical cues", () => {
  const srt = "1\n00:00:01,500 --> 00:00:04,250\nSame words here.\n";
  const vtt = "WEBVTT\n\n00:00:01.500 --> 00:00:04.250\nSame words here.\n";

  assert.deepEqual(parseSubtitles(srt), parseSubtitles(vtt));
});

test("handles hour-long timecodes", () => {
  const cues = parseSubtitles("1\n01:00:55,000 --> 01:00:58,000\nNearly done.\n");
  assert.equal(cues[0].startMs, 3_655_000);
});

test("pads fractional seconds rather than truncating them", () => {
  // ".5" means 500ms. Truncating would read it as 5ms.
  const cues = parseSubtitles("WEBVTT\n\n00:00:01.5 --> 00:00:02.25\nShort fractions.\n");
  assert.equal(cues[0].startMs, 1500);
  assert.equal(cues[0].endMs, 2250);
});

test("strips a BOM and tolerates CRLF line endings", () => {
  const cues = parseSubtitles("﻿1\r\n00:00:00,000 --> 00:00:02,000\r\nWindows file.\r\n\r\n");
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, "Windows file.");
});

test("joins multi-line cue text into one string", () => {
  const cues = parseSubtitles("1\n00:00:00,000 --> 00:00:04,000\nfirst part\nsecond part\n");
  assert.equal(cues[0].text, "first part second part");
});

test("skips WEBVTT header, NOTE and STYLE blocks", () => {
  const cues = parseSubtitles(
    [
      "WEBVTT",
      "",
      "NOTE this is a comment",
      "and it mentions 00:00:00.000 --> 00:00:01.000",
      "",
      "STYLE",
      "::cue { color: white }",
      "",
      "00:00:05.000 --> 00:00:06.000",
      "Real dialogue.",
      "",
    ].join("\n")
  );

  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, "Real dialogue.");
});

test("removes WebVTT inline markup and decodes entities", () => {
  const cues = parseSubtitles(
    'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n<v Instructor>use <c.code>&lt;View&gt;</c> here</v>\n'
  );
  assert.equal(cues[0].text, "use <View> here");
});

test("accepts a VTT cue identifier line before the timing line", () => {
  const cues = parseSubtitles("WEBVTT\n\nintro-1\n00:00:00.000 --> 00:00:02.000\nWith an id.\n");
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, "With an id.");
});

test("skips malformed blocks instead of throwing", () => {
  const cues = parseSubtitles(
    ["1", "not a timestamp at all", "orphan text", "", "2", "00:00:09,000 --> 00:00:10,000", "Good cue.", ""].join("\n")
  );

  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, "Good cue.");
  assert.equal(cues[0].index, 0, "indices are re-numbered over surviving cues");
});

test("drops cues whose text is empty", () => {
  const cues = parseSubtitles("1\n00:00:00,000 --> 00:00:02,000\n\n\n2\n00:00:03,000 --> 00:00:04,000\nkept\n");
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, "kept");
});

test("returns an empty array for empty or non-string input", () => {
  assert.deepEqual(parseSubtitles(""), []);
  assert.deepEqual(parseSubtitles("   \n\n"), []);
  assert.deepEqual(parseSubtitles(null), []);
  assert.deepEqual(parseSubtitles(undefined), []);
});

test("formatTimecode shows hours only when needed", () => {
  assert.equal(formatTimecode(0), "00:00");
  assert.equal(formatTimecode(262_000), "04:22");
  assert.equal(formatTimecode(3_862_000), "1:04:22");
  assert.equal(formatTimecode(-5), "00:00", "negative input clamps to zero");
});
