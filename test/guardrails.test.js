import test from "node:test";
import assert from "node:assert/strict";
import { maskPII, countMasked, describeMasked } from "../src/guardrails.js";

const masked = (text) => maskPII(text);
const wasMasked = (text) => maskPII(text).found.length > 0;
const untouched = (text) => {
  const result = maskPII(text);
  return result.found.length === 0 && result.text === text;
};

/* ------------------------------------------------------------ must mask --- */

test("masks email addresses", () => {
  const result = masked("mera email bhavishya@example.com hai");
  assert.equal(result.text, "mera email [email redacted] hai");
  assert.deepEqual(result.found, [{ type: "email", count: 1 }]);
});

test("masks OpenAI-style API keys", () => {
  assert.ok(wasMasked("key sk-proj-AbCdEf1234567890XyZaBcDeFg use karo"));
  assert.ok(wasMasked("sk-AbCdEf1234567890XyZaBcDeFgHi"));
});

test("masks GitHub and Slack tokens", () => {
  assert.ok(wasMasked("ghp_AbCdEf1234567890XyZaBcDe"));
  assert.ok(wasMasked("github_pat_11ABCDEFG0123456789abcdef"));
  assert.ok(wasMasked("xoxb-1234567890-abcdefghij"));
});

test("masks JWTs", () => {
  assert.ok(
    wasMasked("token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQdQw4w9WgXcQ")
  );
});

test("masks a credential after a keyword, including a Bearer scheme", () => {
  const bearer = masked("Authorization: Bearer abc123def456ghi789");
  assert.match(bearer.text, /\[redacted\]/);
  assert.ok(!bearer.text.includes("abc123def456ghi789"));

  assert.ok(wasMasked("api_key = mySuperSecretValue123"));
  assert.ok(wasMasked('password: "hunter2hunter2"'));
});

test("masks long opaque digests", () => {
  assert.ok(wasMasked("d41d8cd98f00b204e9800998ecf8427ed41d8cd98f00b204e9800998ecf8427e"));
});

test("masks phone numbers in both accepted shapes", () => {
  assert.ok(wasMasked("call me on 9876543210 please"));
  assert.ok(wasMasked("+91 98765 43210 par call karo"));
  assert.ok(wasMasked("+1 555-867-5309"));
});

/* -------------------------------------------------- must NOT mask (pinned) --- */
//
// This app is built out of things that look like personal data. A naive phone
// pattern eats every case below, and corrupting a timestamp would break the one
// feature the whole project exists for. These are regression pins, not examples.

test("PINNED: subtitle timestamps survive untouched", () => {
  assert.ok(untouched("cue at 00:00:06,420 --> 00:00:09,180 dekho"));
  assert.ok(untouched("00:12:45.500 --> 00:12:49.220"));
  assert.ok(untouched("1:04:22 par hai"));
  assert.ok(untouched("answer 04:22 par hai, module 4 me"));
});

test("PINNED: hex colours survive untouched", () => {
  assert.ok(untouched("accent is #c3f53c and ground #0b0c0e"));
  assert.ok(untouched("#deadbeef"));
});

test("PINNED: ports and IP addresses survive untouched", () => {
  assert.ok(untouched("server on 8081 and vite on 5173"));
  assert.ok(untouched("bind to 0.0.0.0 and 127.0.0.1"));
  assert.ok(untouched("qdrant runs on 6333 and 6334"));
});

test("PINNED: version numbers survive untouched", () => {
  assert.ok(untouched("expo SDK 1.2.3 aur react 19.2.7"));
  assert.ok(untouched("upgrade from 52.0.0 to 53.0.11"));
});

test("ordinary questions are never altered", () => {
  assert.ok(untouched("module 5 me kitne lessons hain?"));
  assert.ok(untouched("dynamic routes kaise banate hain?"));
  assert.ok(untouched("cue 1381 of 19203 chunks"));
  assert.ok(untouched("How do I use expo-secure-store?"));
});

test("years and short digit runs are not phone numbers", () => {
  assert.ok(untouched("2024 2025 2026 2027"));
  assert.ok(untouched("chapter 3 lesson 12"));
});

/* ---------------------------------------------------------------- shape --- */

test("handles empty and non-string input without throwing", () => {
  assert.deepEqual(maskPII(""), { text: "", found: [] });
  assert.deepEqual(maskPII(null), { text: "", found: [] });
  assert.deepEqual(maskPII(undefined), { text: "", found: [] });
});

test("is idempotent — masking twice changes nothing further", () => {
  const once = maskPII("email me at a@b.com or call 9876543210").text;
  assert.equal(maskPII(once).text, once);
});

test("counts and describes what was masked", () => {
  const result = maskPII("a@b.com and c@d.com and 9876543210");
  assert.equal(countMasked(result.found), 3);
  assert.match(describeMasked(result.found), /2 emails/);
  assert.match(describeMasked(result.found), /1 phone number/);
});

test("global regexes do not carry state between calls", () => {
  // A stale lastIndex on a module-level /g regex would make the second call miss.
  const first = maskPII("first a@b.com here");
  const second = maskPII("second c@d.com here");
  assert.equal(first.found.length, 1);
  assert.equal(second.found.length, 1);
});
