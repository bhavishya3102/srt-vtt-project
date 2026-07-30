import test from "node:test";
import assert from "node:assert/strict";
import { normaliseRewrite, pinpointSentence, reciprocalRankFusion } from "../src/retriever.js";
import { normaliseClassification } from "../src/router.js";

/**
 * These cover the deterministic half of retrieval — variant selection, routing
 * and timestamp pinpointing — by feeding in fixtures of what the model returns.
 * No API key, no network, so `npm test` is always runnable.
 */

/* --------------------------------------------- conditional decomposition --- */

const variantsFor = (rewrite) =>
  ["rewritten", "stepBack", "hyde", ...rewrite.subQueries.map((_, i) => `subQuery${i + 1}`)];

test("a single-intent question yields three variants and no sub-query", () => {
  const rewrite = normaliseRewrite(
    {
      rewritten: "How do dynamic routes work in Expo Router?",
      stepBack: "What is file-based routing?",
      isCompound: false,
      subQuery: "",
    },
    "dynamic routes kaise banate hain"
  );

  assert.equal(rewrite.isCompound, false);
  assert.deepEqual(rewrite.subQueries, []);
  assert.deepEqual(variantsFor(rewrite), ["rewritten", "stepBack", "hyde"]);
});

test("a compound question adds exactly one sub-query", () => {
  const rewrite = normaliseRewrite(
    {
      rewritten: "How do dynamic routes work and how do I add authentication?",
      stepBack: "How is navigation structured in Expo?",
      isCompound: true,
      subQuery: "How do I add authentication in Expo?",
    },
    "dynamic routes aur auth"
  );

  assert.equal(rewrite.subQueries.length, 1);
  assert.deepEqual(variantsFor(rewrite), ["rewritten", "stepBack", "hyde", "subQuery1"]);
});

test("a sub-query supplied alongside isCompound:false is discarded", () => {
  // The count is driven by the flag, not by whether the field happens to be set.
  const rewrite = normaliseRewrite(
    { rewritten: "x", stepBack: "y", isCompound: false, subQuery: "leftover text" },
    "q"
  );
  assert.deepEqual(rewrite.subQueries, []);
});

test("isCompound:true with an empty sub-query does not create a blank variant", () => {
  const rewrite = normaliseRewrite(
    { rewritten: "x", stepBack: "y", isCompound: true, subQuery: "   " },
    "q"
  );
  assert.deepEqual(rewrite.subQueries, []);
});

test("falls back to the original question when the rewrite is empty", () => {
  const rewrite = normaliseRewrite({}, "original question");
  assert.equal(rewrite.rewritten, "original question");
  assert.equal(rewrite.stepBack, "");
  assert.deepEqual(rewrite.subQueries, []);
});

/* ------------------------------------------------------------- the router --- */

test("routes catalog questions to metadata and how-to questions to content", () => {
  assert.equal(
    normaliseClassification({ allowed: true, reason: "", intent: "metadata" }).intent,
    "metadata"
  );
  assert.equal(
    normaliseClassification({ allowed: true, reason: "", intent: "content" }).intent,
    "content"
  );
});

test("an unrecognised intent falls back to content", () => {
  // Content degrades gracefully; metadata simply cannot answer a "how" question.
  assert.equal(normaliseClassification({ allowed: true, intent: "both" }).intent, "content");
  assert.equal(normaliseClassification({ allowed: true }).intent, "content");
  assert.equal(normaliseClassification({}).intent, "content");
});

test("a blocked classification always carries a usable reason", () => {
  const withReason = normaliseClassification({
    allowed: false,
    reason: "I only cover this course.",
    intent: "content",
  });
  assert.equal(withReason.allowed, false);
  assert.equal(withReason.reason, "I only cover this course.");

  const withoutReason = normaliseClassification({ allowed: false, reason: "", intent: "content" });
  assert.equal(withoutReason.allowed, false);
  assert.ok(withoutReason.reason.length > 0, "a refusal must never be blank");
});

test("PINNED: the gate fails open — anything but an explicit false is allowed", () => {
  // Wrongly allowing a question costs an honest "not covered". Wrongly blocking
  // one is a dead end for the user, so ambiguity must resolve to allowed.
  assert.equal(normaliseClassification({}).allowed, true);
  assert.equal(normaliseClassification({ allowed: undefined }).allowed, true);
  assert.equal(normaliseClassification(null).allowed, true);
  assert.equal(normaliseClassification({ allowed: false }).allowed, false);
});

test("an allowed classification carries no refusal text", () => {
  assert.equal(normaliseClassification({ allowed: true, reason: "ignored" }).reason, "");
});

/* --------------------------------------------------------------- pinpoint --- */

const cues = [
  { index: 0, startMs: 10_000, endMs: 13_000, text: "Let's talk about dynamic routes." },
  { index: 1, startMs: 13_200, endMs: 16_000, text: "A folder in square brackets becomes a parameter." },
  { index: 2, startMs: 16_200, endMs: 19_000, text: "So you can read it with useLocalSearchParams." },
  { index: 3, startMs: 19_200, endMs: 22_000, text: "That is how the routing works here." },
];

const chunk = { cueStart: 0, cueEnd: 3, startMs: 10_000 };

test("an exact quote resolves to the cue that sentence begins in", () => {
  const pin = pinpointSentence("A folder in square brackets becomes a parameter.", cues, chunk);
  assert.equal(pin.cueIndex, 1);
  assert.equal(pin.startMs, 13_200);
  assert.equal(pin.exact, true);
});

test("a lightly reworded quote still lands on the right sentence", () => {
  const pin = pinpointSentence("folder in square brackets becomes parameter", cues, chunk);
  assert.equal(pin.cueIndex, 1);
  assert.equal(pin.startMs, 13_200);
});

test("an unrelated quote falls back to the chunk's own start", () => {
  const pin = pinpointSentence("completely unrelated words about databases", cues, chunk);
  assert.equal(pin.startMs, chunk.startMs);
  assert.equal(pin.cueIndex, chunk.cueStart);
  assert.equal(pin.exact, false);
});

test("pinpointing is offset by cueStart when the chunk starts mid-lesson", () => {
  const laterChunk = { cueStart: 2, cueEnd: 3, startMs: 16_200 };
  const pin = pinpointSentence("That is how the routing works here.", cues, laterChunk);
  assert.equal(pin.cueIndex, 3, "index must be absolute, not relative to the window");
  assert.equal(pin.startMs, 19_200);
});

test("missing or empty inputs fall back instead of throwing", () => {
  for (const quote of ["", "   ", null, undefined]) {
    assert.equal(pinpointSentence(quote, cues, chunk).startMs, chunk.startMs);
  }
  assert.equal(pinpointSentence("anything", null, chunk).startMs, chunk.startMs);
  assert.equal(pinpointSentence("anything", [], chunk).startMs, chunk.startMs);
});

/* -------------------------------------------------------------------- RRF --- */

const hit = (id, score) => ({ id, score, payload: { lessonId: `l-${id}` } });

test("a chunk found by two variants outranks one found by a single variant", () => {
  const fused = reciprocalRankFusion([
    { label: "rewritten", hits: [hit("a", 0.9), hit("b", 0.8)] },
    { label: "hyde", hits: [hit("b", 0.7), hit("c", 0.6)] },
  ]);

  assert.equal(fused[0].id, "b", "agreement across variants is the signal RRF rewards");
  assert.deepEqual(fused[0].matchedBy, ["rewritten", "hyde"]);
});

test("keeps the best raw similarity seen across variants", () => {
  const fused = reciprocalRankFusion([
    { label: "rewritten", hits: [hit("a", 0.42)] },
    { label: "stepBack", hits: [hit("a", 0.91)] },
  ]);

  assert.equal(fused.length, 1);
  assert.equal(fused[0].bestScore, 0.91);
});

test("results come back sorted by fused score", () => {
  const fused = reciprocalRankFusion([
    { label: "rewritten", hits: [hit("a", 0.1), hit("b", 0.1), hit("c", 0.1)] },
  ]);

  assert.deepEqual(
    fused.map((f) => f.id),
    ["a", "b", "c"]
  );
  assert.ok(fused[0].rrfScore > fused[1].rrfScore);
});

test("empty and all-empty inputs produce no results", () => {
  assert.deepEqual(reciprocalRankFusion([]), []);
  assert.deepEqual(reciprocalRankFusion([{ label: "rewritten", hits: [] }]), []);
});
