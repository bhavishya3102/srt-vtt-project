# Cue — ask your video course anything

Point this at the subtitle files of a video course and ask it questions. Every answer tells you
**which module, which chapter, and the exact second** the instructor said it — and the timestamp is
clickable: the transcript opens beside the chat with that line highlighted.

Ask in English or Hinglish; the answer comes back in whichever you used.

```
┌─ 18 modules ───┬─ CONVERSATION ──────────┬─ TRANSCRIPT ────────┐
│ ▾ Expo Mastery │  ? dynamic routes?      │ MODULE 4            │
│                │                         │ Dynamic Routes      │
│   Module 3  11 │  Expo Router uses a     │ 88 lines · 7 min    │
│ ▾ Module 4  11 │  bracketed folder to    │                     │
│   1 Intro      │  make a route dynamic.  │ 02:35 ░░░░░░░░░     │
│ ▸ 3 Dynamic ●  │                         │▐02:40 ███████████ ◀ │
│   4 Catch All  │  WHERE THIS COMES FROM  │ 02:46 ░░░░░░        │
│   Module 5   5 │  1 MODULE 4             │ 02:50 ░░░░░░░░      │
│                │    Dynamic Routes 02:40 │ 02:56 ░░░░░         │
└────────────────┴─────────────────────────┴─────────────────────┘
```

Nothing blocks the HTTP request: parsing, embedding and model calls all run in a separate worker
process, so the API stays responsive and failed jobs retry on their own.

> 📘 **[PIPELINE-EXAMPLE.md](PIPELINE-EXAMPLE.md)** — one real question traced through every stage, with
> the actual cue timings, chunk boundaries, Qdrant payload, per-variant rankings, RRF arithmetic and
> quote-to-timestamp match from a live run. Start there if you want to understand *how* it works rather
> than how to run it.

---

## Contents

- [How it works](#how-it-works)
- [Why the chunking matters](#why-the-chunking-matters)
- [Retrieval](#retrieval)
- [Guardrails and routing](#guardrails-and-routing)
- [Setup](#setup)
- [Running it](#running-it)
- [Multiple courses](#multiple-courses)
- [API reference](#api-reference)
- [Configuration](#configuration)
- [Project structure](#project-structure)
- [Tests](#tests)
- [Troubleshooting](#troubleshooting)

---

## How it works

```
courses/<name>/module N/<lesson>/<lesson>.srt
        │
        ├─ catalog.js ─── course → module → lesson tree, ids resolved via a Map
        │
        └─ ingest ──► BullMQ ──► worker ──► chunker ──► embeddings ──► Qdrant
                                              │                        payload:
                                              │                        courseId, lessonId,
                                              │                        moduleTitle, lessonTitle,
                                              │                        startMs, endMs,
                                              │                        cueStart, cueEnd

question
   │
   ├─ maskPII()          regex only, no model call
   ├─ classifyQuery()    ONE model call: in-scope gate AND intent
   │     ├─ blocked  → polite refusal, nothing else runs
   │     ├─ metadata → answered from the syllabus, no vector search at all
   │     └─ content  ▼
   │           3–4 query variants → search each → Reciprocal Rank Fusion
   │                  → grounded answer + verbatim quotes
   │                  → pinpointSentence(): quote → sentence → exact millisecond
   ▼
UI: citation chip ──click──► transcript pane, scrolled and highlighted
```

The transcript pane reads straight from disk. It needs neither Qdrant nor OpenAI, so you can browse
every lesson before spending anything on embeddings.

### Measured on this corpus

Every threshold in this project was measured against the real files, not guessed:

| | |
|---|---|
| Lessons / cues / runtime | 87 lessons · 19,203 cues · 22.7 hours |
| SRT vs VTT | identical on every cue, so only `.srt` is indexed |
| Cues ending in `.` `!` `?` | **75%** — enough for sentence-aware splitting |
| Average cue | 52 chars |
| Inter-cue gap p50 / p90 / p95 | 359 / 1180 / 1600 ms |
| A ≥1500 ms pause occurs every | **~871 chars** — just under the chunk target |
| Chunks produced | 1382 · p50 939 chars · max 1550 |
| Chunks ending on punctuation | **98.9%** |
| Catalog scan at startup | 199 ms cold, 97 ms warm |

---

## Why the chunking matters

A naive splitter destroys the one thing this app is built on. The obvious approach —
`text.replace(/\s+/g, " ")` then cut every 1000 characters — throws the timestamps away, and without
them a citation can never be clickable.

So chunking runs in three stages, all in [`src/chunker.js`](src/chunker.js):

**1. Cues → sentences (sentence-aware).** The cue texts are joined into one string alongside a
character-offset map, so every sentence still knows which cues it spans. Guards keep `app.json`,
`React.js`, `3.5`, `v2.0` and `e.g.` from being read as sentence ends. The splitter is deliberately
strict: a missed boundary just yields a longer sentence, whereas a false one cuts mid-thought.

A quarter of cues carry no terminator at all, so an unpunctuated run past 400 characters is cut at
the **longest pause inside it** — where the speaker actually drew breath — and flagged `forcedCut`.

**2. Sentences → blocks (structure-aware).** A silence of ≥1500 ms starts a new block. That number
comes from the table above: such a gap arrives every ~871 characters, comfortably under the 1200
target, so most chunks can close on a genuine pause instead of a hard cut.

**3. Blocks → chunks (target size).** Greedy packing toward 1200 characters, floor 600, ceiling
1800. Overlap carries **whole trailing sentences** into the next chunk rather than a fixed number of
characters, so a boundary never lands mid-word.

The result across all 87 lessons: **no cue is ever dropped**, 98.9% of chunks end on sentence
punctuation, and 30% close on a real pause.

---

## Retrieval

**Query expansion is adaptive.** Always producing three sub-queries meant most questions were
searched three times for the same thing, crowding the fusion with near-duplicate rankings. The
rewrite step now returns an `isCompound` flag, and only a genuinely two-topic question gets a single
sub-query — aimed at whichever intent the original phrasing covers *least* well.

| | variants | LLM calls |
|---|---|---|
| Single-intent question | rewritten + step-back + HyDE | 3 |
| Compound question | + one sub-query | 3 |

**HyDE imitates the corpus.** HyDE works by embedding the passage you *hope* exists. Asking for a
neutral encyclopedic paragraph put that vector a long way from anything here, because this corpus is
spoken lecture transcript — "so, let's go ahead and create a new folder". The prompt now asks for
instructor speech, which lands the vector in the same neighbourhood as the real chunks.

**Reciprocal Rank Fusion** merges the ranked lists: a chunk's score is the sum over every list it
appears in of `1 / (k + rank)`. Chunks found by more than one variant rise to the top, which is the
signal worth rewarding — agreement between differently phrased searches.

**Citations pinpoint a single line.** The answer is structured output, so the model returns
`{answer, citations: [{excerpt, quote}]}` with each quote copied verbatim. That quote is matched back
against the sentences of its chunk to find the exact cue it came from. This turns a ~60-second chunk
span into one timestamp, deterministically and with no extra model call. If the quote can't be
located, the citation falls back to the chunk's own start — coarser, still correct.

Every answer carries a **retrieval trace**: the variants actually searched, which found which chunk,
and the fused score that ordered them. Because the pipeline is adaptive, the presence or absence of a
sub-query row is the quickest way to see whether the classifier judged the question correctly.

---

## Guardrails and routing

One model call does two jobs, which is what makes the gate free — the same classification that
rejects off-topic questions also routes catalog questions away from vector search.

| Question type | Before | Now |
|---|---|---|
| Content | 3 LLM + 1 embed + search | 4 LLM + 1 embed + search — ~0.5s slower |
| Catalog ("how many lessons in module 5") | search, and the answer was wrong | 2 LLM, **no search** — faster and correct |
| Off-topic | full pipeline | 1 LLM |

**Catalog questions never touch the vector store.** The transcripts don't contain the syllabus, so
retrieval had nothing useful to find. The whole syllabus — about 1200 tokens — goes into the prompt
instead, which covers every phrasing without anyone writing a query language.

**The gate fails open.** Only an explicit `false` blocks a question. Its job is to reject weather and
poetry, *not* to guess the syllabus: "how do I use useState?" is in scope even if the course never
mentions it, because the answering step will say so honestly. Wrongly refusing a real question is a
worse failure than answering "not covered".

**PII masking is regex-only.** The real risk here is false positives, because this app is built out
of things that look like personal data. A naive phone pattern eats every one of these:

| Pattern | Why it must survive |
|---|---|
| `00:00:06,420` | subtitle timestamps — the whole point of the project |
| `#c3f53c` | hex colours |
| `8081`, `0.0.0.0` | ports and addresses, because the course teaches code |
| `1.2.3` | version numbers |

All four are pinned as negative tests. Emails, `sk-…` keys, GitHub/Slack tokens, JWTs, long digests
and phone numbers are masked on the way out and on the way back.

---

## Setup

**Prerequisites:** Node 20+, Docker (for Qdrant), Redis, and an OpenAI API key.

```bash
# 1. install
npm install
npm run ui:install

# 2. configure
cp .env.example .env        # then add your OPENAI_API_KEY

# 3. point COURSE_PATH at your subtitles (in .env)
#    single course:  <path>/module 1/<lesson>/<lesson>.srt
#    many courses:   <path>/<course>/module 1/<lesson>/<lesson>.srt

# 4. start the vector store
npm run services:up         # Qdrant on :6333

# Redis: this project expects one already running on :6379.
#   sudo systemctl status redis-server
```

---

## Running it

Three processes. The API and the worker are separate on purpose — that's what keeps a long ingest
from blocking the UI.

```bash
npm run worker    # terminal 1 — consumes both queues
npm run dev       # terminal 2 — API on :8000
npm run ui        # terminal 3 — Vite dev server on :5173
```

Then index the course. This is a one-off and costs roughly a cent for 87 lessons:

```bash
npm run ingest                          # everything
npm run ingest -- --list                # preview what would be queued
npm run ingest -- --course=expo-mastery # one course
npm run ingest -- --module=module-4     # one module
npm run ingest -- --force               # re-embed even if unchanged
```

Re-running is cheap: each lesson's content hash is stored beside its chunks, so unchanged lessons are
skipped. Killing the script mid-run is safe — the worker keeps going.

For a single-origin production build:

```bash
npm run ui:build && npm start           # Express serves the built UI on :8000
```

Queue dashboard: <http://localhost:8000/admin/queues> — inspect jobs, read failures, retry.
It has **no authentication**, so keep it off a public port.

---

## Multiple courses

Drop another course folder in and it appears in the switcher above the module rail.

```
courses/                          ← COURSE_PATH
  expo-mastery/
    module 1/<lesson>/<lesson>.srt
  react-native-advanced/
    section 1/<lesson>/<lesson>.srt
```

The layout is **detected automatically**: if `COURSE_PATH` itself holds module folders it is treated
as one course, otherwise its children are. Existing folders never have to move.

Module folders can be named `module 1`, `Section 2`, `part-3`, `unit 4`, `week 5` or a bare `06`, with
an optional suffix (`module 1 hc` renders as "Module 1 · HC"). A folder with no leading number keeps
its name and sorts last, so a `bonus` folder can't silently disappear.

Questions are scoped to the selected course via a Qdrant `courseId` filter. Picking **All courses**
searches everything. The chat history survives a switch, and each turn shows which course answered
it, so an older answer can't be mistaken for a new one.

---

## API reference

| Method | Route | Needs Qdrant / OpenAI? |
|---|---|---|
| `GET` | `/api/health` | no |
| `GET` | `/api/courses` | no |
| `GET` | `/api/catalog?courseId=` | no |
| `GET` | `/api/lessons/:lessonId/transcript` | no |
| `GET` | `/api/status?courseId=` | Qdrant |
| `POST` | `/api/query` → `202 {jobId}` | both |
| `GET` | `/api/query/:id` | — |
| `GET` | `/api/index/:id` | — |

Asking a question is a two-step: `POST /api/query` returns a job id, then poll `GET /api/query/:id`
until it reports `completed`.

An unknown `courseId` is a **400** before it can reach a Qdrant filter. Lesson ids are keys into the
catalog's `Map` and are never joined into a path, so traversal attempts are structurally impossible
rather than filtered — they return **404** like any other unknown id.

`/api/status` degrades on purpose: with Qdrant stopped it still returns `200` with
`reachable: false` and the command to fix it, because the catalog half of the answer is still true
and still useful.

---

## Configuration

Everything lives in `.env` — see [`.env.example`](.env.example) for the annotated list. The ones
worth knowing:

| Variable | Default | Notes |
|---|---|---|
| `COURSE_PATH` | `class_subtitle_…/class-subtitle` | one course or a parent of several |
| `COURSE_NAME` | `Expo Mastery` | display name in single-course mode |
| `SCAN_DURATIONS` | `true` | reads last cues at boot (~200ms) so lesson lengths are known |
| `CHUNK_TARGET_CHARS` | `1200` | with min 600 / max 1800 |
| `CHUNK_STRONG_PAUSE_MS` | `1500` | silence that counts as a structural break |
| `MAX_SENTENCE_CHARS` | `400` | cap for unpunctuated runs |
| `RETRIEVAL_TOP_K` | `6` | candidates per variant |
| `RETRIEVAL_FINAL_K` | `6` | chunks kept after fusion |
| `INGEST_CONCURRENCY` | `3` | lessons embedded in parallel |

---

## Project structure

```
src/
  catalog.js         folder tree → courses/modules/lessons, ids via a trusted Map
  subtitles.js       SRT + WebVTT parser; cues keep their millisecond ranges
  chunker.js         the three-stage splitter (pure functions, no I/O)
  transcript.js      cached transcript reads for the viewer pane
  guardrails.js      regex PII masking
  router.js          one call: in-scope gate + content/metadata intent
  pipeline.js        orders mask → classify → route
  retriever.js       expansion, RRF, grounded answer, sentence pinpointing
  catalog-answer.js  syllabus questions, no vector search
  indexer.js         chunk → embed → upsert, idempotent via content hash
  status.js          what is actually indexed
  qdrant.js          collection + payload indexes + course filter
  queue.js/worker.js BullMQ producer and consumer
  index.js           Express routes

web/src/
  components/  ModuleRail · CourseSwitcher · Conversation · CitationChip
               RetrievalTrace · Composer · TranscriptPane · Header
  hooks/       useCatalog · useConversation · useTranscript
  api/client.js  abortable fetch, ApiError, bounded job polling

scripts/ingest-course.js   bulk ingest with live progress
test/                      node --test, no services required
```

---

## Tests

```bash
npm test        # node --test, 88 tests
```

No API key, no Redis, no Qdrant. The suites cover the parser, the chunker's invariants across the
real corpus, catalog naming and layout detection, PII masking including the pinned negatives, and the
deterministic half of retrieval (variant selection, routing, pinpointing, RRF) via fixtures of what
the model returns.

The invariants worth knowing about, all asserted over every lesson: no cue is ever lost, chunk cue
ranges never go backwards, no chunk exceeds the ceiling, none but the last falls below the floor, and
every chunk ends on sentence punctuation unless there was none to end on.

---

## Troubleshooting

**"Nothing is indexed yet"** — the rail and transcripts work without embeddings; answering doesn't.
Run `npm run ingest`.

**Ingest sits at 0/87** — the worker isn't running. Start it with `npm run worker`; the script warns
about this after ten seconds.

**"Can't reach Qdrant"** — `npm run services:up`, then check `docker ps`.

**No lessons in the rail** — `COURSE_PATH` is wrong. Run `npm run ingest -- --list` to see exactly
what the scanner finds.

**A lesson shows as "Chapter 3" with no title** — five folders in this export are named only
`chapter-N_epm`, so there is no title to read. `npm run titles:generate` can derive them from the
transcripts into `data/lesson-titles.json`, which the catalog overlays when present.

**Answers cite the right lesson but a slightly-off second** — the model paraphrased its quote instead
of copying it, so pinpointing fell back to the chunk's start. The trace shows which chunk was used.

**A code change to the UI doesn't appear** — hashed assets are cached for a year, but `index.html` is
served `no-cache` so a rebuild is picked up on reload. If you see a stale build, you are looking at a
cached `index.html` from before that header existed; hard-reload once.
