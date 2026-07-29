# Expo Course Q&A — plan

## Context

Aapke paas poore Expo course ke subtitles hain: **87 lessons, 18 module folders, 19,203 cues, ~1.6 MB text**
(`class_subtitle_lyst1784566935215/class-subtitle/module N/<lesson>/<lesson>.srt|.vtt`).

Aap chahte hain: ek chat interface jahan doubt puchho → answer mile, aur answer ke saath
**kaunsa module, kaunsa chapter, aur kaunsa timestamp** — woh timestamp **clickable** ho, click
karte hi teesre panel me woh transcript khul jaye aur **wahi line highlight** ho.

Saath me **multi-course**: `courses/<course-name>/module N/...` drop karo aur woh course apne aap
aa jaye — rail ke upar switcher se badlo, retrieval sirf active course me ho.

Repo me pehle se ek Advanced RAG pipeline hai (Express + BullMQ/Redis + Qdrant + OpenAI, query
expansion → RRF → grounded answer). Retrieval ka dimaag reusable hai, lekin teen cheezein
blocker hain:

| Problem | Aaj kya hai | Kyun blocker hai |
|---|---|---|
| Timestamps mit jaate hain | `chunkText()` me `text.replace(/\s+/g," ")` | Clickable timecode banana **impossible** ho jata hai |
| Module/chapter metadata nahi | payload me sirf `source` filename | "Kis module me hai" bata hi nahi sakte |
| Transcript padhne ka koi route nahi | — | Teesra panel bhar hi nahi sakte |

**Decisions (aapse confirm ho chuke):** course-first (PDF upload hataana), Cinema Timeline dark
editing-suite UI, aur answer user ki bhasha mirror kare (Hinglish → Hinglish).

**Already written & verified** (plan ka hissa, aapke `nhai pehle plan` se pehle likhe gaye):
`src/subtitles.js`, `src/catalog.js`, `src/config.js`.

---

## Verified facts (guesses nahi — chalake dekha)

- Parser 174/174 files par chala: **0 failures**, aur SRT vs VTT har cue par **exactly match** karte hain
  → sirf `.srt` index karna kaafi hai, `.vtt` fallback.
- Sabse lambi lecture **1:00:55** → timecode format ko hours handle karne padenge (ho chuka).
- Environment: Node 22 ✓, Redis ✓ (PONG), `npm install` ✓ (162 pkgs).
  **Qdrant band hai**, aur **`.env` hai hi nahi** → koi `OPENAI_API_KEY` nahi.

---

## Architecture

```
courses/<name>/*.srt ──► catalog.js (course → module → lesson tree, trusted Map)
                             │
              ingest script ─┴─► BullMQ ──► worker ──► indexer.js
                                                          │ cue-aware windows
                                                          │ (startMs/endMs preserved)
                                                          ▼
                                                    Qdrant payload
                                                    {courseId, lessonId, moduleTitle,
                                                     lessonTitle, startMs, endMs,
                                                     cueStart, cueEnd, text}
question + courseId
   │
   ├─ maskPII()        regex, 0 LLM calls
   ├─ classifyQuery()  1 LLM call — gate + intent ek saath
   │      ├─ blocked  → polite refusal, koi retrieval nahi
   │      ├─ metadata → answerFromCatalog()  (0 vector search)
   │      └─ content  ▼
   │            retriever.js ──► 3–4 variants ──► RRF ──► structured answer + citations
   │                 │            (adaptive)                    │
   └─ Qdrant filter ─┘             pinpointSentence(): quote → sentence → exact ms
      (courseId keyword index)                                  ▼
                        UI: citation chip  ──click──►  TranscriptPane (disk read, highlight)
```

**Key insight:** transcript panel ko na Qdrant chahiye na OpenAI — woh seedha disk se padhta hai.
Matlab teen me se do panel bina API key ke fully testable hain.

---

## Backend

### New files

| File | Kya karta hai |
|---|---|
| `src/subtitles.js` ✅ | SRT+VTT parser. Cue = `{index, startMs, endMs, text}`. BOM/CRLF/VTT markup/NOTE blocks handle karta hai. `formatTimecode()` bhi. |
| `src/catalog.js` ✅ | Folder tree → courses/modules/lessons, gande naam saaf karta hai. **Security:** lessonId ek `Map` me lookup hota hai, kabhi path me join nahi hota → path traversal structurally impossible. (Multi-course extension neeche.) |
| `src/chunker.js` | **naya** — 3-stage structure/sentence/target-size chunking (apna section neeche). Pure functions, koi I/O nahi → poori tarah testable. |
| `src/guardrails.js` | **naya** — `maskPII(text)` → `{ text, found: [] }`. Pure regex, **zero LLM calls**. |
| `src/router.js` | **naya** — `classifyQuery(query)`, structured output: gate **aur** intent ek hi call me. |
| `src/catalog-answer.js` | **naya** — `answerFromCatalog(query, courseId)`, koi vector search nahi. |
| `src/transcript.js` | `getTranscript(lessonId)` — cues + lesson meta, LRU-capped in-memory cache (files read-only hain). |
| `scripts/ingest-course.js` | Sab courses ke lessons enqueue kare, live progress dikhaye, drain hone par exit. `--force`, `--course=`, `--module=` flags. |
| `scripts/generate-titles.js` | *(optional, opt-in)* Bina naam wale 5 chapters ke liye transcript se title banaye → `data/lesson-titles.json`. |
| `test/*.test.js` | `node --test` (Node 22 built-in, **zero new deps**) — pure logic ke tests. |

### Rewritten

**`src/indexer.js`** — sirf orchestration: chunking ab apni file me (neeche), yahan
embed + upsert.
- **Idempotent:** payload me `contentHash` (sha256 of file). Same hash → skip (paisa bachta hai).
  Re-index se pehle us `lessonId` ke purane points filtered-delete.

**`src/chunker.js` (naya)** — structure-aware + sentence-aware + target-size. Poori detail
neeche apne section me.

**`src/retriever.js`** — `reciprocalRankFusion` aur `retrieveChunks` ka dhaancha reuse; teen
targeted changes:

**(a) Decomposition ab conditional hai — 3 sub-queries se 0-ya-1.**
`queryRewriting` ke JSON schema me ek `isCompound: boolean` add hoga. Single-intent sawaal
(zyadatar doubts aise hi hote hain) → `subQueries: []`, decomposition skip. Compound sawaal
(*"dynamic routes kaise banate hain aur auth kaise lagayein"*) → **exactly 1** sub-query, jo us
intent ko target kare jo original phrasing me sabse kam represent hai — breadth to `stepBack`
aur `rewritten` already de rahe hain.
**Cost: zero extra** (wahi ek LLM call, bas ek boolean field zyada), aur embeddings 6 se ghatkar
**3–4** — fusion saaf, thoda sasta aur tez bhi.
Variants: `rewritten` + `stepBack` + `hyde` + (0 ya 1 `subQuery`).

**(b) HyDE prompt corpus se match karega.**
Abhi prompt kehta hai *"excerpt from a relevant reference document… neutral, encyclopedic tone"* —
lekin corpus **boli hui video-tutorial transcripts** hai. Encyclopedic prose embedding space ke
galat hisse me land karta hai, isliye HyDE abhi practically bekaar hai. Naya prompt: *"a spoken
explanation from a video tutorial transcript — the way an instructor talks while
demonstrating"* (conversational, first-person, "so", "let's", filler natural). Ek line ka
change, HyDE ko actually kaam par laga dega.

**(c) Answer step:**
- Structured output (`response_format: json_schema` — repo me pehle se yahi pattern hai) se
  `{ answer, citations: [{ chunk, quote }] }` mange, `[1]` markers parse karne ke bajaye.
- **`pinpointSentence()`** (~30 lines): model ka `quote` us chunk ke **sentences** se token-overlap
  par match kare → us sentence ka `cueStart` = **exact ms**. Citation ~80s window se ek single
  line par aa jata hai.
  Deterministic, koi extra LLM call nahi.
- System prompt: sirf transcript se answer; **user ki bhasha mirror** karo; transcripts
  auto-generated hain isliye ASR errors ho sakte hain (`"some while development"` = `"so, mobile
  development"`) — charitably padho; na mile to saaf bolo "course me cover nahi hua".

**`src/sources.js` → indexing status** — kaunse lessons indexed hain (Qdrant se aggregate),
taaki UI keh sake "87 me se 12 indexed".

**`src/qdrant.js`** — `courseId` + `lessonId` + `moduleId` keyword payload indexes add
(filtered delete aur course-scoped search dono ke liye zaroori).

**`src/index.js`** — routes:

| Method | Route | Qdrant/OpenAI chahiye? |
|---|---|---|
| GET | `/api/courses` — light list, switcher ke liye | ❌ nahi |
| GET | `/api/catalog?courseId=` — ek course ka tree | ❌ nahi |
| GET | `/api/lessons/:lessonId/transcript` | ❌ nahi |
| GET | `/api/status?courseId=` | ✅ Qdrant |
| POST | `/api/query` `{query, courseId?}` → 202 `{jobId}` | ✅ dono |
| GET | `/api/query/:id` | ✅ |
| GET | `/api/index/:id` | ✅ |

`courseId` har jagah known course ids ke against validate hoga (unknown → 400), taaki woh
Qdrant filter me bina check ke na jaye. Poora catalog ek call me bhejne ke bajaye alag isliye —
3 courses × 87 lessons ka JSON har page load par bhejna faltu hai.

### Deleted
`multer` + `pdf-parse` deps, `uploads/` dir, upload routes, `POST /api/index` file handling,
`GET /api/config`, `DELETE /api/sources/:docId`.

### Chunking — structure-aware + sentence-aware + target-size

**Parameters guess nahi hain — 19,203 asli cues par measure kiye:**

| Measurement | Value | Kya matlab |
|---|---|---|
| Cue jo `.` `!` `?` par khatam | **75.0%** | Sentence-aware splitting reliably ho sakti hai |
| Average cue | **52 chars** | ~1200-char chunk ≈ 23 cues ≈ 60–70s |
| Inter-cue gap p50 / p90 / p95 | **359 / 1180 / 1600 ms** | Normal saans vs asli pause |
| Gap ≥ 1200ms | har ~532 chars | Bahut frequent — chunks chhote reh jayenge |
| Gap ≥ **1500ms** | har **~871 chars** | **Sweet spot** — 1200 target ke theek neeche |
| Gap ≥ 2000ms | har ~1966 chars | Bahut kam — target se bada |

Isliye **strong pause = 1500ms**. Iska matlab zyadatar chunks ek asli pause par band honge,
beech-vaakya me nahi.

**Stage 1 — cues → sentences (sentence-aware).**
Cue texts ko jodo aur saath-saath ek `charOffset → cueIndex` map banao. Sentence boundaries par
todo, lekin in par nahi: abbreviations (`e.g.` `i.e.` `etc.` `vs.` `Dr.`), decimals (`3.5`),
filenames/versions (`app.json`, `React.js`, `v2.0`), ellipses. Har sentence apna
`{text, startMs, endMs, cueStart, cueEnd}` offset map se paata hai — **isliye timestamps zinda
rehte hain**. Jo 25% cues bina punctuation ke hain unke liye fallback: sentence `maxSentenceChars`
(~400) se lambi ho to cue boundary par todo.

**Stage 2 — sentences → blocks (structure-aware).**
Naya block tab jab sentence ke pehle cue se pehle ka gap ≥ **1500ms** ho. Discourse markers
(`So,` `Now,` `Alright` `Okay` `Let's` `Perfect.` `Next`) sirf **tiebreaker** hain jab size
already target ke paas ho — hard break nahi, kyunki bolchaal me yeh har jagah aate hain.

**Stage 3 — blocks → chunks (target-size).**
Greedy packing: `target 1200`, `min 600`, `max 1800` chars.
- Chunk band karo jab `size ≥ min` **aur** agla boundary strong ho — yaani asli pause par.
- Hard-close jab agla block `max` cross kara de.
- Ek akela block hi `max` se bada ho → sentence boundaries par todo.
- **Overlap sentence-based hai**, char-based nahi: aakhri poore sentences ~240 chars tak agle
  chunk me le jao. Kabhi shabd ke beech nahi katega.
- Lesson ke aakhri chunk ko chhodkar koi chunk `min` se chhota nahi.

Har chunk phir bhi `startMs`, `endMs`, `cueStart`, `cueEnd` carry karta hai — **clickable
timestamp ki jad wahi hai**.

**Bonus:** ab sentences first-class hain, to `pinpointCue()` model ke quote ko *sentence* se
match karega (cue se nahi) aur us sentence ka `cueStart` dega → aur bhi precise timestamp.

Config keys (`src/config.js` me `chunking`, sab env se override ho sakte hain):
`targetChars 1200` · `minChars 600` · `maxChars 1800` · `overlapChars 240` ·
`strongPauseMs 1500` · `maxSentenceChars 400`.

### Multi-course (~200 lines, 150 nahi — honest estimate)

**Layout auto-detect — aapko files hilani nahi padengi.** `COURSES_PATH` jo folder point kare:
agar usme khud `module N` jaise folders hain → woh **ek hi course** hai. Warna uske har child ko
ek course maana jayega. Matlab aapka maujuda `class-subtitle/` waise ka waisa chalta rahega, aur
`courses/react-course/` drop karte hi doosra course aa jayega. Migration zero.

```
courses/                 ← COURSES_PATH (multi-course mode)
  expo-mastery/
    module 1/<lesson>/<lesson>.srt
  react-native-advanced/
    section 1/<lesson>/<lesson>.srt
```

**Flexible module regex.** Aaj sirf `/^module\s*(\d+)/i` chalta hai. Naya:
`module | section | part | unit | chapter | week | bare number`, saath me optional suffix
(`module 1 hc` → "Module 1 · HC"). Label preserve hoga taaki display "Section 3" bane, "Module 3"
nahi. Guard: number `\d{1,3}` aur leading token hona chahiye, warna `2024-notes` galti se
order 2024 ban jayega. Bina number wale folders (jaise `bonus`) aakhir me, naam jyon ka tyon.

**Lesson id ab `courseId:moduleSlug--lessonSlug`** (e.g. `expo-mastery:module-4--dynamic-routes`).
`:` URL-safe hai aur Express decode kar leta hai. Abhi kuch indexed nahi hai (Qdrant band,
key nahi) → **id format badalne ki migration cost zero hai**.

**Qdrant.** `courseId` keyword payload index add. `searchByVector(vector, filter)` ek optional
filter le — `{ must: [{ key: "courseId", match: { value } }] }`. `retrieveChunks(query, {courseId})`
usko aage pass kare. `courseId` na ho to koi filter nahi → saare courses me search (switcher me
"All courses" option, taaki filter ka optional hona actually kaam aaye).

**Ingest.** `npm run ingest` sab courses karega; `--course=expo-mastery` se ek. `contentHash`
skip-logic pehle jaisi.

### Guardrails + Metadata Router (~180 lines + 4 test files)

**Design: dono ko ek hi call me jodo.** Alag-alag add karne par do extra LLM calls lagte;
saath jodne par ek — kyunki wahi call gate bhi karti hai aur route bhi.

```
query
  │
  ├─ 1. maskPII()          regex — 0 LLM calls
  │
  ├─ 2. classifyQuery()    1 LLM call — gate AUR intent ek saath
  │        → { allowed, reason, intent: "content" | "metadata" }
  │
  ├─ blocked   → polite refusal          (0 aur calls)
  ├─ metadata  → answerFromCatalog()     (1 call, koi vector search nahi)
  └─ content   → maujooda pipeline       (rewriting ∥ HyDE → 3–4 search → RRF → answer)
```

**Cost** — *(aapke addendum me "6 search" tha; woh purane design ka number hai. Conditional
decomposition ke baad ab 3–4 hai, isliye yahan correct kiya hai.)*

| Query type | Aaj | Router ke baad |
|---|---|---|
| Content | 3 LLM + 1 embed + 3–4 search | 4 LLM + 1 embed + 3–4 search — ~0.5s slower |
| Metadata | 3 LLM + 1 embed + 3–4 search, **aur jawab galat** | 2 LLM, 0 search — ~3s faster, **sahi jawab** |
| Off-topic | 3 LLM + 1 embed + 3–4 search | 1 LLM — ~5s faster |

Mixed workload par latency roughly neutral, metadata questions par actually behtar.

#### Metadata answering — koi query language nahi
Catalog chhota hai: 18 modules + 87 lessons ≈ **~1200 tokens**. Isliye mini query-language
likhne ki zarurat nahi — poora catalog context me daal do aur model jawab de de. Isse ye sab
apne aap chal jayenge, bina har question type enumerate kiye:
*"Module 5 me kitne lessons hain?"* · *"Navigation kaunse module me padhaya hai?"* ·
*"Module 3 ke baad kya aata hai?"* · *"Kitne lessons indexed hain?"* (indexing status merge karke).

**`durationMs` — measure kar liya, ab decision badal raha hoon.** Aapne default *off* rakha tha
jab tak boot cost pata na ho. Naapa: **199 ms cold / 97 ms warm**, saari 87 files, **10 MB heap**
(poora course 22.7 ghante ka hai). 199ms one-time cost par duration questions block karna faltu
hai → **default ON**. `SCAN_DURATIONS=false` se band ho sakta hai.

Metadata answers me bhi citations — lesson chips, click par transcript `0:00` par khulta hai.
Baaki UI se consistent.

#### PII masking — asli risk yahin hai
Regex-based: email, OpenAI-style keys (`sk-…`), lambe hex/base64 tokens, conservative phone pattern.

Asli khatra aapke domain-specific data me hai: **poora corpus numbers se bhara hai jo PII jaisa
dikhta hai.** Naive phone regex `00:00:06,420` ko phone samajh kar maar dega — yaani poore project
ki jad. Explicitly **NOT masked**:

| Pattern | Kyun bachana hai |
|---|---|
| `00:00:06,420` | Timestamps — poore project ki jad |
| `#c3f53c` | Hex colors |
| `8081`, `0.0.0.0` | Ports, IPs — course me code hai |
| `1.2.3` | Version numbers |

Ye chaaron **pinned negative tests** me jayenge.

Masking input par (asli value: aapki paste ki hui API key OpenAI tak na jaye) aur output par bhi.
UI me chhota amber notice: *"1 secret masked before sending"*.

#### Topic gate — tuning ka nuance
Gate ka **sirf ek kaam**: clearly off-topic reject karna (mausam, politics, "ek poem likho").

**Ye NAHI karna:** *"React Native me useState kaise use karte hain"* ko reject karna sirf isliye ki
course me shayad cover nahi hai. Woh RAG prompt ka kaam hai — woh already bolta hai
"course me cover nahi hua". Do alag failure modes hain, aur over-aggressive gate legitimate
sawaal maar dega. **Dono ke liye alag test.**

#### Ambiguity par kya karein
*"Module 5 me navigation kaise karte hain"* — ye dono hai. **Rule: doubt me content path chuno.**
Kyunki content path gracefully degrade karta hai (module ka zikr chunks me mil hi jayega), par
metadata path ek "kaise" sawaal ka jawab de hi nahi sakta.

### Catalog fixes (test run me mile hue asli bugs)

1. **Module 3 ka sort galat hai** — mini-projects aur chapters dono 1 se shuru hote hain to mix ho
   jaate hain. Fix: `parseLessonName` ab `kind` (`chapter` | `mini-project`) bhi lautaye; sort
   `(kindRank, order)` se — chapters pehle, phir mini-projects, UI me badge ke saath.
2. **Source typos** — chhota `TITLE_FIXES` map (5 entries): `Porps`→`Props`, `Notificaiton`→
   `Notification`, `Authenitcation`→`Authentication`, `Changin`→`Changing`, `Remainder`→`Reminder`.
3. **Component naam** — `(view , text , textinput , stylesheet)` → `(View, Text, TextInput, StyleSheet)`.
4. **5 lessons bilkul bina naam ke** (Module 17 ke `chapter-1..4`, Module 15 ka `chapter-3`).
   *Optional* `npm run titles:generate` transcript se naam banata hai; file na ho to
   catalog chup-chaap "Chapter 3" par gir jata hai. **Default off.**

---

## Frontend — Cinema Timeline

Palette `#0b0c0e` ground, electric-lime `#c3f53c` playhead accent, amber badge, JetBrains Mono
timecodes. Type: **Archivo / Archivo Expanded** (UI + headings) + **JetBrains Mono** (har timecode).
Purani "Reading Room" oak/amber theme puri tarah replace hogi.

### Layout

```
┌─ 260px ────────┬─ flexible ──────────────┬─ 380px ─────────────┐
│ ▼ Expo Mastery │ CONVERSATION            │ TRANSCRIPT          │
│ ── switcher ── │ answer + citation chips │ cue rows + playhead │
│ MODULE RAIL    │ retrieval trace         │ range wash          │
│ accordion      │ ─────────────────────── │ pinpoint border     │
│ indexed dots   │ COMPOSER                │                     │
└────────────────┴─────────────────────────┴─────────────────────┘
```

Responsive: <1200px transcript overlay drawer; <900px rail bhi drawer (App.jsx ka maujuda
drawer+scrim pattern reuse).

### Components

| File | Status |
|---|---|
| `styles/tokens.css` | **rewrite** — naya palette/type |
| `components/CourseSwitcher.jsx` | **naya** — rail ke upar dropdown; "All courses" + har course ka lesson count. Native `<select>` nahi, custom listbox (roving focus, `aria-activedescendant`) taaki theme se match kare |
| `components/ModuleRail.jsx` | **naya** (ArchiveRail replace) — accordion, indexed dot, lesson click |
| `components/TranscriptPane.jsx` | **naya** — cue rows, jump + highlight |
| `components/Conversation.jsx` | rewrite — citation chips |
| `components/CitationChip.jsx` | **naya** — `Module 4 · Dynamic Routes · 04:22` |
| `components/RetrievalTrace.jsx` | restyle — jitne variants actually chale (3–4) + RRF. Compound query par sub-query row dikhega, warna nahi — trace se hi pata chal jayega ki decomposition skip hua |
| `components/Composer.jsx` | restyle + PII notice — composer ke upar chhoti amber line |
| `components/Header.jsx` | restyle |
| `components/Conversation.jsx` (guardrails) | Blocked query → polite card, **koi retrieval trace nahi**. Metadata answer → "Catalog" badge |
| `components/CitationChip.jsx` (metadata mode) | Timestamp chip ki jagah lesson chip — click par transcript `0:00` par khulta hai |
| `hooks/useCatalog.js`, `hooks/useTranscript.js` | **naye** (useSources replace). `useCatalog` courses list + `activeCourseId` rakhega, `localStorage` me persist karega |
| `hooks/useConversation.js` | reuse — bas `ask(question, courseId)` me courseId thread karna hai |
| `api/client.js` | `request`/`ApiError`/`isAbort`/`pollJob` **reuse**; upload helpers hataao, `getCourses`/`getCatalog`/`getTranscript` add |
| `lib/format.js` | `formatDuration`/`truncate` rakho, `formatBytes`/`formatWhen` hatao, `formatTimecode` add |

### Signature details
- **Playhead chip** — citation lime tick ke saath scrubber jaisa; hover par cue preview.
- **Transcript = timeline** — left gutter mono timecode + patli film spine; cited range wash hota
  hai, pinpoint cue par solid lime border + ek baar pulse.
- Load par teen panel staggered reveal. Sab CSS-only, `prefers-reduced-motion` respected.

### Accessibility
Citation chips asli `<button>` — `aria-label="Jump to Module 4, Dynamic Routes at 04:22"`.
Jump par focus pinpoint cue par jata hai (`tabIndex={-1}`), `aria-live="polite"` announce karta hai.
`Esc` drawers band karta hai. Lime-on-black ≈ 15:1 contrast; muted text ≥ 4.5:1.

### Course switch karne par kya hota hai
- Module rail naye course ka tree load karta hai; accordion state reset.
- **Chat history rehti hai** (woh aapka record hai) — bas naye sawaal naye course me scope honge.
  Har turn par uska course chip dikhega taaki confusion na ho ki kis course ne jawab diya.
- Transcript pane tabhi band hoga jab khula lesson naye course me nahi hai.
- Choice `localStorage` me yaad rahegi.

### Deep links
`#/lesson/<lessonId>?t=<ms>` — lessonId me courseId already hai, to link khud-ba-khud sahi course
par switch kar dega. Shareable, browser back button kaam karta hai.

---

## Verification

**Bina API key ke (main abhi kar sakta hoon):**
1. `node --test` — parser, catalog naming, **flexible module regex** (`module 1` / `section 2` /
   `part 3` / `unit 4` / bare `05` / `module 1 hc` / bina-number `bonus`), chunker cue-boundary,
   RRF, pinpointCue.
2. **Chunker invariants — saare 87 real lessons par assert:**
   - Koi cue kisi chunk me se gayab na ho (**zero data loss**), aur `cueStart` non-decreasing.
   - `startMs ≤ endMs`, `cueStart ≤ cueEnd`.
   - Koi chunk `max` (1800) se bada nahi; aakhri ke alawa koi `min` (600) se chhota nahi.
   - Har chunk sentence start par shuru aur sentence end par khatam (overlap prefix chhodkar) —
     yaani beech-vaakya kabhi nahi katega.
   - Size distribution p50/p90 print karunga taaki dikh jaye target 1200 ke aas-paas hai.
   - Abbreviation traps pinned: `e.g.` `i.e.` `vs.` `app.json` `React.js` `v2.0` `3.5` par
     sentence nahi tootni chahiye.
3. **Multi-course detect test:** ek temp folder banaunga jisme aapke course ka ek chhota copy
   `courses/a/` aur `courses/b/` ke roop me ho → assert ki 2 courses mile, ids prefix hue,
   aur ek hi `module 1` dono me hone par bhi ids collide na karein. Saath hi single-course
   auto-detect abhi bhi aapke asli folder par kaam kare.
4. Server boot → `/api/courses` 1 course de, `/api/catalog` 87 lessons de,
   `/api/lessons/:id/transcript` asli cues de, galat id par 404 (path-traversal attempt par bhi
   404), unknown `courseId` par 400.
5. `npm run build` web me — clean build, `oxlint` clean.
6. UI ko Playwright MCP se real browser me kholunga: rail se lesson click → transcript panel me
   cues + highlight; switcher kholke dekhunga. Screenshot bhejunga.
7. **Retrieval unit tests** (LLM ke bina — `queryRewriting` mock karke): single-intent query par
   3 variants banein aur `subQueries` khali ho; compound query par 4 banein. `pinpointSentence()`
   exact quote, thoda-badla quote, aur bilkul na-milne wale quote (→ chunk `startMs` fallback)
   teeno par test.
8. **Guardrails + router tests** — 4 test files, sab bina API key ke:
   - **PII:** email / phone / `sk-…` key mask hote hain; `00:00:06,420`, `#c3f53c`, `8081`,
     `1.2.3` **nahi** hote (pinned negatives).
   - **Gate:** off-topic reject; **on-topic-par-uncovered pass** — ye zyada important test hai.
   - **Router:** *"module 5 me kitne lessons"* → metadata; *"dynamic route kaise banaye"* →
     content; mixed → content.
   - **Catalog answer:** counts asli scan se match karein (18 modules / 87 lessons).

   Gate aur router asli me LLM call karte hain, isliye woh live tests `--test-only` ke peeche
   rahenge; default run me unki jagah **classifier output ke fixtures par pure-logic tests**
   chalenge — matlab `npm test` API key ke bina hamesha green.

**API key ke baad (aapko chahiye):**
```bash
cp .env.example .env      # OPENAI_API_KEY daalein
npm run services:up       # Qdrant (abhi band hai)
npm run worker            # alag terminal
npm run ingest            # 87 lessons — ~2000 chunks, one-time ~$0.01
```
Phir: sawaal puchho → citation par click → transcript us line par highlight. Yeh main verify
karunga agar aap key daal dein; warna aapke liye README me exact steps rahenge.

---

## Risks

| Risk | Handling |
|---|---|
| API key nahi hai | Chat ke alawa sab build+verify ho jayega; ingest aapke ek command par |
| Qdrant band hai | `npm run services:up` (docker-compose repo me hai). Docker na ho to bataunga |
| Pinpoint quote match fail | Fallback = chunk ka `startMs` (aaj se to behtar hi hai) |
| ASR errors retrieval bigaadein | Multi-variant expansion + RRF isi ke liye hai; naya HyDE prompt (spoken-transcript style) isme aur madad karega; prompt me bhi note |
| `isCompound` galat classify ho | Worst case = ek variant kam/zyada. RRF degrade gracefully karta hai; trace me dikhega to pakad me aa jayega |
| **PII regex timestamps kha jaye** | Conservative patterns + **4 pinned negative tests** (`00:00:06,420`, `#c3f53c`, `8081`, `1.2.3`) |
| Gate legitimate sawaal reject kare | Tuned prompt + **"uncovered ≠ off-topic" test** — ye zyada important test hai |
| Router mixed question galat classify kare | Ambiguity par content path — safe default |
| Catalog context har metadata query me | ~1200 tokens, ~$0.0002 — non-issue |
| 900 cue rows slow | Max ~900 rows — plain DOM theek hai, virtualization ki zarurat nahi (measure karunga) |
| Flexible regex over-match kare | `\d{1,3}` + leading-token guard; test me `2024-notes` jaisa case pin kiya hua hai |
| Course folder galat nested ho | Auto-detect dono layouts handle karta hai; kuch na mile to `/api/courses` khali array de aur UI saaf message dikhaye (crash nahi) |

## Out of scope
Video playback (aapne transcript maanga tha, video nahi), auth, in-app re-index button,
PDF upload (aapne hataane ko kaha), per-module filtering (per-**course** filter ban raha hai),
cross-course answer merging beyond the "All courses" option.
