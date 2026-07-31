# Pipeline Walkthrough — One Real Question, Every Stage

This document follows **one actual run** of the pipeline from end to end. Every number, ranking, score
and piece of text below was captured from a real execution against a live Qdrant and the real OpenAI
API. Nothing here is illustrative.

**The question:** `expo router me dynamic routes kaise banate hain?` — asked in Hinglish, on purpose,
because the answer has to come back in the same language.

**The corpus:** the Expo course transcripts — 1 course, 18 modules, 87 lessons, 22.7 hours of speech,
indexed as 1382 chunks in a 1536-dimensional Cosine collection.

Reproduction steps are at the [bottom](#reproduce-this-yourself).

---

## Contents

- [Part 1 — Indexing one lesson](#part-1--indexing-one-lesson)
- [Part 2 — Answering the question](#part-2--answering-the-question)
- [Part 3 — The other two routes](#part-3--the-other-two-routes)
- [Part 4 — A compound question](#part-4--a-compound-question)
- [What this run cost](#what-this-run-cost)
- [Reproduce this yourself](#reproduce-this-yourself)

---

# Part 1 — Indexing one lesson

```
lesson   : Module 4 / Dynamic Routes
file     : 3-Dynamic Routes_epm.srt
cues     : 88        duration : 06:50
```

## 1.0 — What the parser sees

The `.srt` file is a list of timed cues. Cues 10–19, exactly as `parseSubtitles()` returns them:

```
[10] 01:02→01:07  "routes because let's say right now you only have three posts."
[11] 01:07→01:09  "So you are basically going to create."
[12] 01:10→01:19  "We can say post1.tsx exactly post2.tsx, post3.tsx and in future let's say you have millions"
[13] 01:19→01:27  "of posts then is this feasible to create post1 to post1 million.tsx?"
[14] 01:27→01:27  "No."
[15] 01:28→01:30  "This is where the use of dynamic routes come."
[16] 01:31→01:33  "Perfect, so how this actually work?"
[17] 01:34→01:38  "This is going to be basically work something like square notation."
[18] 01:38→01:44  "Perfect, so you are basically going to use your parameters as we can say brackets and"
[19] 01:44→01:51  "explore outer automatically treat that parameter as a variable in the path and then with the"
```

Two things to notice, because both drive the design that follows:

- **Cues cut mid-sentence.** Cue 12 ends at "you have millions" and cue 13 continues "of posts then…".
  A splitter that treated each cue as a unit would tear that thought in half.
- **The transcription is imperfect.** "explore outer" is the recogniser's attempt at "Expo Router",
  and "post1 million.tsx" is "post1million.tsx". The answering prompt is told to read charitably.

Note also that cue 12 contains `post1.tsx`, `post2.tsx`, `post3.tsx`. Those dots must not be read as
sentence ends — see stage 1.

## 1.1 — Stage 1: cues → sentences

```
88 cues → 72 sentences

forcedCut (no punctuation was available) : 0
discourse-marker openings ("So", "Perfect", …) : 46 / 72
sentences spanning more than one cue : 22
```

The cue texts are joined into one string alongside a character-offset map, so every sentence still
knows which cues it came from. That is the entire trick that keeps timestamps alive.

**Sentences that span multiple cues** — reassembled across the cue boundary, with the cue range kept:

```
cues 0–1  00:00  "Here everyone and in this lecture we will learn how to create dynamic routes with the help o…"
cues 2–3  00:07  "Dynamic routes let you build screen that accept parameters from the URL or we can say naviga…"
cues 4–5  00:21  "So in let's say in Xpo route basically here you wanted to have let's say you are on post."
```

**Two sentences inside one cue** — split, but both still attributed to that cue:

```
cue  4  startsCue=false  "So what are dynamic routes?"
cue 35  startsCue=false  "Easy step number one is done."
```

`startsCue=false` matters: only a sentence that *begins* a cue can have a pause in front of it, so
this flag stops stage 2 from crediting a silence to the wrong sentence.

**`forcedCut` is 0 for this lesson** — every sentence ended on real punctuation. Across the whole
corpus 1.3% of chunks end on a forced cut instead, because a quarter of all cues carry no terminator
at all. When that happens the break is placed at the longest pause inside the run rather than at an
arbitrary character count.

**The abbreviation guards, on this lesson's own text.** `post1.tsx` and `post2.tsx` in cue 12 are not
sentence ends, because the rule requires whitespace after the terminator. `post1 million.tsx?` in cue
13 *is* one, because `?` is unambiguous.

## 1.2 — Stage 2: where the speaker actually paused

Gaps between the cues shown above:

```
before cue 11 :   110 ms
before cue 12 :   900 ms
before cue 13 :    81 ms
before cue 14 :   461 ms
before cue 15 :   481 ms
before cue 16 :   221 ms
before cue 17 :   510 ms
before cue 18 :   841 ms
before cue 19 :   201 ms
before cue 20 :    40 ms
```

None of these reaches the 1500 ms threshold, so this whole stretch is one block — correctly, since
the instructor is mid-explanation throughout. The threshold isn't a guess: across the corpus the
median gap is 359 ms, and a gap ≥1500 ms arrives roughly every 871 characters, just under the 1200
chunk target. That is what lets most chunks close on a genuine pause.

## 1.3 — Stage 3: sentences → chunks

```
72 sentences → 7 chunks
target 1200 · min 600 · max 1800 · overlap 240
```

| # | chars | cues | time span | overlap | closed because |
|---|---|---|---|---|---|
| 1 | 1050 | 0–15 | 00:00–01:30 | 4 cues | ≥75% target + discourse marker |
| 2 | 928 | 12–27 | 01:10–02:21 | 4 cues | ≥75% target + discourse marker |
| 3 | 926 | 24–36 | 02:04–03:14 | 2 cues | **pause of 2520 ms** |
| 4 | 1047 | 35–51 | 02:56–04:29 | 3 cues | ≥75% target + discourse marker |
| 5 | 930 | 49–63 | 04:11–05:21 | 4 cues | ≥75% target + discourse marker |
| 6 | 1021 | 60–78 | 05:06–06:19 | 3 cues | ≥75% target + discourse marker |
| 7 | 693 | 76–87 | 06:04–06:50 | — | end of lesson |

Every chunk lands between 693 and 1050 characters — none hits the 1800 ceiling, and only the last
falls below the 600 floor, which is allowed. Chunk 3 closed on a real 2.5-second silence. The others
closed near the target at a discourse marker, which in this lesson means the instructor starting a
sentence with "So" or "Perfect" — he does that 46 times in 72 sentences, which is why markers are
only ever a tie-breaker near the size target and never a break on their own.

The overlap column is cues repeated into the following chunk, carried as **whole sentences**, so no
chunk boundary ever lands mid-word.

## 1.4 — One chunk in full

Chunk 3 — cues 24–36, `02:04–03:14`, 926 characters, 9 sentences:

> Let's say we have a app router and inside this app router we have this post and each post have this
> unique square bracket and inside that square bracket we basically have something on as post ID. So,
> this post ID is a dynamic route. So, every time for post one, this one is going to replace this post
> ID same for two, same for the one million that we have perfect. So, by doing this, we are going to
> follow the best practice. So, now let's move ahead and we'll see how you can basically create it.
> So, for that, let me go to my VS Code and inside this app, let's say inside this profile, we have
> this user, but let's take the post example. So let me say this as a post and inside this post create
> a new file. and use the square bracket here and let me call this as a post ID dot TSX. Easy step
> number one is done. Then simply initialize a React component as RNFES and instead of this you can
> simply say this as post ID screen.

Readable prose that begins and ends on a sentence, spanning 70 seconds of speech.

## 1.5 — What gets stored

The Qdrant point written for that chunk — the vector plus this payload:

```
courseId     "expo-mastery"
lessonId     "expo-mastery:module-4--3-dynamic-routes"
moduleId     "module-4"
moduleTitle  "Module 4"
lessonTitle  "Dynamic Routes"
moduleOrder  4
lessonOrder  3
kind         "chapter"
startMs      124960          ← 02:04
endMs        194060          ← 03:14
cueStart     24
cueEnd       36
chunkIndex   2
chunkCount   7
contentHash  "41ef7867f3e619467f523134…"
indexedAt    "2026-07-30T06:29:23.576Z"
text         "Let's say we have a app router and inside this app router we have this"…
```

`startMs`/`endMs`/`cueStart`/`cueEnd` are the whole point. Without them an answer could say *what* but
never *where*. `contentHash` is a sha256 of the source file, which is what lets a re-run skip this
lesson for free.

---

# Part 2 — Answering the question

```
❯ expo router me dynamic routes kaise banate hain?
```

## Step 1 — maskPII  ·  1 ms, zero LLM calls

```
found : []
text  : "expo router me dynamic routes kaise banate hain?"   (unchanged)
```

Pure regex. Nothing to redact here, but this is where a pasted API key or email would be replaced
before anything left the process. It is deliberately conservative: this corpus is full of things that
*look* like personal data (`00:00:06,420`, `#c3f53c`, `8081`, `1.2.3`) and all of them must survive
untouched.

## Step 2 — classifyQuery  ·  3346 ms, 1 LLM call

```
allowed : true
intent  : content        → the content pipeline
reason  : ""
```

One call does both jobs. It decides the question is in scope, and that it is about the *material*
rather than the *shape* of the course. Combining them is what makes the gate free — the same call
that would have rejected an off-topic question also does the routing.

## Step 3 — Query expansion  ·  2 LLM calls, run in parallel

```
original   : "expo router me dynamic routes kaise banate hain?"
rewritten  : "How do you create dynamic routes in Expo Router?"
stepBack   : "What are the different routing methods available in Expo Router?"
isCompound : false        → decomposition SKIPPED
subQueries : []
variants   : 3
```

The Hinglish question is rewritten into English because the transcripts are English — matching the
language of the corpus is what the retrieval step needs, while the *answer* will come back in
Hinglish.

`isCompound: false` is the interesting part. This question asks one thing, so no sub-query is
generated and the run proceeds with three variants instead of four. Under the old always-decompose
design this would have produced three near-identical sub-questions about dynamic routes, each adding a
redundant ranking to the fusion below.

**HyDE** — 562 characters of invented passage, written to imitate what an instructor would *say*:

> So, to create dynamic routes in Expo Router, you can use square brackets in your file names. For
> example, if you want a dynamic route for user profiles, you would create a file named `[id].js`
> inside your `app` directory. Right now, when you navigate to `/user/123`, the router will recognize
> `123` as the dynamic part and pass it as a parameter. You can access this parameter using the
> `useRouter` hook from the `expo-router` package. You can see here how this makes it really easy to
> handle different user profiles without creating separate files for each one.

Note the register: "So,", "Right now,", "You can see here". That is the point of the rewrite to this
prompt — the search below is done with this passage's embedding, and a passage written like the corpus
lands near the corpus. Note also that it is not entirely accurate (the course uses `.tsx`, not `.js`).
That doesn't matter: HyDE is a search key, never an answer.

## Step 4 — Embedding  ·  1 batched call

```
model   : text-embedding-3-small
vectors : 3 × 1536d
```

All three variants in one request.

## Step 5 — Search  ·  3 vector searches, top 6 each, filtered to `courseId`

**rewritten** — "How do you create dynamic routes in Expo Router?"

```
1. cos=0.7515  Module 4 / Dynamic Routes                        00:00–01:30  chunk 0
2. cos=0.6336  Module 4 / File Based Routing Basics             00:00–00:55  chunk 0
3. cos=0.6331  Module 4 / Introduction to Expo Router           01:14–02:20  chunk 1
4. cos=0.6065  Module 4 / Introduction to Expo Router           02:05–03:22  chunk 2
5. cos=0.6002  Module 4 / Dynamic Routes                        01:10–02:21  chunk 1
6. cos=0.5911  Module 3 / Introduction to Navigation in RN      13:17–14:32  chunk 13
```

**stepBack** — "What are the different routing methods available in Expo Router?"

```
1. cos=0.6632  Module 4 / Introduction to Expo Router           02:05–03:22  chunk 2
2. cos=0.6574  Module 4 / Introduction to Expo Router           01:14–02:20  chunk 1
3. cos=0.6417  Module 3 / Introduction to Navigation in RN      13:17–14:32  chunk 13
4. cos=0.6358  Module 4 / File Based Routing Basics             00:00–00:55  chunk 0
5. cos=0.6257  Module 4 / Introduction to Expo Router           05:53–07:01  chunk 6
6. cos=0.6256  Module 4 / Introduction to Expo Router           00:00–01:28  chunk 0
```

**hyde** — the invented instructor passage

```
1. cos=0.7024  Module 4 / Dynamic Routes                        00:00–01:30  chunk 0
2. cos=0.6632  Module 4 / File Based Routing Basics             00:00–00:55  chunk 0
3. cos=0.6550  Module 4 / Introduction to Expo Router           03:05–04:28  chunk 3
4. cos=0.6439  Module 4 / Introduction to Expo Router           01:14–02:20  chunk 1
5. cos=0.6414  Module 4 / Dynamic Routes                        01:10–02:21  chunk 1
6. cos=0.6358  Module 4 / Introduction to Expo Router           00:00–01:28  chunk 0
```

The three lists genuinely disagree, which is the reason for running more than one. `rewritten` and
`hyde` both put *Dynamic Routes chunk 0* first; `stepBack`, being broader, ranks the general
*Introduction to Expo Router* chunks above it and surfaces `chunk 6`, which neither of the others
found at all.

## Step 6 — Reciprocal Rank Fusion  ·  k = 60

Nine distinct chunks appeared across the three lists. Each chunk scores the sum, over every list it
appears in, of `1 / (60 + rank)`:

```
#1  File Based Routing Basics · 00:00 · chunk 0
    found by : rewritten@2, stepBack@4, hyde@2
    1/(60+2) + 1/(60+4) + 1/(60+2) = 0.047883      best cosine 0.6632

#2  Introduction to Expo Router · 01:14 · chunk 1
    found by : rewritten@3, stepBack@2, hyde@4
    1/(60+3) + 1/(60+2) + 1/(60+4) = 0.047627      best cosine 0.6574

#3  Dynamic Routes · 00:00 · chunk 0
    found by : rewritten@1, hyde@1
    1/(60+1) + 1/(60+1)            = 0.032787      best cosine 0.7515

#4  Introduction to Expo Router · 02:05 · chunk 2
    found by : rewritten@4, stepBack@1
    1/(60+4) + 1/(60+1)            = 0.032018      best cosine 0.6632

#5  Introduction to Navigation in RN · 13:17 · chunk 13
    found by : rewritten@6, stepBack@3
    1/(60+6) + 1/(60+3)            = 0.031025      best cosine 0.6417

#6  Dynamic Routes · 01:10 · chunk 1
    found by : rewritten@5, hyde@5
    1/(60+5) + 1/(60+5)            = 0.030769      best cosine 0.6414
```

**Worth pausing on #1 versus #3.** *Dynamic Routes chunk 0* has by far the best raw similarity — 0.7515
against 0.6632 — yet it fuses to third, because only two of the three lists found it while #1 was
found by all three. That is RRF doing exactly what it is for: rewarding agreement across differently
phrased searches rather than trusting one high cosine.

It is also why fusion order is **not** the same as what ends up cited. All six chunks go to the model,
which then picks the ones that actually contain the answer — and as Step 8 shows, both citations came
from *Dynamic Routes*, the chunk RRF had ranked third and sixth.

## Step 7 — The grounded answer  ·  1 LLM call

The top 6 fused chunks are handed over as numbered excerpts (~5,500 characters). Structured output, so
the model returns `{answer, covered, citations}` rather than prose we would have to parse.

```
covered : true
```

> Expo router me dynamic routes banane ke liye aapko square brackets ka istemal karna hota hai. Jab aap
> kisi route ko define karte hain, toh aap parameters ko brackets me rakhte hain, jaise ki post ID.
> Isse expo router us parameter ko path me variable ki tarah treat karta hai. Is tarah se aap easily
> dynamic routes create kar sakte hain, bina har post ID ke liye alag file banaye. Yeh flexibility
> aapko navigation me help karti hai.

Asked in Hinglish, answered in Hinglish — while every one of the excerpts it read was English.

## Step 8 — pinpointSentence: from a 90-second window to one line

### Why this step has to exist

Retrieval works in chunks, and a chunk is the wrong size to send someone to.

The course is 22.7 hours of speech. None of it can go to the model in one piece, so it is cut up and
only the six most relevant pieces are sent. Each piece is about 1200 characters — roughly **16
subtitle lines, about 90 seconds** of the instructor talking.

That is a good size for *retrieval*. It is a bad size for a *link*. Here is the chunk that answered
this question, from the inside:

```
  00:00  Here everyone and in this lecture...
  00:05  help of expo routers.
▸ 00:07  Dynamic routes let you build screen that accept...   ← the line that answers it
  00:15  path just like dynamic URL on the web...
  00:21  Perfect. So what are dynamic routes?
  00:29  But as you know we have multiple posts...
  00:38  our platform like post one, post two...
  00:43  And for each post, I wanted to have a route segment.
  00:48  All right, for each post...
  00:54  So instead of separately creating for every post ID...
  01:02  routes because let's say right now you only have three posts.
  01:07  So you are basically going to create.
  01:10  We can say post1.tsx exactly post2.tsx...
  01:19  of posts then is this feasible to create...
  01:27  No.
  01:28  This is where the use of dynamic routes come.
         └────────────── one chunk · 00:00–01:30 ──────────────┘
```

After retrieval, all the system knows is *"this whole chunk was relevant."* It does not know which of
those 16 lines actually carried the answer. So the citation could only say:

> **Module 4 · Dynamic Routes · 00:00**

Click that and the transcript opens at 00:00, while the answer is at 00:07 — and had the answer come
from the last line instead, you would land 88 seconds early. Either way you end up scanning the 16
lines yourself, which is the work the citation was supposed to save you.

It is the difference between *"it's on page 47"* and *"page 47, line 12"*. Both are true; only one
saves you reading the page. **A chunk is the page. A cue is the line.** Without this step the app was
giving out page numbers.

| | What the user gets |
|---|---|
| Cite the chunk only | "somewhere between **00:00 and 01:30**" — 90 seconds to search |
| Cite with a pinpoint | "at **00:07**" — that line, highlighted |

### How it does it

The answering prompt requires each citation to carry one sentence copied out of its excerpt
**verbatim**, not paraphrased. That quote is then matched back against the sentences of that same
chunk to work out which one it was — and because stage 1 recorded the cue range of every sentence as
it was built, the winning sentence already knows its cue, and the cue already knows its millisecond.

Matching is plain token overlap, so it costs nothing: no second model call, and the same input always
gives the same answer. Below the threshold of 0.45 the citation falls back to the chunk's own start —
coarser, but never wrong.

**Citation [1]**

```
chunk span  : cues 0–15 · 00:00–01:30 · 90 s wide
model quote : "Dynamic routes let you build screen that accept parameters from the URL or we can say navigation…"
matched cue : 2, at 00:07
cue text    : "Dynamic routes let you build screen that accept parameters from the URL or we can say navigation…"
pinpointMs  : 7780  →  00:07        exactQuote = true
narrowing   : 90 s span → 1 line
deep link   : #/lesson/expo-mastery:module-4--3-dynamic-routes?t=7780&c=2
```

**Citation [2]**

```
chunk span  : cues 12–27 · 01:10–02:21 · 71 s wide
model quote : "Perfect, so you are basically going to use your parameters as we can say brackets and explore ou…"
matched cue : 18, at 01:38
cue text    : "Perfect, so you are basically going to use your parameters as we can say brackets and"
pinpointMs  : 98960  →  01:38       exactQuote = true
narrowing   : 71 s span → 1 line
deep link   : #/lesson/expo-mastery:module-4--3-dynamic-routes?t=98960&c=18
```

Both matched exactly. Citing the chunk alone would have pointed the reader at a 90-second and a
71-second stretch; the quote match turns each into a single spoken line.

Note that citation [1]'s quote spans cues 2–3, and the pinpoint resolves to cue **2** — the cue where
the sentence *begins*, which is where the reader should land.

## What the UI does with it

The citation renders as a chip reading `MODULE 4 / Dynamic Routes · 00:07`. Clicking it opens the
transcript pane and:

- washes **cues 0–15** in accent colour — the chunk the answer was drawn from
- gives **cue 2** a solid playhead edge, a gutter marker, and browser focus
- scrolls that cue to the middle of the pane
- announces "Jumped to 00:07 in Dynamic Routes" to assistive technology
- rewrites the URL to the deep link above, so the position is shareable

Two levels of highlight, because they answer different questions: *which passage supports this* and
*which line said it*.

---

# Part 3 — The other two routes

The same classify call routes questions away from retrieval entirely when it shouldn't run.

**A question about the course's shape**

```
❯ Module 5 me kitne lessons hain?

allowed = true   intent = metadata   (2292 ms)
→ answerFromCatalog();  0 embeddings, 0 vector searches
```

Answered from the syllabus instead — 5,376 characters, roughly 1,344 tokens, handed to the model whole:

```
COURSE: Expo Mastery (87 lessons)
  Module 1 — 3 lesson(s)
    1. What Is Mobile Development (7 min)
    2. React Native vs Expo (13 min)
    3. Setting Up env Creating First Expo Project (13 min)
  Module 1 · HC — 2 lesson(s)
  …
```

This path exists because the transcripts don't contain the syllabus. Sent through retrieval, "how many
lessons are in module 5" searched 1382 chunks of speech for a fact that was never spoken aloud, and
answered wrongly. Putting the whole syllabus in the prompt is cheaper than a query language and covers
every phrasing without enumerating question types.

**An off-topic question**

```
❯ aaj Delhi me mausam kaisa hai?

allowed = false   (1559 ms)
refusal : "I'm here to answer questions about mobile app development and the course, not about the weather."
→ blocked;  0 further calls, 0 searches
```

One call, then it stops. (`intent` is also populated on a blocked result, but it is meaningless there —
nothing downstream reads it.)

The gate is tuned to reject *this*, not to guess the syllabus. "How do I use useState?" is allowed
even if the course never covers it, because the answering step will say so honestly. Wrongly refusing
a real question is a worse failure than answering "not covered".

---

# Part 4 — A compound question

Same pipeline, but the question genuinely asks two things:

```
❯ How do dynamic routes work and how do I add authentication in Expo?

isCompound : true
rewritten  : "How do dynamic routes work in Expo, and how can I add authentication to my Expo app?"
stepBack   : "What are the key concepts of routing and authentication in mobile app development
              with Expo and React Native?"
subQuery   : "What are the steps to implement authentication in an Expo app?"
variants   : 4
```

The sub-query targets **authentication** — the intent the original phrasing represents most weakly,
since "dynamic routes" leads the sentence and dominates its embedding. In a separate run this question
returned citations from two different modules, Module 4 for routing and Module 13 for auth, which is
precisely the job the fourth variant exists to do.

Compare with Part 2, where the same machinery produced no sub-query at all. Same number of LLM calls
either way — the flag only decides whether a fourth *embedding* and search happen.

---

# What this run cost

Per content question: **4 chat calls + 1 batched embedding call**.

| Stage | Calls | Notes |
|---|---|---|
| maskPII | 0 | regex |
| classifyQuery | 1 chat | gate + routing together |
| queryRewriting | 1 chat | parallel with HyDE |
| hydeDocument | 1 chat | parallel with rewriting |
| embed variants | 1 embedding | 3 texts in one request |
| search | 0 | Qdrant, not OpenAI |
| RRF | 0 | arithmetic |
| answer | 1 chat | ~1,379 tokens of context |
| pinpointSentence | 0 | token overlap, local |

Roughly **$0.0007** per content question at current `gpt-4o-mini` + `text-embedding-3-small` pricing —
about 1,400 questions per dollar. A catalog question is about half that; a blocked one is a tenth.
Indexing the entire 87-lesson course cost about **$0.006**, once.

Wall clock for this run: 3.3 s to classify, 23.1 s for the content pipeline. That is on the slow side
— other runs of the same question completed in 10–12 s. The dominant term is the four sequential-ish
model calls, not retrieval.

---

# Reproduce this yourself

```bash
cp .env.example .env        # add OPENAI_API_KEY
npm install && npm run ui:install
npm run services:up         # Qdrant on :6333
npm run worker              # terminal 1
npm start                   # terminal 2  → http://localhost:8000
npm run ingest              # one-off; skips unchanged lessons on re-runs
```

Then ask the same question in the UI and open **Retrieval trace** under the answer. It shows the
variants that were searched, which variant found which chunk, and the fused score that ordered them —
the same data as Steps 3, 5 and 6 above.

**Your numbers will differ.** Cue timings, chunk boundaries, payloads, cosine scores and RRF
arithmetic are all deterministic and should reproduce exactly. The model-generated text — the rewrite,
the step-back, the HyDE passage, the answer wording — runs at temperature above zero, so it varies run
to run. The `isCompound` decision and the citation targets were stable across every run tested.

## Appendix — inspecting the vectors directly

Qdrant ships a dashboard at <http://localhost:6333/dashboard>. Open the **Collections** tab, pick
`course_transcripts`, and browse points to see each payload (`lessonTitle`, `startMs`, `cueStart`, the
chunk text) and run vector searches by hand.

Or from the shell:

```bash
# collection summary
curl -s localhost:6333/collections/course_transcripts | python3 -m json.tool

# one lesson's chunks, in order
curl -s localhost:6333/collections/course_transcripts/points/scroll \
  -H 'content-type: application/json' -d '{
    "limit": 10, "with_payload": true, "with_vector": false,
    "filter": {"must": [{"key": "lessonId", "match": {"value":
      "expo-mastery:module-4--3-dynamic-routes"}}]}
  }' | python3 -m json.tool
```
