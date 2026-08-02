# How It Works — poora flow, file by file

Ye doc ek hi sawaal ka jawab deta hai: **"jab main kuch karta hoon, to andar exactly kya hota hai,
kaun si file chalti hai, aur kis order me?"**

Teen docs hain repo me, teeno ka kaam alag hai — confuse mat hona:


| Doc                                        | Kis liye                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| [README.md](README.md)                     | Setup, commands, API reference, config. "Chalana kaise hai."                               |
| [PIPELINE-EXAMPLE.md](PIPELINE-EXAMPLE.md) | Ek **asli run** ka data — asli chunks, asli scores, asli timings. "Numbers kya aate hain." |
| **HOW-IT-WORKS.md** (ye)                   | **Code ka flow** — kaun si file kis ko bulati hai, kab, aur kyun. "Andar kya hota hai."    |


---

## Contents

- [Part 0 — Bade picture](#part-0--bade-picture)
- [Part 1 — Saari files ka naksha](#part-1--saari-files-ka-naksha)
- [Flow A — Sab kuch start karna (boot)](#flow-a--sab-kuch-start-karna-boot)
- [Flow B — Ingest: course ko searchable banana](#flow-b--ingest-course-ko-searchable-banana)
- [Flow C — Browser khulta hai (page load)](#flow-c--browser-khulta-hai-page-load)
- [Flow D — Sawaal puchna (asli pipeline)](#flow-d--sawaal-puchna-asli-pipeline)
- [Flow E — Citation click → transcript highlight](#flow-e--citation-click--transcript-highlight)
- [Flow F — Rail se lesson kholna](#flow-f--rail-se-lesson-kholna)
- [Flow G — Course switch karna](#flow-g--course-switch-karna)
- [Flow H — Deep link se aana](#flow-h--deep-link-se-aana)
- [Part 2 — Ek timestamp ka poora safar](#part-2--ek-timestamp-ka-poora-safar)
- [Part 3 — Har file ka card](#part-3--har-file-ka-card)
- [Part 4 — Kaunsa feature kis par depend karta hai](#part-4--kaunsa-feature-kis-par-depend-karta-hai)
- [Part 5 — Paisa kahan lagta hai](#part-5--paisa-kahan-lagta-hai)
- [Part 6 — Kuch toota to kahan dekho](#part-6--kuch-toota-to-kahan-dekho)
- [Part 7 — Config knobs](#part-7--config-knobs)
- [Part 8 — Do cheezein jo doc aur code me match nahi karti](#part-8--do-cheezein-jo-doc-aur-code-me-match-nahi-karti)

---

# Part 0 — Bade picture

Chalne ke liye **4 cheezein** chahiye. Ye alag-alag process hain, ek doosre ko nahi jaante — bas
network par baat karte hain.

```
┌──────────────────────────────────────────────────────────────────────────┐
│  BROWSER                                                                 │
│  React app (web/dist ya Vite dev server)                                 │
│  3 pane: syllabus · chat · transcript                                    │
└────────────────────────────┬─────────────────────────────────────────────┘
                             │  fetch /api/...
                             ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  API SERVER          npm start        →  src/index.js       (port 8000)  │
│  - routes                                                                │
│  - kuch bhi bhaari kaam NAHI karta                                       │
│  - bhaari kaam Redis queue me daal deta hai                              │
└──────┬────────────────────────────────────────────────┬──────────────────┘
       │ job daalo                                      │ disk padho
       ▼                                                ▼
┌──────────────────┐                        ┌──────────────────────────────┐
│  REDIS  :6379    │                        │  DISK                        │
│  BullMQ ki queue │                        │  class-subtitle/**/*.srt     │
│  2 queue:        │                        │  (read-only, kabhi likhte    │
│   lesson-indexing│                        │   nahi)                      │
│   query          │                        └──────────────────────────────┘
└──────┬───────────┘
       │ job uthao
       ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  WORKER              npm run worker   →  src/worker.js                   │
│  - parsing, chunking, embedding, LLM calls — sab yahan                   │
│  - crash ho jaye to job retry hoti hai, browser wait nahi karta          │
└──────┬─────────────────────────────────────────┬─────────────────────────┘
       │ vectors likho / dhundo                  │ OpenAI
       ▼                                         ▼
┌──────────────────┐                  ┌──────────────────────────────────┐
│  QDRANT  :6333   │                  │  OPENAI API                      │
│  vector DB       │                  │  embeddings + gpt-4o-mini        │
│  collection:     │                  └──────────────────────────────────┘
│  course_transcripts                 │
└──────────────────┘
```

**Sabse zaroori idea:** API server jaan-boojh kar **bewakoof** rakha gaya hai. Woh sirf routes
serve karta hai aur disk padhta hai. Jo bhi cheez slow ya mehngi hai (parse, embed, LLM), woh
**worker** karta hai. Isse do fayde:

1. Browser kabhi 30 second tak latka nahi rehta — use turant `jobId` mil jaata hai.
2. Koi job fail ho to woh apne aap retry hoti hai, aur user ko pata bhi nahi chalta.

---

# Part 1 — Saari files ka naksha

## Backend — `src/`


| File                | Ek line me                                                    | Kab chalti hai                      |
| ------------------- | ------------------------------------------------------------- | ----------------------------------- |
| `config.js`         | Saari settings ek jagah, `.env` se override                   | Har file ke import par, sabse pehle |
| `index.js`          | Express routes + static frontend serve                        | `npm start`                         |
| `queue.js`          | Do BullMQ queue banata hai, jobs enqueue karta hai            | API server + ingest script          |
| `worker.js`         | Dono queue ka consumer — asli kaam yahin hota hai             | `npm run worker`                    |
| `catalog.js`        | Folders → courses/modules/lessons ka tree                     | Pehli request par (phir cached)     |
| `subtitles.js`      | `.srt` / `.vtt` → cues (`{index, startMs, endMs, text}`)      | Indexing + transcript read          |
| `chunker.js`        | Cues → embeddable chunks (3 stage)                            | Indexing + pinpoint                 |
| `indexer.js`        | Ek lesson ko index karta hai (chunk → embed → upsert)         | Indexing job                        |
| `qdrant.js`         | Qdrant client, collection, payload index, course filter       | Indexing + search                   |
| `openai.js`         | Embeddings + chat (JSON schema wale aur plain)                | Har LLM/embed call                  |
| `pipeline.js`       | Ek sawaal ka **traffic controller** — mask → classify → route | Query job                           |
| `guardrails.js`     | Regex se PII mask (email, key, token, phone)                  | Har query, sabse pehle              |
| `router.js`         | 1 LLM call: "allowed?" + "content ya metadata?"               | Har allowed query                   |
| `retriever.js`      | Content path — expansion, search, RRF, answer, pinpoint       | Content queries                     |
| `catalog-answer.js` | Syllabus path — bina vector search ke jawab                   | Metadata queries                    |
| `transcript.js`     | Poora transcript disk se, LRU cache ke saath                  | Transcript pane + pinpoint          |
| `status.js`         | Qdrant se ginta hai ki kitna indexed hai                      | `/api/status`, rail dots            |


## Scripts — `scripts/`


| File                 | Kaam                                                                   |
| -------------------- | ---------------------------------------------------------------------- |
| `ingest-course.js`   | Saare lessons queue me daalo, progress bar dikhao, drain hone par exit |
| `generate-titles.js` | *(optional)* Bina naam wale lessons ke titles LLM se banao             |


## Frontend — `web/src/`


| File                            | Ek line me                                                       |
| ------------------------------- | ---------------------------------------------------------------- |
| `main.jsx`                      | React root mount + `tokens.css` load                             |
| `App.jsx`                       | 3-pane layout, deep links, citation jump, course-change handling |
| `styles/tokens.css`             | Poori design language — colors, type, motion, reset              |
| `api/client.js`                 | Abortable fetch, `ApiError`, bounded job polling                 |
| `lib/format.js`                 | `formatTimecode`, `formatLength`, `truncate`, `variantLabel`     |
| `hooks/useCatalog.js`           | Course list + active course + tree + indexing status             |
| `hooks/useConversation.js`      | Chat turns — ask, poll, stop, clear                              |
| `hooks/useTranscript.js`        | Kaunsa lesson khula hai, aur usme kahan dekhna hai               |
| `components/Header.jsx`         | Top bar, drawer toggles, live indexed counter                    |
| `components/ModuleRail.jsx`     | Left rail — accordion syllabus + indexed dots                    |
| `components/CourseSwitcher.jsx` | Custom listbox (native `<select>` nahi)                          |
| `components/Conversation.jsx`   | Middle pane — turns, empty state, answer shapes                  |
| `components/CitationChip.jsx`   | Clickable source — module · lesson · timecode                    |
| `components/RetrievalTrace.jsx` | "Kaise dhunda" — variants + fused ranking                        |
| `components/Composer.jsx`       | Sawaal ka box, Enter/Shift+Enter                                 |
| `components/TranscriptPane.jsx` | Right pane — cue rows, wash, playhead, scroll                    |


## Tests — `test/`

`subtitles` · `chunker` · `catalog` · `guardrails` · `retrieval` — **90 tests, sab pass**.
Koi API key, Redis ya Qdrant nahi chahiye (`node --test`, zero extra deps).

---

# Flow A — Sab kuch start karna (boot)

Teen terminal, teen command. Order maayne rakhta hai.

### 1. `npm run services:up`

`docker-compose.yml` padhta hai → Qdrant container up (`:6333` REST, `:6334` gRPC).
Data ek named volume `qdrant_data` me rehta hai, isliye container restart par vectors nahi udte.

> Redis compose me **nahi** hai — jaan-boojh kar. Is machine par `redis-server` pehle se system
> service hai `:6379` par.

### 2. `npm start` → [src/index.js](src/index.js)

```
src/index.js
   ↓ import
config.js  ─── "dotenv/config" ─── .env padha jaata hai
   ↓
express app banta hai
   ↓ routes register (order maayne rakhta hai!)
   /api/health
   /api/courses          ← disk only
   /api/catalog          ← disk only
   /api/lessons/:id/transcript  ← disk only
   /api/status           ← Qdrant chahiye
   POST /api/query       ← job daalta hai
   GET  /api/query/:id   ← job poll
   GET  /api/index/:id   ← job poll
   /admin/queues         ← Bull Board dashboard
   /*                    ← React app (SPA catch-all)
   ↓
app.listen(8000)
```

Do detail jo aasani se galat ho jaati hain:

- **Bull Board SPA catch-all se PEHLE mount hota hai.** Warna `/admin/queues` bhi
`index.html` return karta.
- `**index.html` par `Cache-Control: no-cache`, baaki assets par 1 saal `immutable`.**
Assets ke naam me content-hash hota hai (`index-DdGgPJMZ.js`) — woh kabhi badalte nahi to
hamesha cache karo. Lekin `index.html` hi woh file hai jo batati hai ki current hash kya hai.
Agar woh cache ho gayi to browser purane build par atak jaata hai.
*(Ye bug asli me hua tha — ek fix browser tak pahuncha hi nahi tha.)*

Boot par ye warning aa sakti hai:

```
⚠️  OPENAI_API_KEY is not set — catalog and transcripts work, chat won't.
```

Ye **sach** hai, dhamki nahi. Bina key ke bhi rail aur transcript pane poore chalte hain.

### 3. `npm run worker` → [src/worker.js](src/worker.js)

Do `Worker` banata hai:


| Queue             | Concurrency              | Handler         |
| ----------------- | ------------------------ | --------------- |
| `lesson-indexing` | 3 (`INGEST_CONCURRENCY`) | `indexLesson()` |
| `query`           | 4                        | `handleQuery()` |


Do cheezein yahan important hain:

- `**UnrecoverableError`** — agar lesson ki file hi nahi padh sakti (`UnprocessableLessonError`),
to 4 baar retry karna bewakoofi hai. Worker use `UnrecoverableError` me convert karta hai →
job ek hi baar fail hoti hai.
- **Graceful shutdown** — `SIGINT`/`SIGTERM` par chal rahi jobs poori hone di jaati hain, taaki
Redis me "active" jobs atki na rahen.

### Catalog scan kab hota hai?

**Boot par nahi.** Pehli baar jab koi `getCourses()` call karta hai (matlab pehli
`/api/courses` request), tab [catalog.js](src/catalog.js) disk scan karta hai aur result ek
module-level variable me cache ho jaata hai:

```js
let cached = null;
export function getCourses() {
  if (!cached) {
    cached = scanCourses().catch((err) => { cached = null; throw err; });
  }
  return cached;
}
```

Note: **fail hui scan cache nahi hoti.** Matlab `COURSE_PATH` galat tha, aapne `.env` theek
kiya — agli request par apne aap sahi chalega, restart ki zarurat nahi.

Scan ke andar (`SCAN_DURATIONS=false` na ho to) har lesson ki file padhi jaati hai sirf uski
**length** jaanne ke liye. 87 files = ~199ms thandi, ~97ms garam. Isi se rail me "12 min"
dikhta hai aur *"sabse lambi lecture kaunsi hai?"* jaisa sawaal answerable ban jaata hai.

---

# Flow B — Ingest: course ko searchable banana

**Ek baar ka kaam.** Iske baad chunks Qdrant me pade rehte hain.

```bash
npm run ingest
```

## Producer side — [scripts/ingest-course.js](scripts/ingest-course.js)

```
1. parseArgs()          --course= --module= --force --list --help
2. getCourses()         catalog.js — disk scan (ya cache)
3. filter               course/module ke hisaab se
4. guard                courses 0? → exit 1
                        koi lesson match nahi? → exit 1
                        OPENAI_API_KEY nahi? → exit 1  (paisa lagne se pehle)
5. queue clean          pichle run ke completed/failed hataao,
                        taaki progress bar 0 se shuru ho
6. loop → enqueueIndexingJob({ lessonId, title, force })
7. watchProgress()      har 500ms counters poll karo, bar draw karo
8. drain → summary → exit 0
```

`watchProgress()` me ek chhoti si samajhdari hai: agar **10 second tak** kuch complete nahi hua
**aur** kuch active bhi nahi hai, to woh ye print karta hai —

```
⚠️  Nothing is being processed. Is the worker running?
   Start it in another terminal:  npm run worker
```

Ye sabse common galti hai, isliye script khud pakad leti hai.

Script **producer** hai, worker nahi. Beech me `Ctrl+C` maar do — worker chalta rahega, aur
dobara `npm run ingest` chalane par jo ho chuka hai woh skip ho jayega.

## Job ka id — duplicate se bachav

[queue.js](src/queue.js):

```js
jobId: `lesson:${payload.lessonId}${payload.force ? ":force" : ""}`
```

Job id lesson se banta hai. Isliye do baar ingest chalane par BullMQ duplicate job ignore kar
deta hai (jab tak purani job retained hai).

Retry policy: `attempts: 4`, exponential backoff 3s se — kyunki OpenAI ka embedding
**per-minute rate limit** hai, aur wahi sabse aam temporary failure hai.

## Consumer side — [src/indexer.js](src/indexer.js)

Yahan asli kaam hota hai. Har lesson ke liye:

```
indexLesson({ lessonId, force })
│
├─ 1. findLesson(lessonId)              catalog.js
│      └─ trusted Map lookup — client string kabhi path me join nahi hoti
│      └─ nahi mila? → UnprocessableLessonError (retry pointless)
│
├─ 2. fs.readFile(lesson.filePath)      raw .srt text
│
├─ 3. sha256(raw) → contentHash
│
├─ 4. storedHash(lessonId)              Qdrant scroll, limit 1, sirf contentHash payload
│      └─ same hash aur !force? → { skipped: true }  ✋ YAHIN RUK JAO
│         (0 embedding, ₹0 kharcha)
│
├─ 5. parseSubtitles(raw)               subtitles.js → cues
│      └─ 0 cues? → UnprocessableLessonError
│
├─ 6. chunkCues(cues)                   chunker.js → 3 stages
│      └─ 0 chunks? → UnprocessableLessonError
│
├─ 7. ensureCollection()                qdrant.js
│      └─ collection banao (agar nahi hai)
│      └─ payload index banao: courseId, lessonId, moduleId
│         (dobara banane par server-side no-op — safe)
│
├─ 8. embedTexts(chunks.map(c => c.text))    openai.js, 100 ka batch
│
├─ 9. deleteLessonPoints(lessonId)      purane points hatao
│      └─ merge NAHI karte: chunker badla to boundaries shift ho jaate hain,
│         aur purane points chupke se pade reh jaate
│
└─ 10. qdrant.upsert(points)            wait: true
```

---

### 🎓 Samajhne ke liye — poora ingest zero se

*Upar ka flow ek nazar me dekhne ke liye hai. Agar "producer/consumer kya hai", "job id kya
karta hai", ya "`wait: true` ka matlab kya hai" clear nahi hua — ye section bilkul zero se,
aasan bhasha me samjhata hai. Numbers asli hain, ek asli lesson par chalake nikale gaye.*

#### Pehle: do alag programs kyun hain?

Yahi asli confusion hai. `npm run ingest` aur `npm run worker` **do alag programs** hain jo ek
doosre ko jaante tak nahi. Beech me Redis khada hai.

##### Restaurant wala scene

```
   AAP                WAITER              PARCHI KA RAIL           COOK
                  (npm run ingest)          (Redis)         (npm run worker)
    │                    │                     │                    │
    │  "87 order lagao"  │                     │                    │
    ├───────────────────►│                     │                    │
    │                    │  87 parchi likhi    │                    │
    │                    ├────────────────────►│                    │
    │                    │                     │  parchi uthai      │
    │                    │                     │◄───────────────────┤
    │                    │                     │                    │ khana banaya
    │                    │  "kitne ho gaye?"   │                    │
    │                    ├────────────────────►│                    │
    │                    │  "43/87"            │                    │
    │                    │◄────────────────────┤                    │
```

**Waiter khana nahi banata.** Woh sirf 87 parchi likh kar rail par taang deta hai, aur phir wahin
khada ho kar ginta rehta hai ki kitni parchi khatam hui. Bas.

**Cook ko waiter se koi matlab nahi.** Uske saamne rail par parchi hai — woh uthata hai, khana
banata hai, agli uthata hai.

Ab code me:

| Restaurant | Code |
|---|---|
| Waiter | `scripts/ingest-course.js` — **producer** |
| Parchi ka rail | Redis, queue ka naam `lesson-indexing` |
| Cook | `src/worker.js` — **consumer** |
| Ek parchi | Ek "job" = `{ lessonId, title, force }` |
| Khana banana | `src/indexer.js` → `indexLesson()` |

**Isiliye do terminal chahiye.** Cook nahi hai to parchi rail par latki reh jayegi — aur waiter
10 second baad khud bolega:

```
⚠️  Nothing is being processed. Is the worker running?
```

**Aur isiliye `Ctrl+C` safe hai.** Waiter chala gaya to bhi cook kaam karta rahega — parchi to
rail par hai na.

#### Producer (waiter) exactly kya karta hai

Woh 8 steps sirf **parchi likhne ki taiyari** hain. Ek bhi step me na koi file parse hoti hai,
na embedding banti hai.

| Step | Simple bhasha me |
|---|---|
| 1. `parseArgs()` | "Kya sab karna hai ya sirf ek module?" |
| 2. `getCourses()` | Folder scan — kitne lessons hain hi |
| 3. filter | `--course=` / `--module=` laga to list chhoti karo |
| 4. guards | **Paisa lagne se pehle** rok do |
| 5. queue clean | Pichhli baar ki purani parchi hatao |
| 6. loop → enqueue | **87 parchi likho aur rail par taang do** ← asli kaam |
| 7. `watchProgress()` | Har 0.5 sec ginti karo, bar banao |
| 8. exit | Sab ho gaya → nikal jao |

**Step 4 sabse zyada kaam ka hai.** Dekho order:

```js
if (courses.length === 0)  → exit 1     // koi course hi nahi
if (selected.length === 0) → exit 1     // filter se kuch nahi bacha
if (!config.openai.apiKey) → exit 1     // ← YE SABSE AAKHIR ME, PAR ENQUEUE SE PEHLE
```

API key ka check **jaan-boojh kar enqueue se pehle** hai. Warna kya hota? 87 parchi rail par chali
jaati, cook uthata, aur har ek OpenAI par 401 khaa kar fail hoti. 87 failed jobs, aur wajah kahin
gehrai me chhupi hui. Ab bajaye uske:

```
❌ OPENAI_API_KEY is not set. Copy .env.example to .env and add your key.
```

Ek line, saaf.

#### Job ka id — parchi par naam kyun likhte hain

```js
jobId: `lesson:${payload.lessonId}${payload.force ? ":force" : ""}`
```

Har parchi par ek **naam** likha jaata hai:

```
lesson:expo-mastery:module-4--3-dynamic-routes
```

Random number nahi — **lesson ka naam**. Iska ek hi fayda hai:

> Aapne galti se do terminal me `npm run ingest` chala diya. Doosri baar wahi 87 parchi banengi,
> **wahi naam ke saath**. BullMQ dekhta hai "ye naam wali parchi to pehle se rail par hai" — aur
> nayi ko chup-chaap phenk deta hai.

Bina iske 174 jobs ban jaate aur har lesson **do baar** embed hota. Paisa double.

`--force` lagane par naam badal jaata hai (`...:force`), isliye woh **jaan-boojh kar** alag parchi
ban jaati hai.

##### Retry — `attempts: 4`, backoff 3s

```
fail hui → 3 sec ruko → dobara
fail hui → 6 sec ruko → dobara
fail hui → 12 sec ruko → dobara
fail hui → ab chhod do
```

Ye OpenAI ke **rate limit** ke liye hai. Ek minute me itni requests allowed hain, us se zyada gayi
to `429` aata hai. Woh galti nahi hai — bas **thoda ruk jao** ka matlab hai. Isliye ruk kar dobara
try karte hain, har baar thoda zyada.

Lekin agar file hi corrupt hai? Tab 4 baar try karna bewakoofi hai — 4 baar wahi error aayega.
Isiliye `worker.js` me:

```js
if (err instanceof UnprocessableLessonError) throw new UnrecoverableError(err.message);
```

= "**ye kabhi theek nahi hogi, retry mat karo.**" Ek hi baar fail hoti hai.

#### Consumer (cook) — ek asli lesson ka safar

Ab parchi uthi. Ismein likha hai:

```js
{ lessonId: "expo-mastery:module-4--3-dynamic-routes",
  title: "Module 4 — Dynamic Routes",
  force: false }
```

**Ye asli lesson hai, maine abhi chala kar dekha.** Ab 10 steps, ek-ek karke:

##### Step 1 — `findLesson(lessonId)` · file kahan hai?

Parchi par sirf ek **id** hai, path nahi. Path catalog se milta hai:

```
"expo-mastery:module-4--3-dynamic-routes"
        ↓ Map me dhundo
{ filePath: ".../module 4/3-Dynamic Routes_epm/3-Dynamic Routes_epm.srt",
  moduleTitle: "Module 4", title: "Dynamic Routes", ... }
```

**Ye security ka bhi hissa hai.** Id kabhi `path.join()` me nahi jaati — woh sirf ek **Map ki
chaabi** hai. Chaabi nahi mili to darwaza hi nahi khulta. Koi `../../etc/passwd` bhejne ki
koshish kare — Map me woh chaabi hai hi nahi.

Nahi mila → `UnprocessableLessonError` → retry pointless, ek baar fail.

##### Step 2 — `fs.readFile()` · file padho

```
8,361 bytes ki text file
```

Abhi ye sirf **ek lambi string** hai. Kuch parse nahi hua.

##### Step 3 — `sha256(raw)` · fingerprint banao

```
41ef7867f3e619467f5231341944cc90b350553c545c88ca50a94f85516469a7
```

Ye file ka **fingerprint** hai. Poore 8361 bytes ka nichod, 64 characters me.

Khaas baat: file me **ek comma bhi badal do**, ye 64 characters poore ke poore badal jayenge. Aur
file waisi ki waisi rahe, to ye hamesha **exactly wahi** aayega — aaj bhi, agle saal bhi.

##### Step 4 — `storedHash()` · ✋ **YAHIN PAISA BACHTA HAI**

```js
const res = await qdrant.scroll(collection, {
  limit: 1,                                    // ek hi point kaafi hai
  filter: { must: [{ key: "lessonId", match: { value: lessonId } }] },
  with_payload: ["contentHash"],               // sirf ye ek field
  with_vector: false,                          // 1536 numbers mat bhejo!
});
```

Qdrant se poochta hai: *"is lesson ka jo data tumhare paas pada hai, uska fingerprint kya tha?"*

```
Qdrant bola  : 41ef7867...
Abhi nikala  : 41ef7867...
                 ↓
            BILKUL SAME
                 ↓
   return { skipped: true }   ← Steps 5-10 chalte hi nahi
```

**Isiliye doosri baar ingest chalane par 87/87 skip hote hain aur bill $0.00 aata hai.**

Aur dekho query kitni kanjoos hai: `limit: 1` (ek point kaafi hai), sirf ek payload field, aur
`with_vector: false` — kyunki 1536 numbers network par kheenchne ka koi matlab nahi jab humein
sirf 64 characters chahiye.

`--force` lagao to ye check skip ho jaata hai.

##### Step 5 — `parseSubtitles(raw)` · text → cues

Ab string ko **structure** milta hai:

```
8,361 bytes ki string
        ↓
88 cues
        ↓
{ index: 0,  startMs: 580,    endMs: 4200,   text: "Hey there, welcome back..." }
{ index: 1,  startMs: 4200,   endMs: 8100,   text: "so in this video we are..." }
...
{ index: 87, startMs: 407000, endMs: 411000, text: "...see you in the next one." }
```

Lesson 411 second ka hai ≈ 6 min 51 sec.

**Yahin par timestamp paida hota hai.** Is step se pehle `00:00:00,580` sirf text tha. Ab woh
`580` ban gaya — ek number jise code use kar sakta hai.

0 cues mile? File khaali ya toota hua format → `UnprocessableLessonError`.

##### Step 6 — `chunkCues(cues)` · cues → chunks

```
88 cues  →  7 chunks
```

Pehla chunk asli me aisa nikla:

```
chunk 0 : 1050 characters
          cues 0 se 15 tak
          0.58 sec se 90.9 sec tak   (~90 second ki baat)
```

Har cue chhota hota hai (~52 characters, 3-4 second). Akela cue embed karne se kuch matlab nahi
banta — usme poori baat hi nahi hoti. Isliye ~16 cues jodkar ek **90 second ka samajhne layak
tukda** banaya.

Aur sabse zaroori — chunk ko yaad hai ki woh **kahan se** aaya: `cues 0-15`,
`580ms - 90979ms`. Ye chaar number aage jaake clickable timestamp banenge.

##### Step 7 — `ensureCollection()` · Qdrant taiyaar karo

Do kaam:

1. Collection na ho to bana do (1536 dimensions, Cosine distance)
2. **Payload index bana do** — `courseId`, `lessonId`, `moduleId` par

Doosra kaam zyada zaroori hai. Qdrant me bina index ke aap kisi field par **filter nahi kar
sakte**. Aur is app me do jagah filter chahiye:

- Search ko ek course tak seemit karna → `courseId` index
- Ek lesson ke purane points delete karna → `lessonId` index

Ye har job par chalta hai — **safe hai**, kyunki jo cheez pehle se hai use dobara banana Qdrant
ke liye "theek hai, kuch nahi karta" wala kaam hai.

##### Step 8 — `embedTexts()` · 💰 **YAHIN PAISA LAGTA HAI**

```
7 chunks ka text  →  OpenAI  →  7 vectors, har ek me 1536 numbers
```

Poore ingest me **yahi ek step paisa leta hai**. 87 lessons, 1382 chunks = ~$0.006 total.

`batchSize = 100` — 7 chunks ek hi request me chale jaate hain. 7 alag requests nahi.

##### Step 9 — `deleteLessonPoints()` · purana saaf karo

Naya likhne se **pehle** purana poori tarah uda do.

**Merge kyun nahi karte?** Socho:

```
Kal    : 88 cues → 7 chunks   (chunk 0, 1, 2, 3, 4, 5, 6)
Aaj    : maine CHUNK_TARGET_CHARS 1200 se 900 kar diya
         88 cues → 9 chunks   (chunk 0 se 8)
```

Agar sirf upsert karte (delete ke bina), to chunk 0-6 **overwrite** ho jaate aur 7, 8 **naye add**
ho jaate. Theek lagta hai?

Ab ulta case socho — 9 se 7 par gaye. Naye chunk 0-6 overwrite ho jaate, par **purane chunk 7 aur
8 wahin pade reh jaate**. Woh ab kisi bhi chunking ka hissa nahi hain, kisi ne unhe banaya nahi —
par search me phir bhi aayenge. **Bhoot data.**

Isliye: **pehle sab uda do, phir sab likho.** Koi bhoot nahi.

##### Step 10 — `qdrant.upsert(points, { wait: true })` · likh do

7 points jaate hain. Har ek me:

```js
{
  id: "a3f2c891-4b7e-...",     // deterministic UUID (lessonId + chunkIndex ka sha1)
  vector: [0.021, -0.117, ...], // 1536 numbers
  payload: {
    text: "...1050 characters...",
    lessonId, courseId, moduleTitle: "Module 4", lessonTitle: "Dynamic Routes",
    startMs: 580, endMs: 90979, cueStart: 0, cueEnd: 15,   // ← clickable timestamp ki jad
    contentHash: "41ef7867...",                             // ← step 4 ke liye
    chunkIndex: 0, chunkCount: 7, indexedAt: "2026-08-01T..."
  }
}
```

**Id deterministic hai** — `sha1(lessonId + "#" + chunkIndex)` se banti hai. Matlab chunk 0 ki id
**hamesha wahi** rahegi. Isliye re-index karne par woh apni jagah par overwrite ho jaata hai,
naya duplicate nahi banta.

#### Ab asli sawaal: `wait: true` kya hai?

Qdrant me by default upsert aisa chalta hai:

```
Aap : "ye 7 points le lo"
Qdrant: "mil gaye ✓"          ← 5 millisecond me jawab
                                 (par abhi disk par likhe nahi hain,
                                  abhi search me dikhte bhi nahi hain)
```

Isko "**acknowledged**" kehte hain — *"maine sun liya, kar dunga."* Courier ko parcel de diya, par
abhi deliver nahi hua.

`wait: true` ke saath:

```
Aap : "ye 7 points le lo, aur jab TAK likh na do tab tak jawab mat dena"
Qdrant: ...disk par likha... ...index update kiya... ...search me daala...
Qdrant: "ho gaya ✓"           ← 50 millisecond me jawab
                                 (ab ye 100% search me milenge)
```

##### Yahan kyun zaroori hai?

Do wajah:

**1. Agla lesson turant hash padhega**

Worker 3 lessons ek saath chalata hai (`INGEST_CONCURRENCY: 3`). Socho ek lesson do baar queue ho
gaya:

```
Job A: upsert kiya, bina wait ke turant return   →  "done!"
Job B: 20ms baad storedHash() padha             →  Qdrant: "kuch nahi mila"
       (kyunki A ka data abhi tak likha hi nahi gaya)
Job B: dobara poora embed kar diya  💸
```

`wait: true` ke saath Job A tab tak "done" bolta hi nahi jab tak data **sach me** wahan na ho.

**2. Script ka "✅ Done" jhoot na ho**

```
✅ Done in 26s
   87 succeeded, 0 failed
```

Ye line dikhne ka matlab hona chahiye ki **ab search kaam karega**. `wait: true` ke bina ye line
aa jaati aur agle 2 second tak `/api/status` "0 indexed" bolta rehta. Confusing.

`deleteLessonPoints()` me bhi `wait: true` hai — isi wajah se. Delete poora hone se pehle upsert
shuru nahi hona chahiye, warna ho sakta hai delete **naye** points ko hi uda de.

**Trade-off:** thoda slow (5ms → 50ms). Par ingest ek baar ka kaam hai aur poora 26 second leta
hai — 45 millisecond kisi ko farak nahi padta. **Bharosa** ke badle me sasta sauda hai.

#### Poori kahani ek line me

```
ingest (waiter)  →  87 parchi Redis par  →  worker (cook) 3 ek saath uthata hai
                                                   ↓
                              har parchi = ek lesson ka poora safar:

    file dhundo → padho → fingerprint → PEHLE SE HAI? → 88 cues → 7 chunks
                                            ↓ haa
                                          ✋ ruk jao ($0)

                              → Qdrant taiyaar → 💰 embed → purana udao
                              → likho aur likhne ka INTZAAR karo (wait: true)
```

**Teen numbers yaad rakho:**

| | |
|---|---|
| **Step 4** | Paisa **bachata** hai (fingerprint same → skip) |
| **Step 8** | Paisa **lagta** hai (sirf yahi ek step) |
| **Step 9** | Bhoot data se **bachata** hai (delete-then-write) |

---

### Chunker — teen stage, thodi detail

[chunker.js](src/chunker.js) is project ka dil hai. Iska kaam: text ko aise todo ki
**timestamp zinda rahe**.

**Stage 1 — cues → sentences** (`cuesToSentences`)

Saare cues ko ek lambi string me jodo, **par saath-saath yaad rakho ki har character kis cue se
aaya**:

```js
function buildSpans(cues) {
  const spans = [];
  let text = "";
  for (let i = 0; i < cues.length; i++) {
    if (text !== "") text += " ";
    const start = text.length;
    text += cues[i].text;
    spans.push({ cue: i, start, end: text.length });   // ← charOffset → cueIndex
  }
  return { text, spans };
}
```

**Yahi woh line hai jis par poora feature khada hai.** Is map ke bina text to milta, par
"kab bola gaya" hamesha ke liye chala jaata.

Phir sentence boundaries dhundo — `isSentenceEnd()` **jaan-boojh kar sakht** hai. Ye sab
sentence-end **nahi** maane jaate:


| Case                        | Kyun bacha                        |
| --------------------------- | --------------------------------- |
| `app.json`, `React.js`      | `.` ke baad whitespace nahi       |
| `3.5`, `v2.0`               | wahi rule                         |
| `etc. We saw`               | `ABBREVIATIONS` set me hai        |
| `J. Doe`                    | ek-akshar wala token = initial    |
| `built with expo. and then` | agla character capital/digit nahi |


Logic: *ek missed boundary se sentence lambi ho jayegi (size cap sambhal lega); ek galat
boundary sentence ko beech se kaat degi — aur wahi cheez rokni hai.*

25% cues me punctuation hoti hi nahi. Un lambi run ke liye `bestForcedCut()` — woh run ke
**pichhle aadhe hisse** me se **sabse lambi khamoshi** wali jagah chunta hai. Matlab cut wahan
lagta hai jahan bolne wale ne saans li, na ki kisi random character count par.

**Stage 2 — pause detect** (`startsNewBlock`)

```js
const gap = cues[s.cueStart].startMs - cues[s.cueStart - 1].endMs;
return gap >= strongPauseMs;   // 1500ms
```

1500ms guess nahi hai — **19,203 asli cues par naapa gaya**:


| Gap         | Kitni baar                                       |
| ----------- | ------------------------------------------------ |
| p50         | 359 ms (normal saans)                            |
| ≥1200ms     | har ~532 chars — bahut zyada                     |
| **≥1500ms** | **har ~871 chars** ← 1200 target ke theek neeche |
| ≥2000ms     | har ~1966 chars — bahut kam                      |


Isliye 1500ms. Zyadatar chunks **asli pause** par band ho paate hain.

**Stage 3 — pack karo** (`chunkSentences`)

```js
if (chars >= targetChars)                     close();  // 1200 — size par ruk jao
else if (chars >= minChars && nextIsPause)    close();  // 600+ aur speaker ruka — behtar seam
else if (chars >= targetChars * 0.75 && nextIsMarker) close();  // 900+ aur "So," / "Now,"
```

Plus `maxChars` (1800) ek hard ceiling hai.

`overlapTail()` — aakhri kuch **poore sentences** (~240 chars) agle chunk ke shuru me repeat ho
jaate hain, taaki boundary par baitha jawab bhi ek hi chunk se mil jaye. Hamesha **kam se kam ek
sentence peeche chhodta hai**, warna chunk poora repeat ho jaata.

Measured result: **1382 chunks, p50 939 chars, max 1550, 98.9% punctuation par khatam,
30% asli pause par, 0 invariant failure.**

### Qdrant me kya jaata hai

Har point:

```js
{
  id: chunkId(lessonId, i),        // deterministic UUID (sha1) — re-index overwrite karta hai
  vector: [ ...1536 numbers ],
  payload: {
    text,                          // asli chunk text

    courseId, lessonId, moduleId,  // kahan se aaya
    moduleTitle, lessonTitle,
    lessonOrder, moduleOrder, kind,

    startMs, endMs,                // ⬅ kab bola gaya
    cueStart, cueEnd,              // ⬅ kaunsi lines

    chunkIndex, chunkCount,
    contentHash,                   // ⬅ skip logic ki jad
    indexedAt08
  }
}
```

`startMs`/`endMs`/`cueStart`/`cueEnd` — **yahi 4 fields poore clickable-timesta**08**mp feature ki
neev hain.**

## Dobara ingest chalane par?

```
$ npm run ingest      # doosri baar
📚 1 course(s), 87 lesson(s) selected
  ████████████████████████████ 87/87  ✓87  1s
✅ Done in 1s
```

87/87 **skipped**, 0 embedded, **$0.00**. Kyun? Step 4 — `contentHash` match ho gaya.

Force chahiye to: `npm run ingest -- --force`.

---

# Flow C — Browser khulta hai (page load)

```
index.html
  └─ web/src/main.jsx
       ├─ import "./styles/tokens.css"     ← design tokens + CSS reset
       └─ createRoot().render(<App />)
```

`App.jsx` mount hote hi teen hooks chalte hain:

```
useCatalog()        useConversation()      useTranscript()
     │                    │                      │
     │                (khali — kuch          (khali — koi
     │                 nahi karta jab         lesson khula
     │                 tak aap pucho          nahi)
     │                 nahi)
     ▼
GET /api/courses
     ▼
courseId settle karo:
  - localStorage me "cue.activeCourseId" hai aur woh course abhi bhi exist karta hai? → wahi
  - "all" tha aur 1 se zyada course hai? → "all"
  - warna → pehla course
     ▼
GET /api/catalog?courseId=...      GET /api/status?courseId=...
     │                                    │
     ▼                                    ▼
modules[] → ModuleRail render       lessons{} → indexed dots
                                    reachable:false → rail footer warning
```

### Backend side


| Request        | Kaun handle karta hai                           | Qdrant chahiye? |
| -------------- | ----------------------------------------------- | --------------- |
| `/api/courses` | `catalog.js → listCourses()`                    | ❌               |
| `/api/catalog` | `catalog.js → getCatalog()`                     | ❌               |
| `/api/status`  | `status.js → getStatus() + getLessonIndexMap()` | ✅               |


**Catalog aur status alag endpoint hain — jaan-boojh kar.** Tree filesystem se aata hai aur
hamesha available hai; status ko Qdrant chahiye. Qdrant band ho to sirf **dots** jaate hain,
**rail nahi**. `status.js` `ECONNREFUSED` pakad kar ye lautata hai:

```js
{ reachable: false, message: "Can't reach Qdrant at http://127.0.0.1:6333. Start it with: npm run services:up" }
```

Rail footer wahi message dikha deta hai. **Error ki jagah agla step.**

### `useCatalog` ke chhote fayde

```js
function readStoredCourse() {
  try { return localStorage.getItem(STORAGE_KEY) ?? null; }
  catch { return null; }   // private mode / blocked storage — bas yaad mat rakho
}
```

Aur ek subtle guard:

```js
// Yaad rakha hua course ab exist nahi karta? UI ko fansne mat do.
if (current && list.some((c) => c.id === current)) return current;
return list[0]?.id ?? null;
```

### Composer kab block hota hai

`App.jsx`:

```js
const nothingIndexed = status?.reachable !== false && status?.indexedLessons === 0;
const blockedReason =
  status?.reachable === false ? status.message
  : nothingIndexed ? "Nothing is indexed yet — run `npm run ingest` to enable answering."
  : null;
```

Sirf **composer** block hota hai. Rail aur transcript pane chalte rehte hain — kyunki woh
Qdrant par depend hi nahi karte.

---

# Flow D — Sawaal puchna (asli pipeline)

Ye sabse bada flow hai. Do hisse: **browser side** aur **server side**.

## D1 — Browser: sawaal bhejna aur poll karna

```
Composer.jsx
  Enter dabaya (Shift+Enter = nayi line)
      ↓ onSubmit(text)
App.jsx → askScoped(question)
      ↓ courseId attach karta hai ("all" ho to undefined bhejta hai)
useConversation.ask(question, { courseId, courseTitle })
      │
      ├─ inFlight guard — ek waqt me ek hi sawaal
      ├─ turn push: { id, question, phase: "queued", courseId, courseTitle }
      │     ⬆ courseTitle turn par SAVE hota hai, isliye baad me course switch
      │       karne par purana jawab naye course ka nahi dikhta
      ├─ setBusy(true)
      │
      ├─ askQuestion(text, courseId)     api/client.js
      │     POST /api/query  →  202 { jobId, poll }
      │
      └─ pollJob("query", jobId, { onState })
            delay: 400ms → ×1.4 har baar → max 2500ms, overall timeout 120s
            onState → phase: "active" ? "thinking" : "queued"
                      (UI me "Queued…" / "Searching the transcripts…")
```

Poll strategy ka logic: garam worker 2-3 second me jawab de deta hai, isliye pehle **tez**
poll karo; lekin slow job ke liye 400ms par sau requests bekaar hain, isliye dheere-dheere
**backoff** karo.

Har request abortable hai:

```js
function withTimeout(signal, ms) {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
```

Matlab **Stop** button ya component unmount — dono turant request cancel kar dete hain.

## D2 — API server: bas ek gatekeeper

[index.js](src/index.js) `POST /api/query`:

```
1. query string hai? khali to nahi? → 400
2. length ≤ MAX_QUERY_CHARS (2000)?  → 400
3. resolveCourseId(courseId)
     - undefined/""/"all"  → undefined (sab courses)
     - known id            → wahi id
     - unknown id          → 400 "Unknown courseId: xyz"
       ⬆ ye important hai: bina check ke ye seedha Qdrant filter me chala jaata
4. enqueueQueryJob({ query, courseId })
5. res.status(202).json({ jobId, poll })Producer side — scripts/ingest-course.js
1. parseArgs()          --course= --module= --force --list --help
2. getCourses()         catalog.js — disk scan (ya cache)
3. filter               course/module ke hisaab se
4. guard                courses 0? → exit 1
                        koi lesson match nahi? → exit 1
                        OPENAI_API_KEY nahi? → exit 1  (paisa lagne se pehle)
5. queue clean          pichle run ke completed/failed hataao,
                        taaki progress bar 0 se shuru ho
6. loop → enqueueIndexingJob({ lessonId, title, force })
7. watchProgress()      har 500ms counters poll karo, bar draw karo
8. drain → summary → exit 0
watchProgress() me ek chhoti si samajhdari hai: agar 10 second tak kuch complete nahi hua
aur kuch active bhi nahi hai, to woh ye print karta hai —

⚠️  Nothing is being processed. Is the worker running?
   Start it in another terminal:  npm run worker
Ye sabse common galti hai, isliye script khud pakad leti hai.

Script producer hai, worker nahi. Beech me Ctrl+C maar do — worker chalta rahega, aur
dobara npm run ingest chalane par jo ho chuka hai woh skip ho jayega.

Job ka id — duplicate se bachav
queue.js:

jobId: `lesson:${payload.lessonId}${payload.force ? ":force" : ""}`
Job id lesson se banta hai. Isliye do baar ingest chalane par BullMQ duplicate job ignore kar
deta hai (jab tak purani job retained hai).

Retry policy: attempts: 4, exponential backoff 3s se — kyunki OpenAI ka embedding
per-minute rate limit hai, aur wahi sabse aam temporary failure hai.

Consumer side — src/indexer.js
Yahan asli kaam hota hai. Har lesson ke liye:

indexLesson({ lessonId, force })
│
├─ 1. findLesson(lessonId)              catalog.js
│      └─ trusted Map lookup — client string kabhi path me join nahi hoti
│      └─ nahi mila? → UnprocessableLessonError (retry pointless)
│
├─ 2. fs.readFile(lesson.filePath)      raw .srt text
│
├─ 3. sha256(raw) → contentHash
│
├─ 4. storedHash(lessonId)              Qdrant scroll, limit 1, sirf contentHash payload
│      └─ same hash aur !force? → { skipped: true }  ✋ YAHIN RUK JAO
│         (0 embedding, ₹0 kharcha)
│
├─ 5. parseSubtitles(raw)               subtitles.js → cues
│      └─ 0 cues? → UnprocessableLessonError
│
├─ 6. chunkCues(cues)                   chunker.js → 3 stages
│      └─ 0 chunks? → UnprocessableLessonError
│
├─ 7. ensureCollection()                qdrant.js
│      └─ collection banao (agar nahi hai)
│      └─ payload index banao: courseId, lessonId, moduleId
│         (dobara banane par server-side no-op — safe)
│
├─ 8. embedTexts(chunks.map(c => c.text))    openai.js, 100 ka batch
│
├─ 9. deleteLessonPoints(lessonId)      purane points hatao
│      └─ merge NAHI karte: chunker badla to boundaries shift ho jaate hain,
│         aur purane points chupke se pade reh jaate
│
└─ 10. qdrant.upsert(points)            wait: true
```

Bas. **Server ne abhi tak koi LLM call nahi ki, koi search nahi ki.**

## D3 — Worker: `handleQuery` → [pipeline.js](src/pipeline.js)

Ye poore project ka traffic controller hai. **32 lines, aur pura routing logic ek jagah:**

```
handleQuery(rawQuery, { courseId })
│
├── STEP 1 — maskPII(rawQuery)                    guardrails.js
│              pure regex, 0 LLM call, ~1ms
│
├── STEP 2 — classifyQuery(query)                 router.js
│              1 LLM call → { allowed, reason, intent }
│
├── allowed === false ────────────► kind: "blocked"    ✋ aur kuch nahi chalta
│                                    answer = reason
│
├── intent === "metadata" ───────► kind: "metadata"
│                                    catalog-answer.js  (0 vector search)
│
└── warna ──────────────────────► kind: "content"
                                     retriever.js  (poori RAG pipeline)
```

### STEP 1 — PII masking ([guardrails.js](src/guardrails.js))

Ek rules array, har rule me ek global regex aur optional `validate` callback.

**Yahan asli risk false positive hai, false negative nahi.** Kyun? Kyunki ye app poori tarah
un cheezon se bani hai jo PII jaisi dikhti hain:


| Pattern           | Mask hua to kya toota                           |
| ----------------- | ----------------------------------------------- |
| `00:00:06,420`    | **Poora project** — timestamp hi to feature hai |
| `#c3f53c`         | Theme ka color                                  |
| `8081`, `0.0.0.0` | Port/IP — course me code padhaya jaata hai      |
| `1.2.3`           | Version number                                  |


Ye chaaron **pinned negative tests** hain. Phone regex dekho:

```js
pattern: /(?<![\d.:,\-])\+?\d[\d ()-]{7,18}\d(?![\d])(?![.:,\-]\d)/g,
validate: (match) => {
  const digits = match.replace(/\D/g, "");
  return match.trimStart().startsWith("+")
    ? digits.length >= 10 && digits.length <= 15   // country code ke saath
    : digits.length === 10;                        // bina code — exactly 10
},
```

Do trick:

- **Separator class me `:` `,` `.` nahi hain.** Isliye `00:00:06,420` ke chhote digit groups
ek phone-length run me jud hi nahi sakte.
- **Trailing guard `.` `:` `,` `-` ko sirf tab reject karta hai jab uske baad DIGIT ho.**
Isliye `"call 9876543210."` mask hota hai, par `1.2.3` nahi.
*(Ye doosra wala guard **live run me** pakda gaya tha — test me dono taraf space tha.)*

Output: `{ text, found: [{type, count}] }` → UI me amber notice
*"1 secret masked before sending (1 API key)"*.

### STEP 2 — Gate + Router ek hi call me ([router.js](src/router.js))

Ye design ka sabse acha decision hai. Do alag features — "off-topic block karo" aur
"catalog sawaal ko alag route karo" — **agar alag-alag banate to 2 extra LLM call lagte**.
Saath jodne par **ek**:

```js
const SCHEMA = {
  allowed: { type: "boolean", ... },
  reason:  { type: "string",  ... },
  intent:  { type: "string", enum: ["content", "metadata"] },
};
```

Gate ka **sirf ek kaam**: mausam, politics, "poem likho" reject karna.

Uska kaam **NAHI**: *"React Native me useState kaise use karte hain"* ko reject karna sirf
isliye ki shayad course me cover nahi hai. Woh **answer step** ka kaam hai — woh khud bolega
"course me cover nahi hua". Isliye prompt me saaf likha hai:

> *"Rejecting a real development question is a worse failure than letting through one the
> course does not answer."*

Aur **fail-open**:

```js
export function normaliseClassification(raw) {
  const allowed = raw?.allowed !== false;        // sirf explicit false block karta hai
  const intent = raw?.intent === "metadata" ? "metadata" : "content";
  ...
}
```

Kuch bhi ajeeb aaya → content path. Kyunki galti se allow hua sawaal ko bas ek grounded jawab
ya imaandar "not covered" milta hai; galti se block hua sawaal **dead end** hai.

`normaliseClassification` alag export hai taaki routing rules **bina API key ke** test ho sakein.

### STEP 3a — Blocked path

```js
return { kind: "blocked", query, masked, answer: reason, citations: [] };
```

Bas. 1 LLM call, 0 embedding, 0 search. UI me "Out of scope" badge wala card, aur
**koi retrieval trace nahi** — kyunki retrieval hua hi nahi.

### STEP 3b — Metadata path ([catalog-answer.js](src/catalog-answer.js))

Sawaal jaise *"module 5 me kitne lessons hain?"*, *"navigation kaunse module me hai?"*,
*"sabse lambi lecture kaunsi?"*

Pehle ye sawaal vector search se jaate the — **slow bhi the aur galat bhi**, kyunki transcripts
me syllabus likha hi nahi hota. Ab:

```
answerFromCatalog(query, courseId, { indexedLessonIds })
│
├─ renderSyllabus(courseId)      catalog.js — plain text syllabus (~1200 tokens)
│    COURSE: Expo Mastery (87 lessons)
│      Module 1 — 6 lesson(s)
│        1. What Is Mobile Development (12 min)
│        ...
│
├─ indexingNote                   "INDEXING STATUS: 87 of 87 lessons have been indexed"
│    ⬆ isi se "kitne lessons indexed hain?" ka SAHI jawab aata hai
│
├─ chatJSON({ answer, lessonTitles })    1 LLM call
│
└─ resolveLessonTitles()          model ke titles → asli lesson citations
     exact match → phir loose match (lowercase, non-alnum hatao)
     na mile → DROP kar do (galat lesson par bhejne se behtar hai koi link na ho)
```

Mini query-language likhne ki zarurat hi nahi padi — poora syllabus prompt me daal diya.
~1200 tokens ≈ $0.0002. Isse har phrasing apne aap chal jaati hai bina question types
gine.

**Ek chhoti si baat:** ye path vector search nahi karta, par `getIndexedLessonIds()` ke liye
Qdrant ko **ek halka scroll** karta hai. Woh fail ho jaye to `.catch(() => null)` se chup-chaap
skip ho jaata hai — sirf "kitne indexed hain" wala hissa gayab hota hai, jawab nahi.

Citations me `startMs: 0` aur `pinpointMs: 0` hote hain — syllabus jawab ke paas koi quoted
moment hota hi nahi, to lesson top se khulta hai. Chip bhi alag dikhta hai (`timeless` mode:
timecode ki jagah arrow).

### STEP 3c — Content path ([retriever.js](src/retriever.js))

Yahi asli RAG hai.

```
answerQuery(query, { courseId })
│
├─ retrieveChunks(query, { courseId })
│  │
│  ├─ Promise.all([ queryRewriting(query), hydeDocument(query) ])   ← PARALLEL, 2 LLM calls
│  │
│  │     queryRewriting → { rewritten, stepBack, isCompound, subQuery }
│  │     hydeDocument   → ek nakli transcript paragraph
│  │
│  ├─ labelled variants banao:
│  │     rewritten  ← saaf, explicit, English me
│  │     stepBack   ← ek broader background sawaal
│  │     hyde       ← "jo instructor ne shayad kaha hoga"
│  │     subQuery1  ← SIRF agar isCompound === true
│  │     → total 3 ya 4
│  │
│  ├─ embedTexts(variants)              1 batched OpenAI call
│  ├─ courseFilter(courseId)            qdrant.js → { must: [{ key: "courseId", ... }] }
│  ├─ Promise.all(searchByVector × N)   3-4 parallel Qdrant search, topK=6 har ek
│  │
│  └─ reciprocalRankFusion(rankedLists)
│        score = Σ 1 / (60 + rank)
│        → top 6 (finalK)
│
├─ chunks.length === 0? → "kuch nahi mila, `npm run ingest` chalao" (0 aur LLM call)
│
├─ context banao:  "[1] Module 4 — Dynamic Routes\n<chunk text>\n\n[2] ..."
│
├─ chatJSON(ANSWER_SCHEMA)              1 LLM call
│     → { answer, covered, citations: [{ excerpt, quote }] }
│
└─ buildCitations(result.citations, chunks)
     har citation ke liye:
       getCues(lessonId)          transcript.js — CACHED disk read, network nahi
       pinpointSentence(quote, cues, chunk)
       → { n, lessonId, courseId, moduleTitle, lessonTitle, kind,
           startMs, endMs, cueStart, cueEnd,        ← range (wash ke liye)
           pinpointMs, cueIndex, quote, exactQuote, ← ek line (playhead ke liye)
           score, rrfScore, matchedBy }
```

#### Conditional decomposition — kyun?

Pehle hamesha 3 sub-queries bante the. Matlab zyadatar sawaal **teen baar ek hi cheez ke liye**
search hote the, aur fusion me near-duplicate rankings bhar jaate the.

Ab schema me ek `isCompound` boolean hai:

```js
isCompound: {
  description: "True only when the question genuinely asks about two or more separate topics
                that would live in different parts of a course. Several clauses about one
                topic is NOT compound.",
}
```

Aur ek defensive guard, agar model `false` bole par `subQuery` bhar de:

```js
subQueries: isCompound && subQuery !== "" ? [subQuery] : [],
```

**Cost: zero extra** (wahi ek call, bas ek field zyada), aur embeddings 6 se ghat kar 3-4.

#### HyDE ka prompt kyun badla

Pehle prompt kehta tha *"encyclopedic reference document"*. Par corpus **boli hui video
transcripts** hai. Encyclopedic prose embedding space ke bilkul alag hisse me land karta hai —
isliye HyDE practically bekaar tha.

Ab:

> *"write 3-5 sentences of what the instructor most likely SAID while teaching that topic, as it
> would appear in an auto-generated subtitle file: first person, conversational, present tense…
> Use the spoken register — 'so', 'let's', 'right now', 'you can see here'"*

Ek line ka change, aur HyDE ab actually kaam karta hai.

#### RRF — Reciprocal Rank Fusion

```js
const contribution = 1 / (k + i + 1);   // k = 60, i = 0-based rank
```

Jo chunk **ek se zyada variant** ko mila, woh upar chadh jaata hai. Yahi signal chahiye:
alag-alag tarah se pooche gaye sawaalon ke beech **sehmati**.

`matchedBy` array me labels jama hote rehte hain — UI ke trace panel me wahi tags dikhte hain.

#### `pinpointSentence()` — 90 second se ek line tak

Chunk ~60-90 second ka hota hai. Us par click karne ka matlab hai "kahin is ek minute me". Bekaar.

```js
export function pinpointSentence(quote, cues, chunk) {
  const window = cues.slice(chunk.cueStart, chunk.cueEnd + 1);   // sirf is chunk ka hissa
  const sentences = cuesToSentences(window);                     // WAHI splitter jo chunker ne use kiya
  // har sentence ka token-overlap score nikalo
  if (!best || bestScore < 0.45) return fallback;                // PINPOINT_THRESHOLD
  const cueIndex = chunk.cueStart + best.cueStart;               // window-relative → absolute
  return { startMs: cues[cueIndex].startMs, cueIndex, text: best.text, exact: bestScore >= 0.9 };
}
```

Teen baatein:

1. **Wahi `cuesToSentences` dobara chalta hai** — isliye model ne jo quote chunk se uthaya, woh
  sentence se line-up ho jaata hai.
2. **Koi extra LLM call nahi.** Deterministic, free, ~0ms.
3. **Fallback safe hai** — quote na mile to chunk ka apna `startMs`. Coarse, par galat nahi.

Isiliye answer prompt me itni sakhti se likha hai:

> *"quote one sentence VERBATIM from it. Those quotes are matched back against the transcript to
> locate the exact second the instructor said it, so an invented or paraphrased quote breaks the
> link the student clicks on."*

#### Answer prompt ke 6 rules

| Rule | Kyun |
|---|---|
| Sirf excerpts se jawab do, warna `covered: false` | Hallucination band |
| ASR errors charitably padho (`"some while development"` = `"so, mobile development"`) | Transcripts auto-generated hain |
| **User ki bhasha mirror karo** | Hinglish sawaal → Hinglish jawab |
| Seedha aur kaam ka jawab — jawab pehle, tafseel baad me, padding nahi | "Great question! Let me explain…" kisi ke kaam ka nahi |
| Prose only — "(Excerpt 3)" mat likho, quotes paste mat karo | Citations alag render hote hain; inline repeat = noise |
| Har claim ke liye VERBATIM quote | Pinpoint isi par chalta hai |

*(Paanchwa rule live run ke baad add hua tha — model ne "(Excerpt 3)" paste kar diya tha.)*

---

### 🎓 Samajhne ke liye — "excerpt" aur "verbatim" ka matlab kya hai

*Ye section poori tarah aasan bhasha me hai. Upar wale 6 rules me do shabd baar-baar aate hain —
**excerpt** aur **verbatim**. Dono ka matlab yahan zero se samjhaya gaya hai.*

#### 1. "Excerpt" kya hai?

Excerpt = **woh transcript ka tukda jo model ko diya jaata hai**, ek number ke saath.

Retrieval ke baad 6 chunks bachte hain. Unko `answerQuery()` aise jodta hai
([retriever.js:377](src/retriever.js#L377)):

```js
const context = chunks
  .map((chunk, i) => `[${i + 1}] ${p.moduleTitle} — ${p.lessonTitle}\n${p.text}`)
  .join("\n\n");
```

To model ko **exactly ye string** milti hai:

```
TRANSCRIPT EXCERPTS:

[1] Module 4 — Dynamic Routes
We can say post1.tsx exactly post2.tsx, post3.tsx and in future let's say you
have millions of posts then is this feasible to create post1 to post1 million.tsx?
No. This is where the use of dynamic routes come. Perfect, so how this actually
work? ... So, this post ID is a dynamic route.

[2] Module 3 — File Based Routing Basics
...poora chunk text...

[3] Module 4 — Dynamic Routes
...poora chunk text...

... [4] [5] [6] ...

QUESTION: dynamic routes kaise banate hain?
```

**Bas itna hi.** Model ke paas na poora course hai, na Google — sirf ye 6 tukde.

> **Excerpt 3** = "teesra tukda"
> Number sirf isliye hai taaki model bata sake ki uska jawab **kis tukde se** aaya. Ek pehchaan tag.

#### 2. Model wapas kya bhejta hai

Model prose nahi likhta — woh ek **fixed shape** bharta hai
([ANSWER_SCHEMA](src/retriever.js#L291)):

```json
{
  "answer": "Dynamic route banane ke liye folder ya file ka naam square brackets me likhte hain...",
  "covered": true,
  "citations": [
    { "excerpt": 1, "quote": "This is where the use of dynamic routes come." },
    { "excerpt": 3, "quote": "So, this post ID is a dynamic route." }
  ]
}
```

Do alag cheezein hain yahan, aur yahi sabse zaroori baat hai:

| Field | Kaun padhta hai | Kaam |
|---|---|---|
| `answer` | **User** | Screen par dikhta hai |
| `citations[].quote` | **Code** | User ko kabhi dikhta hi nahi — ye machine ke liye hai |

`quote` ek **jawab nahi**, ek **address** hai.

#### 3. "Verbatim" kya hai?

Verbatim = **shabd-ba-shabd, hu-ba-hu copy**. Ek akshar bhi apna nahi.

```
Excerpt me likha hai:
  "This is where the use of dynamic routes come."

✅ VERBATIM     : "This is where the use of dynamic routes come."
                   (copy-paste, jaisa hai waisa)

❌ PARAPHRASE   : "Dynamic routes are used when you have many posts."
                   (matlab wahi hai, shabd apne)

❌ SUDHAR DIYA  : "This is where the use of dynamic routes comes."
                   (grammar theek kar di — 'come' → 'comes')
```

Teeno ka **matlab** ek hai. Par code ke liye teeno **bilkul alag** hain.

#### 4. Verbatim itna zaroori kyun — asli demo

Maine abhi chalake dekha, asli lesson par. Ek chunk liya jo **71 second** lamba hai (01:10 se
02:21), aur usi ke saath alag-alag quotes try kiye:

```
chunk ka window : 01:10 → 02:21   (71 sec)

QUOTE KAISI THI                 KAHAN LE GAYA    KYA HUA
─────────────────────────────────────────────────────────────
✅ VERBATIM (exact copy)     →    01:27          MILA, exact
✅ VERBATIM (doosra sentence)→    02:18          MILA, exact
🟡 1 shabd badla ("comes")   →    01:27          MILA, par exact nahi
❌ PARAPHRASE                →    01:10          FALLBACK
❌ BILKUL BANAYA HUA         →    01:10          FALLBACK
```

**Dekho kya farak pada:**

- Verbatim quote → **01:27** par le gaya. Theek us line par jahan instructor ne woh bola.
- Paraphrase → **01:10** par gira, yaani chunk ki **shuruaat**. 17 second peeche. Galat nahi —
  bas user ko ab khud dhoondhna padega.
- Doosri verbatim quote **02:18** par le gayi — usi chunk ke **68 second baad**. Ek hi chunk se
  do bilkul alag jagah.

Ye jaadu nahi hai. `pinpointSentence()` bas token overlap ginta hai:

```js
const PINPOINT_THRESHOLD = 0.45;   // quote ke 45% shabd sentence me milne chahiye

if (!best || bestScore < PINPOINT_THRESHOLD) return fallback;  // ← paraphrase yahin girta hai
```

**Paraphrase me shabd hi badal jaate hain, isliye overlap 45% se neeche chala jaata hai, aur
match fail ho jaata hai.**

Isliye prompt me itni sakhti hai:

> *"an invented or paraphrased quote **breaks the link the student clicks on**"*

Ek line me: **quote model ka jawab nahi hai — quote woh chaabi hai jisse code timestamp
dhoondhta hai.**

#### 5. Ab poore rules, ek-ek karke

##### Rule 1 — "Sirf excerpts se jawab do"

> *"Ground everything in the excerpts. If they don't contain the answer, set `covered` to
> false... **Never fill the gap from outside knowledge.**"*

Model ko React Native pehle se aata hai. Par woh yahan **nahi** chahiye — user ne **is course**
se pucha hai. Agar excerpts me jawab nahi hai to model ko `covered: false` set karna hai aur saaf
bolna hai *"ye course me cover nahi hua"*.

**Kyun:** apne gyaan se bhar dega to user ko lagega ye course me hai. Woh dhoondhne jayega —
aur milega hi nahi.

##### Rule 2 — "ASR errors charitably padho"

> *"expect mangled words... (`"some while development"` is `"so, mobile development"`;
> `"dot tsx"` is `".tsx"`)"*

Subtitles **machine ne** banaye hain, insaan ne nahi. Upar wale asli chunk me hi dekho:

```
"Perfect, so how this actually work?"          ← "does this actually work"
"This is going to be basically work..."        ← toota hua grammar
"explore outer automatically treat"            ← "Expo Router automatically treats"
```

Model ko **matlab** samajhna hai, spelling par nahi atakna. "explore outer" = "Expo Router".

##### Rule 3 — "User ki bhasha mirror karo"

Hinglish sawaal → Hinglish jawab. English → English. **Kabhi bhasha mat badlo.**

Chhota lagta hai, par bahut bada farak padta hai. Aapne Hinglish me pucha aur formal English ka
paragraph mila — turant lagta hai ki samne wala aapki baat samjha hi nahi.

##### Rule 4 — "Seedha aur kaam ka jawab do"

> *"Lead with the answer, then the detail. Short markdown — a few sentences, a list only if there
> are real steps. **Don't pad.**"*

Jawab pehle, tafseel baad me. "Great question! Let me explain..." wala bhashan nahi.

##### Rule 5 — "Prose only — excerpt number mat likho"

> *"Do NOT mention excerpt numbers, do not write `"(Excerpt 3)"`, and do not paste quotes into
> the answer text."*

**Ye rule live run ke baad add hua tha.** Model ne asli me aisa jawab bheja:

```
❌ Dynamic route banane ke liye square brackets use karte hain (Excerpt 3).
   "So, this post ID is a dynamic route" (Excerpt 1) — matlab...
```

Problem: user ko "(Excerpt 3)" ka koi matlab nahi. Woh number sirf prompt ke andar ki cheez thi.
Aur quote already **neeche chip me** dikh raha hai — upar dobara likhna sirf shor hai.

```
✅ Dynamic route banane ke liye folder ya file ka naam square brackets me
   likhte hain, jaise [postId].tsx. Expo Router us bracket wale hisse ko
   ek variable maan leta hai.

   WHERE THIS COMES FROM
   [1] Module 4 · Dynamic Routes  ────●──  01:27
   [2] Module 4 · Dynamic Routes  ──────●  02:18
```

**Jawab upar, sources neeche.** Do alag cheezein, do alag jagah.

##### Rule 6 — "Har claim ke liye VERBATIM quote"

Ab ye poori tarah saaf hona chahiye. Model ko har citation ke saath ek sentence **hu-ba-hu copy**
karna hai — kyunki wahi sentence code ko timestamp tak le jaata hai.

```
model ka quote  →  pinpointSentence()  →  cue 14  →  01:27  →  chip par likha number
                                                            →  click par wahi line highlight
```

**Quote galat = chain toot gayi = timestamp 71 second ke window ki shuruaat par gir gaya.**

## D4 — Result wapas browser tak

```
worker → job return value → BullMQ → Redis (1 ghante tak retained)
                                        ▼
              browser ka agla poll: GET /api/query/:id → { status: "completed", result }
                                        ▼
              useConversation patch(id, { phase: "done", kind, answer, citations, chunks, ... })
                                        ▼
              Conversation.jsx → Turn → Answer
```

`Conversation.jsx` `kind` dekh kar teen alag cheezein render karta hai:


| `kind`     | Kya dikhta hai                                                                      |
| ---------- | ----------------------------------------------------------------------------------- |
| `blocked`  | "Out of scope" badge + polite line. Koi citations, koi trace nahi                   |
| `metadata` | "Catalog" badge + lesson chips (`timeless`). **Trace nahi** — retrieval hua hi nahi |
| `content`  | "Transcript" badge + timestamped chips + **RetrievalTrace**                         |


Plus jo har turn par common hai:

- `masked` ho to amber notice
- `covered === false` ho to "not covered" tag
- `elapsedMs` mono font me

Ek chhoti si baat jo aasani se chhoot jaati hai:

```js
question: result.query ?? text,
```

Backend ne agar question redact kiya (PII mask), to UI **wahi dikhata hai jo backend ne actually
dekha** — na ki jo aapne type kiya tha. Imaandari.

---

# Flow E — Citation click → transcript highlight

Yahi woh feature hai jiske liye ye poora project bana hai.

```
CitationChip.jsx
   <button onClick={() => onJump(citation)}>
   aria-label="Jump to Module 4, Dynamic Routes at 04:22"
        │
        ▼
App.jsx → jumpTo(citation)
        │
        ├─ openTranscript(citation.lessonId, {
        │      cueIndex: citation.cueIndex,      ← ek line (playhead)
        │      cueStart: citation.cueStart,      ← range shuru (wash)
        │      cueEnd:   citation.cueEnd,        ← range khatam
        │      ms:       citation.pinpointMs
        │  })
        ├─ setPaneOpen(true)
        └─ history.replaceState(null, "", `#/lesson/<id>?t=<ms>&c=<cue>`)
              ⬆ replaceState, pushState nahi — back button app se BAHAR le jaye,
                har click ke through wapas na chale
        │
        ▼
useTranscript.open(id, aim)
        │
        ├─ setTarget({ cueIndex, cueStart, cueEnd, ms, nonce })
        │     ⬆ FETCH SE PEHLE set hota hai — taaki cached transcript
        │       render hote hi highlight ready ho
        │     ⬆ nonce har click par badalta hai — isliye WAHI citation dobara
        │       click karne par bhi scroll phir se hota hai
        │
        ├─ cache.current.get(id) hai? → turant setData, koi fetch nahi
        │
        └─ warna: purani request abort karo → GET /api/lessons/:id/transcript
```

### Server side — [transcript.js](src/transcript.js)

```
getTranscript(lessonId)
│
├─ findLesson(lessonId)         catalog.js ka Map lookup
│    └─ null? → route 404 return karta hai
│
├─ readCache(lessonId)          LRU, max 24 lessons
│    delete + re-insert = recency refresh
│
├─ miss? → readSubtitleFile(lesson.filePath)   subtitles.js
│
└─ { lesson: {...meta}, cues: [...] }
```

**Ye path na Qdrant chhuta hai na OpenAI.** Isliye teen me se do pane bina API key ke poore
kaam karte hain.

### Security — path traversal structurally impossible

```js
// catalog.js
const byId = new Map(lessons.map((l) => [l.id, l]));
```

Client ki di hui `lessonId` **kabhi path me join nahi hoti**. Woh sirf ek Map ki key hai.
`%2e%2e%2f` bhejo, `../../etc/passwd` bhejo — Map me key nahi milegi, 404 aayega.
Ye "filter karke rok raha hoon" nahi hai, ye "aisa ho hi nahi sakta" hai.

### Render — [TranscriptPane.jsx](web/src/components/TranscriptPane.jsx)

Har cue ek row:

```jsx
const isPlayhead = cue.index === cueIndex;
const inRange = rangeStart !== null && cue.index >= rangeStart && cue.index <= rangeEnd;
```


| Class      | Matlab                                                               |
| ---------- | -------------------------------------------------------------------- |
| `inRange`  | Chunk ka poora span — halka lime wash                                |
| `playhead` | Woh ek line jo model ne quote ki — solid lime border + ek baar pulse |


Phir scroll:

```js
useLayoutEffect(() => {
  const rowBox = row.getBoundingClientRect();
  const scrollerBox = scroller.getBoundingClientRect();
  const delta = rowBox.top - scrollerBox.top - (scrollerBox.height - rowBox.height) / 2;

  scroller.scrollTo({ top: scroller.scrollTop + delta, behavior: "smooth" });
  row.focus({ preventScroll: true });
}, [cueIndex, cues.length, target?.nonce]);
```

Char detail, chaaron kisi na kisi bug se aayi hain:

1. `**useLayoutEffect`, `useEffect` nahi** — paint se pehle chale, warna pane ek frame ke liye
  top par flash karta hai.
2. `**scrollIntoView` jaan-boojh kar NAHI.** Woh **har scrollable ancestor** ko scroll karta hai —
  isse poora page 70px neeche khisak gaya tha aur header clip ho gaya tha. Sirf **ek**
   container ka `scrollTop` badalna chahiye.
3. `**focus({ preventScroll: true })`** — warna focus abhi kiya hua positioning undo kar deta hai.
  Focus isliye zaroori hai ki keyboard user bhi wahin land kare (`tabIndex={-1}`).
4. `**target?.nonce` dependency me** — wahi citation dobara click karne par bhi effect chale.

Aur screen reader ke liye:

```jsx
<p className="srOnly" role="status" aria-live="polite">{announcement}</p>
// "Jumped to 04:22 in Dynamic Routes"
```

> **Bonus bug jo isi pane se nikla tha:** `.playhead .time::after` ek absolutely-positioned
> pseudo-element tha **bina kisi positioned ancestor ke**. Woh `.shell` tak escape kar gaya aur
> `scrollHeight` 900 se 1904 kar diya. Fix: `.time` par `position: relative` + `.shell` par
> `overflow: clip`. (`clip` — `hidden` nahi — kyunki `clip` scroll container banata hi nahi.)

---

### 🎓 Samajhne ke liye — citation kya hai, aur click par kya hota hai

*Upar ka flow ek nazar me dekhne ke liye hai. Agar "citation ka matlab kya hai", ya `nonce` /
`replaceState` / `useLayoutEffect` / `overflow: clip` jaisi ajeeb lines samajh nahi aayin — ye
section bilkul zero se samjhata hai. Numbers asli hain, ek asli citation par chalake nikale gaye.*

#### 1. "Citation" ka matlab kya hai?

Citation = **"ye baat maine kahan se li"** ka proof.

School wali kitab me footnote dekha hai? Neeche chhote akshar me likha hota hai
*"— Sharma, 2019, page 47"*. Woh citation hai. Lekhak keh raha hai: *"mera bharosa mat karo, khud
jaake page 47 par dekh lo."*

Is app me bilkul wahi hai — bas footnote ki jagah **clickable chip**:

```
Dynamic route banane ke liye folder ya file ka naam square brackets me
likhte hain, jaise [postId].tsx.

WHERE THIS COMES FROM
┌────────────────────────────────────────────────────────┐
│ 1   Module 4                                           │
│     Dynamic Routes            ──────●────────  01:27   │  ← YE CITATION HAI
└────────────────────────────────────────────────────────┘
```

Ye chip keh raha hai:

> *"Upar wala jawab maine banaya nahi. Instructor ne khud ye baat **Module 4, Dynamic Routes**
> lesson me, **1 minute 27 second** par boli thi. Yakeen nahi? **Click karo.**"*

Aur click karte hi teesra panel khulta hai, us line par pahunch jaata hai, aur woh line
**highlight** ho jaati hai.

> **Bina citation ke ye app bekaar hota.** Koi bhi chatbot "dynamic routes aise banate hain" bol
> sakta hai. Farak sirf itna hai ki ye bata sakta hai **kahan se**, aur aapko wahan **le bhi jaa
> sakta hai**.

#### 2. Citation ke andar kya hota hai

Ye asli citation hai, maine abhi chalake nikala:

```json
{
  "n": 1,
  "lessonId": "expo-mastery:module-4--3-dynamic-routes",
  "moduleTitle": "Module 4",
  "lessonTitle": "Dynamic Routes",

  "startMs":  70200,    "cueStart": 12,      ← chunk ka POORA range
  "endMs":   141300,    "cueEnd":   27,

  "pinpointMs": 87500,  "cueIndex": 14,      ← EK line

  "quote": "No. This is where the use of dynamic routes come.",
  "exactQuote": true
}
```

Dekho **do alag jodi** hain. Yahi poore highlight ka raaz hai:

| Jodi | Kya batati hai | Kaam |
|---|---|---|
| `cueStart` + `cueEnd` = **12-27** | Poora chunk — **16 lines**, 01:10 se 02:21 | Halka wash |
| `cueIndex` = **14** | Woh **ek** line jo model ne quote ki | Solid playhead |

**Dono kyun chahiye?**

Kyunki jawab ek **90-second ke tukde** se aaya (woh poora context tha jo model ne padha), par model
ne apna claim **ek line** par tikaya.

To user ko dono dikhana chahiye:
- *"is poore hisse se baat aayi"* → halka wash
- *"par asli line ye hai"* → solid border

#### 3. Ab screen par kya dikhta hai

Ye asli render hai:

```
 11  01:07                So you are basically going to create.
                          ─────────────────────────────────────── ↑ range ke bahar

 12  01:10  ░░░░░░░░░░░  We can say post1.tsx exactly post2.tsx...   ┐
 13  01:19  ░░░░░░░░░░░  of posts then is this feasible to create... │
 14  01:27  ███████████  No.                          ◀── PLAYHEAD  │  cueStart 12
 15  01:28  ░░░░░░░░░░░  This is where the use of dynamic routes...  │      se
 16  01:31  ░░░░░░░░░░░  Perfect, so how this actually work?         │  cueEnd 27
 17  01:34  ░░░░░░░░░░░  This is going to be basically work...       │
     ...                 ...                                        │  = 16 lines
 27  02:18  ░░░░░░░░░░░  So, this post ID is a dynamic route.        ┘

 28  02:21                So, every time for post one...
                          ─────────────────────────────────────── ↓ range ke bahar
```

Code me ye bas do lines hain
([TranscriptPane.jsx:125](web/src/components/TranscriptPane.jsx#L125)):

```js
const isPlayhead = cue.index === cueIndex;                                    // sirf 14
const inRange = rangeStart !== null && cue.index >= rangeStart && cue.index <= rangeEnd;  // 12 se 27
```

Har cue row apne aap se poochta hai *"kya main woh line hoon?"* aur *"kya main range me hoon?"* —
aur uske hisaab se class laga leta hai. Bas.

##### Ek mazedaar detail

Dekho playhead **14** par hai, jabki `"This is where the use of dynamic routes come."` to line
**15** me likha hai. Galti?

Nahi. Quote thi:

```
"No. This is where the use of dynamic routes come."
 ↑↑↑
 ye "No." line 14 me hai!
```

Ye ek **sentence** hai jo **do cues** me faili hui hai:

```
cue 14 (01:27) : "No."
cue 15 (01:28) : "This is where the use of dynamic routes come."
```

`pinpointSentence()` sentence ki **shuruaat** deta hai — kyunki instructor ne apni baat 01:27 par
shuru ki thi. Agar 01:28 par le jaate to aap uske sentence ke beech me girte.

#### 4. Click karne par exactly kya hota hai

Ab poora flow, ek-ek kadam:

```
👆 CLICK
   │
   │  CitationChip.jsx
   │  <button onClick={() => onJump(citation)}>
   ▼
1. App.jsx → jumpTo(citation)
   │
   │  Citation ke 4 number nikaal kar transcript ko de diye:
   │     cueIndex : 14      "yahan le jao"
   │     cueStart : 12      "yahan se wash shuru"
   │     cueEnd   : 27      "yahan tak"
   │     ms       : 87500   "01:27"
   ▼
2. Pane khol do  →  setPaneOpen(true)
   ▼
3. URL badal do  →  #/lesson/expo-mastery:module-4--3-dynamic-routes?t=87500&c=14
   ▼
4. useTranscript.open(id, aim)
   │
   ├─ setTarget({...})        ← "kahan dekhna hai" abhi set kar do
   │
   ├─ Cache me hai?  ──haan──►  turant dikha do, koi fetch nahi  ⚡
   │                  │
   │                  nahi
   │                  ▼
   └─ GET /api/lessons/:id/transcript  →  88 cues
   ▼
5. TranscriptPane render  →  88 rows, jinme 16 washed aur 1 playhead
   ▼
6. useLayoutEffect  →  us line tak scroll karo, focus do, screen reader ko batao
```

#### 5. Ab har "ajeeb" detail ka jawab

Ye woh cheezein hain jo padhne me weird lagti hain. Har ek kisi na kisi asli bug se aayi hai.

##### `nonce` kya hai?

```js
nonce: (globalThis.performance?.now?.() ?? 0) | 0
```

**Problem:** React sirf tab kaam karta hai jab kuch **badle**. Aap wahi citation dobara click karo:

```
pehli baar : target = { cueIndex: 14, cueStart: 12, cueEnd: 27 }
doosri baar: target = { cueIndex: 14, cueStart: 12, cueEnd: 27 }   ← bilkul same!
```

React: *"kuch badla hi nahi, main kyun kuch karun?"* → **scroll nahi hoga.**

Par user ne click kiya hai, use expect hai ki wapas us line par pahunche (shayad woh scroll karke
door chala gaya tha).

**Fix:** ek number daal do jo **har baar badalta hai** — current time. Ab object hamesha alag hai,
aur effect hamesha chalta hai.

> Ghar ki ghanti ke jaise. Ghanti wahi hai, par har baar dabane par bajni chahiye.

##### `replaceState`, `pushState` kyun nahi?

```js
window.history.replaceState(null, "", `#/lesson/<id>?t=<ms>&c=<cue>`);
```

| | Kya karta hai |
|---|---|
| `pushState` | History me **naya entry** jodta hai |
| `replaceState` | Jo abhi hai use **badal deta hai** |

Socho aapne 8 citations click kiye. `pushState` hota to:

```
Back dabaya → citation 7
Back dabaya → citation 6
Back dabaya → citation 5
Back dabaya → citation 4 ... 😩 (8 baar dabao tab app se nikloge)
```

Back button ka matlab hona chahiye **"yahan se nikal jao"**, na ki "meri har click ko ulta chalo".

Aur URL phir bhi update hota hai — matlab aap use **copy karke kisi ko bhej sakte ho**, aur woh
seedha usi line par pahunchega.

##### Cache kyun?

```js
const cache = useRef(new Map());
```

Ek hi jawab me aksar **do-teen citations ek hi lesson** ke hote hain. Bina cache ke har chip click
par wahi 88 cues dobara download hote. Cache ke saath doosra click **instant** hai.

##### `setTarget` fetch se **pehle** kyun?

```js
setTarget({ cueIndex, cueStart, cueEnd, ms, nonce });   // ← pehle
const cached = cache.current.get(id);                   // ← baad me
```

Agar transcript already cache me hai, to woh **usi frame me** render ho jaata hai. Agar target baad
me set karte, to ek frame ke liye transcript **bina highlight ke** dikhta — ek jhalak, aur phir
highlight. Ganda lagta.

##### `useLayoutEffect`, `useEffect` nahi

| | Kab chalta hai |
|---|---|
| `useEffect` | Browser ke **screen par paint karne ke BAAD** |
| `useLayoutEffect` | Paint se **PEHLE** |

`useEffect` hota to:

```
frame 1: transcript top par dikha  (line 0)   👁 user ko dikh gaya
frame 2: scroll hua line 14 par                 झटका
```

`useLayoutEffect` me user ko **sirf final position** dikhti hai. Koi jhatka nahi.

##### `scrollIntoView` kyun nahi — 🐛 ye asli bug tha

```js
// ❌ Ye NAHI:
row.scrollIntoView({ block: "center" });

// ✅ Ye:
scroller.scrollTo({ top: scroller.scrollTop + delta, behavior: "smooth" });
```

`scrollIntoView` ka kaam hai: *"is element ko dikhao"* — aur woh **har us cheez ko scroll karta hai
jo scroll ho sakti hai**, poore raaste me:

```
transcript pane  ← ise scroll karna THA ✅
   ↑
  .shell         ← ise BHI scroll kar diya ❌
   ↑
  poora page     ← ise BHI ❌
```

Nateeja: poora page **70px neeche** khisak gaya, aur **header upar cut gaya**.

Fix me hum khud calculate karte hain ki kitna scroll karna hai, aur **sirf ek** container ko batate
hain:

```js
const delta = rowBox.top - scrollerBox.top - (scrollerBox.height - rowBox.height) / 2;
//            ↑ row kahan hai   ↑ pane kahan hai      ↑ beech me laane ke liye
```

##### `focus({ preventScroll: true })`

Focus isliye dete hain ki **keyboard user** bhi wahin land kare (`tabIndex={-1}` isiliye hai —
mouse se focus nahi hoga, sirf programmatically).

Par browser ki aadat hai: focus milte hi woh element ko **khud scroll karke dikhata hai**. Matlab
woh humara abhi kiya hua careful scroll **undo** kar deta.

`preventScroll: true` = *"focus de do, par scroll ko haath mat lagana."*

#### 6. 🐛 Woh CSS wala bug — ab poori tarah

Ye sabse ajeeb hai, isliye dheere se.

##### Pehle: `position: absolute` kaam kaise karta hai

Jab aap kisi cheez ko `position: absolute` dete ho, to woh kehti hai:

> *"Mujhe normal flow se nikaal do. Main kisi ek parent ke hisaab se baithungi."*

Sawaal: **kaunse parent ke?**

Jawab: **sabse nazdeek ka parent jiske paas `position` set ho** (`relative`, `absolute`, ya
`fixed`). Ise "positioned ancestor" kehte hain.

Aur agar kisi bhi parent ke paas nahi hai? To woh **upar chadhti chali jaati hai** jab tak koi mil
na jaye.

> **Bheed me bachcha.** Bachche ko kisi bada ka haath pakadna hai. Uski maa ne haath nahi badhaya
> (`position: static`), to woh agla banda pakad leta hai. Aur agla. Aur jo bhi pehla banda haath
> badhaye hue mila — bachcha usi ke saath chal padta hai. **Chahe woh 3 gali door ho.**

##### Ab bug

Transcript ke timecode ke bagal me ek chhota lime tick banaya tha:

```css
.playhead .time::after {
  position: absolute;    /* ← "main kisi parent ke hisaab se baithungi" */
  ...
}
```

Aur `.time` ke paas `position` tha hi nahi. To tick ne upar dekha:

```
.time            position nahi ❌  → aage badho
.cue (li)        position nahi ❌  → aage badho
.cues (ol)       position nahi ❌  → aage badho
.scroller        position nahi ❌  → aage badho
.pane            position nahi ❌  → aage badho
.body            position nahi ❌  → aage badho
.shell           position: relative ✅  ← YAHAN CHIPAK GAYA
```

Tick ne `.time` ki jagah **`.shell` ko apna anchor** maan liya.

##### Ab isse hua kya

Playhead line 88 cues me se 14 number par hai. Aap us tak scroll karte ho:

```
┌─ .shell ─────────────── 900px ka viewport ────────────┐
│                                                        │
│  ┌─ transcript pane (andar se scroll hui) ──────────┐ │
│  │  ...                                              │ │
│  │  14  01:27  █ playhead   ← ye dikh rahi hai      │ │
│  │  ...                                              │ │
│  └───────────────────────────────────────────────────┘ │
│                                                        │
└────────────────────────────────────────────────────────┘
                    ↓
    par tick ka anchor .shell hai, aur uska calculation
    kehta hai ki use 1904px neeche baithna chahiye
                    ↓
┌─ .shell ka asli scrollHeight ab 1904px ───────────────┐
│                                                        │
│                  (900px viewport)                      │
│                                                        │
├────────────────────────────────────────────────────────┤
│                                                        │
│           1004px ki KHALI JAGAH                        │
│           sirf ek chhote tick ki wajah se              │
│                                                        │
│                            •  ← tick yahan pada hai    │
└────────────────────────────────────────────────────────┘
```

`.shell` ab **scrollable** ban gaya (1904 > 900). Aur jaise hi kuch bhi scroll trigger hua — poora
page khisak gaya, header cut gaya.

**Aur sabse buri baat:** dekhne me lagta tha ki scroll ka bug hai. Asli me ek **chhota sa lime
dot** tha jo apni jagah se bhatak gaya tha.

##### Fix — do parte

**1. Bachche ko uski maa ka haath pakdao**

```css
.time {
  position: relative;   /* ← ab .time khud anchor hai */
}
```

Ab tick ko turant apna parent mil jaata hai. Woh row ke saath chalta hai, kahin nahi bhaagta.

**2. Aur ehtiyaat — darwaza hi band kar do**

```css
.shell {
  overflow: clip;
}
```

Matlab: *"aage kabhi kuch bhaage bhi, to `.shell` scroll hoga hi nahi."*

##### `clip` aur `hidden` me farak

| | Kya karta hai |
|---|---|
| `overflow: hidden` | Bahar ka hissa chhupata hai, **par scroll container bana deta hai** — content bhitar scroll ho sakta hai, `scrollHeight` badhta hai, JS se scroll ho sakta hai |
| `overflow: clip` | Bas **kaat deta hai**. Koi scroll container nahi. Kuch scroll ho hi nahi sakta |

`hidden` se ye bug **fix nahi hota** — `.shell` phir bhi scrollable rehta, bas scrollbar dikhta
nahi. Aur `scrollIntoView` jaisi cheez use phir bhi scroll kar sakti thi. **Chupa hua bug, jo aur
mushkil hota.**

`clip` kehta hai: *"scroll ka option hi nahi hai."*

CSS me comment bhi likha hai ([App.module.css:7](web/src/App.module.css#L7)):

```css
/* `clip` rather than `hidden`: hidden still creates a scroll container, which ... */
```

#### Ek line me sab

**Citation** = "ye baat kahan se aayi" — module, chapter, aur exact second, click karne layak.

Uske andar **do jodi numbers** hain: `cueStart`-`cueEnd` (poora chunk, halka wash) aur `cueIndex`
(ek line, solid playhead). Click par woh chaaron transcript pane ko chale jaate hain, pane apni har
row se poochta hai *"main range me hoon? main woh line hoon?"*, aur uske hisaab se rang bhar deta
hai.

Baaki jitni bhi ajeeb lines hain — `nonce`, `replaceState`, `useLayoutEffect`, `preventScroll`,
`position: relative`, `overflow: clip` — **koi bhi clever nahi hai.** Har ek kisi asli bug ka ilaaj
hai jo pehle ho chuka tha.

---

# Flow F — Rail se lesson kholna

Sabse simple flow. **Zero LLM, zero Qdrant.**

```
ModuleRail.jsx → lesson button click
      ↓
App.jsx → openLesson(lessonId)
      ├─ openTranscript(lessonId)      ← koi aim nahi: pane top se khulta hai
      ├─ setPaneOpen(true)
      ├─ setRailOpen(false)            ← mobile drawer band
      └─ history.replaceState → "#/lesson/<id>"
      ↓
GET /api/lessons/:id/transcript
      ↓
TranscriptPane — koi wash nahi, koi playhead nahi (target me sab null)
```

Saath hi rail ka accordion khud ko sambhalta hai:

```js
// Jis module me khula lesson hai, use expanded rakho
useEffect(() => {
  const owner = catalog.modules.find((m) => m.lessons.some((l) => l.id === activeLessonId));
  if (owner) setExpanded((prev) => new Set(prev).add(owner.id));
}, [activeLessonId, catalog]);
```

Isiliye citation click karne par bhi rail apne aap sahi module khol deta hai.

Har lesson par ek **dot**:

```js
const chunks = indexedChunks(lesson.id);   // status ke lessons map se
<span className={`${styles.dot} ${chunks > 0 ? styles.dotIndexed : ""}`} />
```

Bujha dot = file disk par hai par embed nahi hui. Padh sakte ho, **dhoondh nahi sakte**.
Ye distinction rail footer me bhi saaf likha hai.

---

# Flow G — Course switch karna

```
CourseSwitcher.jsx → commit(index) → onSelect(course.id)
      ↓
useCatalog.setCourseId(id)
      ├─ localStorage me save
      ├─ GET /api/catalog?courseId=<new>
      └─ GET /api/status?courseId=<new>
      ↓
ModuleRail: accordion RESET (warna aisa lagta hai reload hi nahi hua)
      ↓
App.jsx ka effect:
      closeIfNot((openId) => openId.startsWith(`${courseId}:`))
      ⬆ doosre course ka khula transcript band ho jaata hai —
        warna aap kuch aur dekh rahe hote aur samajh kuch aur rahe hote
```

Chat history **nahi** jaati — woh aapka record hai. Har turn par uska apna `courseTitle` chip
dikhta hai, isliye confusion nahi hota ki kis course ne jawab diya.

`"all"` chunne par `courseId` `undefined` ban jata hai → Qdrant filter lagta hi nahi → saare
courses me search.

`CourseSwitcher` ek **custom listbox** hai, native `<select>` nahi — kyunki har option do line
carry karta hai (title + lesson count) aur native control ko rail ke saath style nahi kiya ja
sakta. Poora keyboard contract implement hai: ↑↓ Home End Enter Space Escape Tab, plus
`aria-selected`, roving `tabIndex`, aur outside-click se band.

Ek course ho to switcher **poori tarah hide** ho jaata hai — jisme switch karne ko kuch na ho
woh sirf noise hai.

---

# Flow H — Deep link se aana

URL: `#/lesson/expo-mastery:module-4--dynamic-routes?t=262000&c=88`

```js
const match = /^#\/lesson\/([^?]+)(?:\?(.*))?$/.exec(window.location.hash);
const lessonId = decodeURIComponent(match[1]);
const params = new URLSearchParams(match[2] ?? "");
const ms = Number(params.get("t"));
const cue = Number(params.get("c"));

applyingHash.current = true;    // ⬅ ye flag zaroori hai
openTranscript(lessonId, { ms, cueIndex });
setPaneOpen(true);
```

`applyingHash` flag kyun? Kyunki lesson id me course already hai
(`expo-mastery:module-4--...`). Course-change effect ko **ek baar** rokna padta hai, warna woh
usi lesson ko band kar deta jo hash ne abhi khola hai:

```js
if (applyingHash.current) { applyingHash.current = false; return; }
closeIfNot((openId) => openId.startsWith(`${courseId}:`));
```

`hashchange` listener bhi laga hai — browser back/forward dono kaam karte hain.

---

# Part 2 — Ek timestamp ka poora safar

Ye is doc ki **reedh ki haddi** hai. Ek line disk se aapki screen tak kaise pahunchti hai:

```
┌─ 1. DISK ─────────────────────────────────────────────────────────────────┐
│  dynamic-routes.srt                                                       │
│                                                                            │
│  88                                                                        │
│  00:04:22,150 --> 00:04:25,890                                            │
│  So the square brackets tell Expo Router this is a dynamic segment.        │
└────────────────────────────────────────────────────────────────────────────┘
                              │  subtitles.js → parseSubtitles()
                              ▼
┌─ 2. CUE ───────────────────────────────────────────────────────────────────┐
│  { index: 88, startMs: 262150, endMs: 265890,                              │
│    text: "So the square brackets tell Expo Router this is a dynamic..." }  │
└────────────────────────────────────────────────────────────────────────────┘
                              │  chunker.js → buildSpans()  ★ CRITICAL
                              │  charOffset → cueIndex ka map
                              ▼
┌─ 3. SENTENCE ──────────────────────────────────────────────────────────────┐
│  { text: "So the square brackets tell Expo Router this is a dynamic        │
│           segment.",                                                       │
│    startMs: 262150, cueStart: 88, cueEnd: 88, startsCue: true }            │
└────────────────────────────────────────────────────────────────────────────┘
                              │  chunker.js → chunkSentences()
                              ▼
┌─ 4. CHUNK ─────────────────────────────────────────────────────────────────┐
│  { text: "<~1200 chars, ~20 sentences>",                                   │
│    startMs: 258400, endMs: 331200, cueStart: 84, cueEnd: 108 }             │
└────────────────────────────────────────────────────────────────────────────┘
                              │  openai.js → embedTexts()
                              │  indexer.js → qdrant.upsert()
                              ▼
┌─ 5. QDRANT POINT ──────────────────────────────────────────────────────────┐
│  id: <deterministic UUID>                                                  │
│  vector: [1536 floats]                                                     │
│  payload: { text, courseId, lessonId, moduleTitle, lessonTitle,            │
│             startMs: 258400, endMs: 331200,                                │
│             cueStart: 84, cueEnd: 108, contentHash, ... }                  │
└────────────────────────────────────────────────────────────────────────────┘

                         ⋯ mahino baad, koi sawaal puchta hai ⋯

┌─ 6. SEARCH HIT ────────────────────────────────────────────────────────────┐
│  retriever.js → searchByVector() → reciprocalRankFusion()                  │
│  { id, rrfScore: 0.0491, matchedBy: ["rewritten", "hyde"], payload: {...} }│
└────────────────────────────────────────────────────────────────────────────┘
                              │  retriever.js → chatJSON(ANSWER_SCHEMA)
                              ▼
┌─ 7. MODEL KA QUOTE ────────────────────────────────────────────────────────┐
│  { excerpt: 1,                                                             │
│    quote: "So the square brackets tell Expo Router this is a dynamic       │
│            segment." }                                                     │
│  ⬆ VERBATIM hona zaroori hai — agla step isi par chalta hai                │
└────────────────────────────────────────────────────────────────────────────┘
                              │  retriever.js → pinpointSentence()
                              │  transcript.js → getCues() (cached)
                              │  chunker.js → cuesToSentences() DOBARA
                              ▼
┌─ 8. PINPOINT ──────────────────────────────────────────────────────────────┐
│  { startMs: 262150, cueIndex: 88, exact: true }                            │
│  ⬆ 73-second window se ek line par                                         │
└────────────────────────────────────────────────────────────────────────────┘
                              │  retriever.js → buildCitations()
                              ▼
┌─ 9. CITATION ──────────────────────────────────────────────────────────────┐
│  { n: 1, lessonId, moduleTitle: "Module 4 · Expo Router",                  │
│    lessonTitle: "Dynamic Routes",                                          │
│    startMs: 258400, endMs: 331200, cueStart: 84, cueEnd: 108,   ← wash     │
│    pinpointMs: 262150, cueIndex: 88, quote, exactQuote: true }   ← playhead│
└────────────────────────────────────────────────────────────────────────────┘
                              │  HTTP → useConversation → Conversation.jsx
                              ▼
┌─ 10. CHIP ─────────────────────────────────────────────────────────────────┐
│  [1]  Module 4 · Expo Router                                               │
│       Dynamic Routes                     ──────●──  04:22                  │
└────────────────────────────────────────────────────────────────────────────┘
                              │  click → App.jumpTo → useTranscript.open
                              ▼
┌─ 11. TRANSCRIPT PANE ──────────────────────────────────────────────────────┐
│  04:18  │  and now let's look at what happens when...     ░ washed         │
│  04:22  ┃  So the square brackets tell Expo Router...     █ PLAYHEAD       │
│  04:26  │  which means anything can go in there...        ░ washed         │
│         ↑ scrolled to centre, focused, announced                           │
└────────────────────────────────────────────────────────────────────────────┘
```

**Poori chain me sirf 3 files timestamp ko chhuti hain:** `subtitles.js` (banata hai),
`chunker.js` (bachata hai), `retriever.js` (sharpen karta hai). Baaki sab bas use aage
pass karte hain.

Agar `chunker.js` me `buildSpans()` na hota — jaise purane pipeline me
`text.replace(/\s+/g, " ")` sab flat kar deta tha — to chain **step 3 par hi toot jaati**,
aur ye poora product possible hi nahi hota.

---

# Part 3 — Har file ka card

## `src/config.js`

**Kaam:** Saari settings ek jagah, `.env` se override.
**Kaun bulata hai:** Lagbhag har file.
**Ye kis ko bulati hai:** `dotenv/config` (import karte hi `.env` load).

```js
const fromRoot = (p) => (path.isAbsolute(p) ? p : path.resolve(projectRoot, p));
```

**Gotcha:** Paths **project root** se resolve hote hain, CWD se nahi. Isliye kisi bhi folder se
script chalao, `COURSE_PATH` sahi jagah point karta hai.

`assertOpenAIKey()` yahin hai — taaki bare 401 worker ke andar se nikalne ki jagah ek saaf,
actionable message mile.

---

## `src/index.js`

**Kaam:** Express routes + static frontend.
**Kaun bulata hai:** `npm start`.

**Gotcha 1 — `route()` wrapper:**

```js
const route = (handler) => (req, res, next) => handler(req, res, next).catch(next);
```

Express 4 async rejections khud nahi pakadta. Iske bina ek reject hui promise
**chup-chaap request ko hang** kar deti.

**Gotcha 2 — `resolveCourseId()`:** Unknown `courseId` par 400. Iske bina woh string seedha
Qdrant filter me chali jaati — bina validate ke.

**Gotcha 3 — error handler ki arity:**

```js
// eslint-disable-next-line no-unused-vars -- Express identifies handlers by arity.
app.use((err, _req, res, _next) => { ... });
```

`_next` hata do to Express ise error handler maanna hi band kar dega. Isliye lint disable.

---

## `src/queue.js` + `src/worker.js`

**queue.js** = producer side (2 `Queue` objects + 2 enqueue helpers).
**worker.js** = consumer side (2 `Worker` objects).

```js
export const connection = { host, port, maxRetriesPerRequest: null };
```

**Gotcha:** BullMQ ko `maxRetriesPerRequest: null` **chahiye** hi. Default value ke saath
long-blocking commands fail ho jaate hain.

Retention: query jobs 1 ghanta rakhe jaate hain (`removeOnComplete: { age: 3600 }`) — kyunki
client unhe poll karta hai.

---

## `src/catalog.js` — sabse badi file (524 lines)

**Kaam:** Gande folder names → ordered, readable syllabus.

Input kuch aisa hai:

```
01_what-is-mobile-development_epm
chapter-3_epm
mini-project-1-init-project-setup_epm
4. expo file system_epm
```

**Layout auto-detect:**

```
attempt 1: root khud ek course hai?      <root>/module 1/<lesson>/*.srt
   ↓ 0 lessons mile?
attempt 2: root ke har child ko course maano   <root>/<course>/module 1/...
```

Fallback unambiguous hai: multi-course root ko single-course samajh kar scan karoge to
**kuch nahi** milega (files ek level neeche hain).

**Naming pipeline:**

```
"01_what-is-mobile-development_epm"
  → _epm suffix hatao
  → LESSON_ORDINAL match → order: 1
  → prettify: separators → spaces
  → titleCase + WORD_FIXES
  → "What Is Mobile Development"
```

`WORD_FIXES` do kaam karta hai:

- Acronyms/component names: `eas`→`EAS`, `sqllite`→`SQLite`, `textinput`→`TextInput`
- **Source ke typos:** `porps`→`Props`, `notificaiton`→`Notification`,
`authenitcation`→`Authentication`, `changin`→`Changing`, `remainder`→`Reminder`

`titleCase` ek chhoti si samajhdari: **jo word pehle se capital carry karta hai use chhod do.**
Bahut folders sahi likhe hain ("Bring Native Maps Into Your App") — unhe re-case karna sirf
nuksan karega.

**Do asli bugs jo yahan fix hue:**

1. **Mini-projects chapters ke saath mix ho rahe the** — dono 1 se shuru hote hain.
  Fix: `KIND_RANK = { chapter: 0, "mini-project": 1 }`, sort `(kind, order, title)`.
2. **5 lessons ka koi naam hi nahi tha** (`chapter-3_epm`). Fix: `LESSON_ORDINAL_ONLY` unhe
  "Chapter 3" bana deta hai + `untitled: true` flag, aur optional
   `npm run titles:generate` transcript se asli naam bana sakta hai.

**Flexible module regex:**

```js
const MODULE_LABELS = "module|section|part|unit|chapter|week";
const MODULE_NAME = new RegExp(`^(${MODULE_LABELS})?[-_.\\s]*(\\d{1,3})\\b[-_.\\s]*(.*)$`, "i");
```

`\d{1,3}` guard zaroori hai — warna `2024-notes` module **2024** ban kar sabse aakhir chala
jaata. Bina number wale folders (`bonus`) `Number.MAX_SAFE_INTEGER` par jaate hain — aakhir me,
naam jyon ka tyon.

**Id format:** `courseId:moduleSlug--lessonSlug`
→ `expo-mastery:module-4--dynamic-routes`

Collision handling: do modules me `chapter-1` ho sakta hai, isliye `usedIds` set + `-2` suffix.

**Exports:** `scanCourses` · `getCourses` (cached) · `clearCourseCache` · `findLesson` ·
`findCourse` · `listCourses` · `getCatalog` · `renderSyllabus` · `parseLessonName` ·
`parseModuleName`

---

## `src/subtitles.js`

**Kaam:** `.srt` + `.vtt` → cues. Ek hi parser dono ke liye.

```js
const TIMESTAMP = /(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})/;
```

`[,.]` — SRT comma use karta hai, VTT dot. Hour group optional hai (VTT me `01:02.345` valid).

**Handle karta hai:** BOM · CRLF/CR · VTT `NOTE`/`STYLE`/`REGION` blocks · inline markup
(`<v Speaker>`, `<c.classname>`, karaoke timestamps) · HTML entities · SRT sequence numbers ·
VTT cue identifiers.

```js
const ms = Number(String(fraction).padEnd(3, "0").slice(0, 3));
```

**Gotcha:** `.5` ka matlab **500ms** hai, 5ms nahi. Isliye `padEnd`, truncate nahi.

**Verified:** 174/174 files, 0 failures, **SRT aur VTT har cue par exactly match karte hain** —
isiliye sirf `.srt` index karna kaafi hai.

---

## `src/chunker.js`

Upar [Flow B](#chunker--teen-stage-thodi-detail) me detail me hai. Yahan sirf ek line:

**Poori file pure hai — koi I/O nahi.** Isiliye 87 lessons par saare invariants test me assert
ho jaate hain: koi cue kabhi kho na jaye, cue ranges kabhi peeche na jaayein, koi chunk
ceiling cross na kare, aakhri ke alawa koi floor se neeche na ho.

**Do jagah use hoti hai:**

- `indexer.js` → `chunkCues()` (chunks banane ke liye)
- `retriever.js` → `cuesToSentences()` (pinpoint ke liye) ← **wahi splitter, isiliye quote line-up hota hai**

---

## `src/indexer.js`

Upar [Flow B](#consumer-side--srcindexerjs) me detail me hai.

**Do smart cheezein:**

```js
function chunkId(lessonId, chunkIndex) {
  const hex = crypto.createHash("sha1").update(`${lessonId}#${chunkIndex}`).digest("hex");
  return [hex.slice(0,8), hex.slice(8,12), ...].join("-");   // UUID shape
}
```

Deterministic UUID — re-index **in place** overwrite karta hai, duplicate jama nahi hote.
(Qdrant ids sirf UUID ya integer maanta hai, isliye sha1 ko UUID shape me daala gaya hai.)

```js
await deleteLessonPoints(lessonId);
await qdrant.upsert(collection, { wait: true, points });
```

Delete-**then**-upsert, merge nahi. Chunker badla to boundaries shift ho jaate hain aur purane
points chupke se pade reh jaate.

---

## `src/qdrant.js`

```js
const KEYWORD_INDEXES = ["courseId", "lessonId", "moduleId"];
```

Qdrant ko har filterable field par **index** chahiye. Bina index ke `courseId` filter aur
`lessonId` delete dono kaam nahi karte.

```js
export function isMissingCollection(err) {
  const status = err?.status ?? err?.response?.status;
  return status === 404 || /doesn't exist|not found/i.test(err?.message ?? "");
}
```

"Abhi tak kuch index nahi hua" ek **normal state** hai, failure nahi. Isliye search us case me[https://github.com/VectifyAI/PageIndex](https://github.com/VectifyAI/PageIndex)
`[]` return karta hai, throw nahi.

`ensureCollection()` har job par call hoti hai — safe hai, kyunki existing index banana
server-side no-op hai. 409 Conflict (do worker ek saath) bhi handle hai.

---

## `src/openai.js`

Teen functions:


| Function                                   | Kya                                    |
| ------------------------------------------ | -------------------------------------- |
| `embedText(text)`                          | Ek vector                              |
| `embedTexts(texts, batchSize=100)`         | Batched vectors                        |
| `chatJSON({ name, schema, system, user })` | **Structured output** — `strict: true` |
| `chatText({ system, user })`               | Plain prose — sirf HyDE ke liye        |


`chatJSON` kyun better hai markers parse karne se:

```js
response_format: { type: "json_schema", json_schema: { name, strict: true, schema } }
```

Model **aisa shape return kar hi nahi sakta** jo humne maanga nahi, aur mismatch par API khud
internally retry karti hai. Chaar jagah use hota hai: classification, rewriting, catalog
answer, grounded answer.

---

## `src/pipeline.js`

**79 lines. Poore product ka routing logic ek readable jagah par.**

Iska poora point yahi hai — ordering worker me bikhri hui nahi honi chahiye. Ek nazar me dikh
jaata hai ki mask pehle hota hai, classify uske baad, aur uske baad teen me se ek branch.

---

## `src/guardrails.js`

Upar [Flow D STEP 1](#step-1--pii-masking-guardrailsjs) me detail me hai.

Ek design detail jo dohrane layak hai:

```js
masked = masked.replace(rule.pattern, (match, group1) => {
  if (rule.validate && !rule.validate(match)) return match;   // ⬅ "main pass karta hoon"
  ...
});
```

Regex **loosely** match karta hai, phir **code** decide karta hai. Digit-grouping rules code me
likhna aasan hai, regex me dard.

```js
rule.pattern.lastIndex = 0;
```

**Gotcha:** module-level global regexes har call me reuse hote hain. `lastIndex` reset na karo
to doosri call pehli ke beech se shuru hoti hai. (Iska ek test hai.)

---

## `src/router.js`

Upar [Flow D STEP 2](#step-2--gate--router-ek-hi-call-me-routerjs) me detail me hai.

**Ek export jo shayad chhoot jaye:** `normaliseClassification(raw)` — network call se alag,
isliye routing rules bina API key ke test ho sakte hain. Isi pattern ka doosra example
`normaliseRewrite()` hai `retriever.js` me.

---

## `src/retriever.js`

Upar [Flow D STEP 3c](#step-3c--content-path-retrieverjs) me detail me hai.

**Exports:** `queryRewriting` · `normaliseRewrite` · `hydeDocument` · `reciprocalRankFusion` ·
`retrieveChunks` · `pinpointSentence` · `answerQuery`

`buildCitations` deliberately **private** hai — woh sirf `answerQuery` ke liye hai.

**Ek chhota par important guard:**

```js
const chunk = chunks[Number(item?.excerpt) - 1];
if (!chunk) continue;
```

Model kabhi-kabhi aisa excerpt number bol deta hai jo diya hi nahi gaya tha. Woh citation
**drop** ho jaati hai — galat jagah point karne se behtar hai ek kam citation.

---

## `src/catalog-answer.js`

Upar [Flow D STEP 3b](#step-3b--metadata-path-catalog-answerjs) me detail me hai.

`resolveLessonTitles()` ka fallback:

```js
const normalise = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const lesson = byExact.get(title.trim()) ?? byLoose.get(normalise(title));
if (!lesson || seen.has(lesson.id)) continue;    // na mila? DROP.
```

Exact-phir-loose. Prompt verbatim titles maangta hai, par model reformat kar de to user ka
link nahi jaana chahiye. Phir bhi na mile — **guess nahi karte**.

---

## `src/transcript.js`

LRU cache, `MAX_CACHED_LESSONS = 24`:

```js
function readCache(lessonId) {
  const cues = cache.get(lessonId);
  cache.delete(lessonId);         // recency refresh:
  cache.set(lessonId, cues);      // delete + re-insert = end me chala jaata hai
  return cues;
}
```

JS `Map` insertion order maintain karta hai, isliye `cache.keys().next().value` hamesha sabse
purana hota hai — eviction ke liye bilkul sahi.

Bounded kyun? Poora corpus parse hone par sirf ~10 MB hai, par ek long-running server me
unbounded Map ek leak hai jo hone ka wait kar rahi hai.

**Do exports:** `getTranscript()` (meta + cues, pane ke liye) aur `getCues()` (sirf cues,
pinpoint ke liye) — dono ek hi cache share karte hain.

---

## `src/status.js`

```js
const SCROLL_PAGE = 1024;
const MAX_PAGES = 200;      // safety valve — ek request event loop pin na kar de
```

Poora collection scroll karke per-lesson chunk count ginta hai. Sirf 2 payload fields maangta
hai (`lessonId`, `indexedAt`) aur `with_vector: false` — warna 1382 × 1536 floats network par
aate.

Sabse zaroori hissa **graceful degradation** hai:

```js
getIndexedLessons().catch((err) => {
  if (err?.cause?.code === "ECONNREFUSED" || /fetch failed/i.test(err?.message ?? "")) return null;
  throw err;
});
```

Qdrant band → `reachable: false` + ek **actionable message**, crash nahi.

---

## Frontend cards

### `web/src/api/client.js`

Teen contracts jo poore frontend me nibhaye jaate hain:

1. **Har call abortable** — `AbortSignal.any([userSignal, timeoutSignal])`
2. **Har failure `ApiError`** with a user-safe `message`
3. **Polling bounded** — 120s ke baad `"Timed out waiting for an answer. Is the worker running?"`

```js
export const isAbort = (err) => err?.name === "AbortError" || err?.name === "TimeoutError";
```

Abort **kabhi error nahi hai** — user ne navigate kiya ya humne cancel kiya. Har hook ise
alag se handle karta hai.

Network failure ka message bhi actionable hai:
`"Can't reach the server. Is it running on port 8000?"`

### `web/src/hooks/useCatalog.js`

Ek `AbortController` **poore hook ki lifetime** ke liye:

```js
const abortRef = useRef(null);
if (abortRef.current === null) abortRef.current = new AbortController();
useEffect(() => () => abortRef.current.abort(), []);
```

Unmount = sab kuch cancel.

Course-tree fetch ka apna controller hai (`[courseId]` par re-run hota hai), isliye tezi se
course badlo to purani request cancel ho jaati hai.

**Note:** `refreshStatus` return hota hai par `App.jsx` use call nahi karta — abhi status sirf
mount par aur course badalne par refresh hota hai. Ingest ke baad naye dots dekhne ke liye
page reload karna padta hai.

### `web/src/hooks/useConversation.js`

```js
if (!text || inFlight.current) return;      // ek waqt me ek sawaal
```

Abort par turn **poori tarah hata di** jaati hai (error dikhane ki jagah):

```js
if (isAbort(err)) { setTurns((list) => list.filter((t) => t.id !== id)); return; }
```

Aapne Stop dabaya — woh error nahi hai. Adhoora turn chhodna hi galat hoga.

### `web/src/hooks/useTranscript.js`

```js
setTarget({ ..., nonce: (globalThis.performance?.now?.() ?? 0) | 0 });
```

`nonce` isliye ki wahi citation dobara click karne par bhi scroll effect chale.

`cache` ek `Map` ref me — ek hi lesson ke citations ke beech click karna **instant** hai.

`closeIfNot(predicate)` — course badalne par doosre course ka lesson band karne ke liye.

### `web/src/styles/tokens.css`

Poori design language ek file me: colors, type scale, space scale, radii, easing, layout widths.

**Cinema Timeline** — ek editing-suite ki bhasha, kyunki poora app **time** ke around bana hai:


| Token         | Value          | Kyun                                                   |
| ------------- | -------------- | ------------------------------------------------------ |
| `--ground`    | `#0b0c0e`      | Thandi near-black canvas                               |
| `--cue`       | `#c3f53c`      | Electric lime = playhead. "Yahan, abhi, yeh."          |
| `--font-mono` | JetBrains Mono | **Tabular nums** — timecode ke digits shift nahi karte |
| `--font-ui`   | Archivo        | Headings + UI                                          |


```css
html { overflow: hidden; }
body { height: 100dvh; overflow: hidden; }
```

App viewport ka maalik hai; sirf **andar ke panes** scroll karte hain. Iske bina ek pane ke
andar ka programmatic scroll poore document ko kheench leta hai.

```css
@media (prefers-reduced-motion: reduce) { /* saari animation ~0 */ }
```

---

# Part 4 — Kaunsa feature kis par depend karta hai


| Feature                      | Disk | Redis | Qdrant | OpenAI |
| ---------------------------- | ---- | ----- | ------ | ------ |
| Course list / syllabus rail  | ✅    | —     | —      | —      |
| Transcript pane (padhna)     | ✅    | —     | —      | —      |
| Deep link se lesson kholna   | ✅    | —     | —      | —      |
| Indexed dots / status footer | ✅    | —     | ✅      | —      |
| Sawaal puchna (koi bhi)      | ✅    | ✅     | —      | ✅      |
| ↳ blocked jawab              | ✅    | ✅     | —      | ✅      |
| ↳ metadata jawab             | ✅    | ✅     | ~      | ✅      |
| ↳ content jawab              | ✅    | ✅     | ✅      | ✅      |
| Ingest                       | ✅    | ✅     | ✅      | ✅      |


`~` = optional. Metadata path Qdrant se sirf "kitne indexed hain" poochta hai, aur woh fail ho
jaye to chup-chaap skip.

**Iska matlab practically:** API key khatam? Rail aur transcripts poore chalte hain.
Qdrant band? Wahi. **Sirf chat rukta hai** — aur UI theek se batata hai kyun.

---

# Part 5 — Paisa kahan lagta hai

Sirf **OpenAI** paise leta hai. Qdrant aur Redis local hain.

## Ingest — ek baar


| Kya    | Kitna                                |
| ------ | ------------------------------------ |
| Model  | `text-embedding-3-small` (1536 dims) |
| Chunks | 1382                                 |
| Total  | **~$0.006** (one-time)               |


Dobara chalane par: **$0.00** (contentHash skip).

## Per question


| Route        | LLM calls                              | Embed                 | Qdrant search   | Cost      |
| ------------ | -------------------------------------- | --------------------- | --------------- | --------- |
| **Blocked**  | 1 (classify)                           | 0                     | 0               | ~$0.00007 |
| **Metadata** | 2 (classify + catalog)                 | 0                     | 0 vector search | ~$0.00035 |
| **Content**  | 4 (classify + rewrite + hyde + answer) | 1 batched (3-4 texts) | 3-4             | ~$0.0007  |


Content path ke 4 calls:

```
1. classifyQuery       router.js          gate + intent
2. queryRewriting  ─┐  retriever.js       parallel
3. hydeDocument    ─┘  retriever.js       parallel
4. grounded answer     retriever.js       jawab + citations
```

**Imaandari se:** router ne content questions ko **~10% mehnga** kiya hai (3 se 4 calls), tez
nahi. Uska payoff metadata aur off-topic questions par hai — wahan woh 3-5 second aur poora
vector search bachata hai, **aur** metadata ka jawab pehli baar sahi deta hai.

**Jo free hai:**

- PII masking (regex)
- `pinpointSentence()` (deterministic token overlap)
- Transcript reads (disk + cache)
- Catalog / syllabus (disk + cache)
- RRF (arithmetic)

---

# Part 6 — Kuch toota to kahan dekho


| Symptom                                        | Sabse pehle dekho                           | Aam wajah                                                                            |
| ---------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------ |
| "Nothing is indexed yet"                       | `src/status.js`, phir `npm run ingest`      | Embeddings bane hi nahi                                                              |
| Ingest 0/87 par atka                           | Worker terminal                             | `npm run worker` chala hi nahi (script 10s baad khud batati hai)                     |
| `EADDRINUSE :::8000`                           | —                                           | Purana server chal raha hai → `fuser -k 8000/tcp`                                    |
| Rail khali hai                                 | `src/catalog.js` → `COURSE_PATH`            | Path galat ya layout expected nahi                                                   |
| Status 0 dikhata hai par Qdrant me points hain | Server ko restart karo                      | Qdrant band hone ke waqt server start hua tha — client ka version check fail ho gaya |
| Citation click par kuch nahi hota              | `web/src/hooks/useTranscript.js`            | `lessonId` catalog Map me nahi (id format badla?)                                    |
| Timestamp galat line par le jaata hai          | `pinpointSentence` ka `PINPOINT_THRESHOLD`  | Quote paraphrased tha → chunk `startMs` fallback laga                                |
| Chunk aadhe vaakya me katta hai                | `chunker.js` → `isSentenceEnd()`            | Naya abbreviation `ABBREVIATIONS` set me daalo                                       |
| Timestamp mask ho gaya                         | `src/guardrails.js` phone rule              | Pinned negative tests chalao: `npm test`                                             |
| Legit sawaal reject ho gaya                    | `src/router.js` `SYSTEM` prompt             | Gate zyada aggressive ho gaya — "uncovered ≠ off-topic"                              |
| UI purana build dikha raha hai                 | `src/index.js` cache headers                | `index.html` cache ho gaya (isliye `no-cache` hai)                                   |
| Page 70px scrolled dikhta hai                  | CSS — absolutely-positioned pseudo-elements | Positioned ancestor missing → `.shell` ka scrollHeight badh gaya                     |
| Har job fail ho rahi hai                       | Worker ka boot warning                      | `OPENAI_API_KEY` set nahi                                                            |


**Job-level debugging:** `http://localhost:8000/admin/queues` — Bull Board. Har job ka data,
result, stack trace; retry aur clean bhi wahin se. *(Auth nahi hai — public port par mat kholo.)*

---

# Part 7 — Config knobs

Sab `.env` me, sab `src/config.js` se hoke.


| Env var                     | Default                             | Kis par asar                           |
| --------------------------- | ----------------------------------- | -------------------------------------- |
| `PORT`                      | `8000`                              | API server                             |
| `COURSE_PATH`               | `class_subtitle_.../class-subtitle` | `catalog.js` kahan scan kare           |
| `COURSE_NAME`               | `Expo Mastery`                      | Single-course mode me display name     |
| `SCAN_DURATIONS`            | `true`                              | Boot par lesson lengths padhe (~199ms) |
| `TITLES_FILE`               | `data/lesson-titles.json`           | Optional title overlay                 |
| `REDIS_HOST` / `REDIS_PORT` | `127.0.0.1` / `6379`                | Queue connection                       |
| `QDRANT_URL`                | `http://127.0.0.1:6333`             | Vector store                           |
| `QDRANT_COLLECTION`         | `course_transcripts`                | Collection name                        |
| `OPENAI_API_KEY`            | *(required)*                        | Sab kuch AI wala                       |
| `EMBEDDING_MODEL`           | `text-embedding-3-small`            | ⚠️ Badla to **poora re-index** chahiye |
| `EMBEDDING_DIMENSIONS`      | `1536`                              | Model se match hona chahiye            |
| `CHAT_MODEL`                | `gpt-4o-mini`                       | Saare 4 chat calls                     |
| `CHUNK_TARGET_CHARS`        | `1200`                              | Chunk ka target size                   |
| `CHUNK_MIN_CHARS`           | `600`                               | Floor (aakhri chunk ko chhod kar)      |
| `CHUNK_MAX_CHARS`           | `1800`                              | Hard ceiling                           |
| `CHUNK_OVERLAP_CHARS`       | `240`                               | Sentence overlap                       |
| `CHUNK_STRONG_PAUSE_MS`     | `1500`                              | Structural break ka threshold          |
| `MAX_SENTENCE_CHARS`        | `400`                               | Unpunctuated run ka cap                |
| `RETRIEVAL_TOP_K`           | `6`                                 | Har variant se candidates              |
| `RRF_K`                     | `60`                                | Fusion constant                        |
| `RETRIEVAL_FINAL_K`         | `6`                                 | Fusion ke baad kitne chunks rakhe      |
| `MAX_QUERY_CHARS`           | `2000`                              | Request validation                     |
| `INGEST_CONCURRENCY`        | `3`                                 | Ek saath kitne lessons embed hon       |
| `QUEUE_DASHBOARD_PATH`      | `/admin/queues`                     | Bull Board mount point                 |


---

# Part 8 — Do cheezein jo doc aur code me match nahi karti

Imaandari ke liye — ye do cheezein aaj repo me aisi hain:

### 1. Chunking config `contentHash` me shaamil nahi hai

```js
const contentHash = crypto.createHash("sha256").update(raw).digest("hex");
//                                                      ^^^ sirf subtitle file
```

Matlab: `CHUNK_TARGET_CHARS` ya `CHUNK_STRONG_PAUSE_MS` badal do, `npm run ingest` chalao —
hash wahi rahega, sab **skip** ho jayega, aur **purane chunks Qdrant me pade rahenge**.

Aaj ka workaround: `npm run ingest -- --force`.
Asli fix ~3 line ka hai (hash me chunking config bhi mila do).

### 2. PII masking sirf **input** par hai, output par nahi

`guardrails.js` ka doc comment kehta hai *"and from model output before it reaches the screen"* —
par `pipeline.js` `maskPII` sirf `rawQuery` par chalata hai. Model ke jawab par nahi.

Practically ye theek hai (jawab transcripts se aata hai, aur transcripts me secrets nahi), par
doc comment aur code abhi match nahi karte.

---

## Aage padhne ke liye

- **Asli numbers, asli chunks, asli scores:** [PIPELINE-EXAMPLE.md](PIPELINE-EXAMPLE.md)
- **Setup aur commands:** [README.md](README.md)
- **Original plan aur decisions:** [docs/PLAN.md](docs/PLAN.md)

