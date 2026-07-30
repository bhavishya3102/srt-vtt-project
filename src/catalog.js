import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { readSubtitleFile } from "./subtitles.js";

/**
 * Builds the course tree from the subtitle folders on disk.
 *
 * Two layouts are supported and detected automatically, so existing folders
 * never have to be moved:
 *
 *   single course:  <root>/module 1/<lesson>/<lesson>.srt
 *   many courses:   <root>/<course>/module 1/<lesson>/<lesson>.srt
 *
 * Folder names are the raw export from the course platform and are wildly
 * inconsistent — `01_what-is-mobile-development_epm`, `chapter-3_epm`,
 * `mini-project-1-init-project-setup_epm`, `4. expo file system_epm`. Turning
 * that into an ordered, readable syllabus is most of what this module does.
 *
 * SECURITY: lesson ids are keys into a Map built by scanning the disk. A
 * client-supplied id is never joined into a path, which makes traversal
 * structurally impossible rather than something we try to filter for.
 */

/** Folders macOS adds to zip exports, plus the usual suspects. */
const IGNORED_DIRS = new Set(["__MACOSX", ".git", "node_modules", "data", "dist"]);
const IGNORED_FILES = new Set([".DS_Store"]);

/** Subtitle extensions, in the order we prefer to read them. */
const SUBTITLE_EXTENSIONS = [".srt", ".vtt"];

/**
 * Words that must keep a fixed casing when a folder name is title-cased.
 * Without this, `eas-update` renders "Eas Update" and `expo-sqllite` renders
 * "Expo Sqllite", which looks careless in a syllabus.
 *
 * This also carries a handful of corrections for typos that exist in the source
 * folder names themselves (`porps`, `notificaiton`). Edit freely — it is a
 * presentation detail, nothing depends on it.
 */
const WORD_FIXES = new Map(
  Object.entries({
    // acronyms and product names
    api: "API", apis: "APIs", crud: "CRUD", eas: "EAS", env: "env",
    hc: "HC", io: "IO", iot: "IoT", ios: "iOS", js: "JS", json: "JSON",
    oauth: "OAuth", sdk: "SDK", sqlite: "SQLite", sqllite: "SQLite",
    ui: "UI", url: "URL", urls: "URLs", ux: "UX", ip: "IP",
    // React Native component names
    view: "View", text: "Text", image: "Image", textinput: "TextInput",
    pressable: "Pressable", stylesheet: "StyleSheet", flatlist: "FlatList",
    sectionlist: "SectionList", scrollview: "ScrollView",
    // typos present in the exported folder names
    porps: "Props", notificaiton: "Notification",
    authenitcation: "Authentication", changin: "Changing",
    remainder: "Reminder", pokemondetail: "PokemonDetail",
    homescreen: "HomeScreen", filtermodal: "FilterModal",
  })
);

/** Small words that stay lowercase inside a title (never at the start). */
const MINOR_WORDS = new Set([
  "a", "an", "and", "the", "of", "in", "on", "to", "vs", "for", "with", "your", "from",
]);

/**
 * Container words a module folder may be named with. `module 1`, `Section 2`,
 * `part-3`, `unit 4`, `week 5`, or a bare `06` all work.
 */
const MODULE_LABELS = "module|section|part|unit|chapter|week";

/**
 * Leading ordinal on a *lesson* folder: `chapter-2-`, `01_`, `4. `,
 * `mini-project-1-`, `10-`. The label is captured so a folder with nothing left
 * over can still be called "Chapter 3".
 */
const LESSON_ORDINAL =
  /^(chapter|mini[-\s_]?project|lesson|part|section|episode)?[-_.\s]*(\d{1,3})\s*[-_.)\s]+/i;

/** Same, for a folder that is *only* an ordinal, e.g. `chapter-3`. */
const LESSON_ORDINAL_ONLY =
  /^(chapter|mini[-\s_]?project|lesson|part|section|episode)?[-_.\s]*(\d{1,3})$/i;

/** Module folder: an optional container word, a number, and an optional suffix. */
const MODULE_NAME = new RegExp(`^(${MODULE_LABELS})?[-_.\\s]*(\\d{1,3})\\b[-_.\\s]*(.*)$`, "i");

/** Lessons sort by kind first, so mini-projects follow the numbered chapters. */
const KIND_RANK = { chapter: 0, "mini-project": 1 };

/** Normalise a captured container/ordinal label for display. */
function labelFor(raw, fallback = "Lesson") {
  if (!raw) return fallback;
  const compact = raw.toLowerCase().replace(/[\s_]+/g, "-");
  if (compact === "mini-project") return "Mini-project";
  return compact.charAt(0).toUpperCase() + compact.slice(1);
}

/**
 * Make a raw folder name presentable.
 *
 * Words that already carry capitals are left alone — many folders are written
 * properly ("Bring Native Maps Into Your App") and re-casing them would only do
 * damage. Only all-lowercase words get title-cased.
 */
function titleCase(text) {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((word, i) => {
      const bare = word.toLowerCase().replace(/[^a-z0-9]/g, "");
      const fixed = WORD_FIXES.get(bare);
      if (fixed) return word.replace(/[a-z0-9]+/i, fixed);

      // Respect existing capitalisation (e.g. "Expo", "TextInput", "OAuth").
      if (word !== word.toLowerCase()) return word;

      if (i > 0 && MINOR_WORDS.has(bare)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

/** Separators to spaces, then title-case. */
function prettify(name) {
  return titleCase(name.replace(/[_]+/g, " ").replace(/-+/g, " ").replace(/\s+/g, " ").trim());
}

/**
 * Parse a lesson folder name.
 *
 * @example "01_what-is-mobile-development_epm" -> { order: 1, kind: "chapter", title: "What Is Mobile Development" }
 * @example "chapter-3_epm"                     -> { order: 3, kind: "chapter", title: "Chapter 3" }
 * @example "mini-project-2-backend-api_epm"    -> { order: 2, kind: "mini-project", title: "Backend API and Constants" }
 */
export function parseLessonName(folderName) {
  // `_epm` is the platform's suffix on every folder; it carries no meaning.
  let name = folderName.replace(/_epm$/i, "").trim();

  const kindOf = (label) =>
    /mini/i.test(label ?? "") ? "mini-project" : "chapter";

  const onlyOrdinal = name.match(LESSON_ORDINAL_ONLY);
  if (onlyOrdinal) {
    const order = Number(onlyOrdinal[2]);
    return {
      order,
      kind: kindOf(onlyOrdinal[1]),
      title: `${labelFor(onlyOrdinal[1], "Chapter")} ${order}`,
      untitled: true,
    };
  }

  let order = null;
  let label = null;
  const prefix = name.match(LESSON_ORDINAL);
  if (prefix) {
    label = prefix[1];
    order = Number(prefix[2]);
    name = name.slice(prefix[0].length);
  }

  const title = prettify(name);

  return {
    order,
    kind: kindOf(label),
    title: title || (order != null ? `${labelFor(label, "Chapter")} ${order}` : prettify(folderName)),
    untitled: title === "",
  };
}

/**
 * Parse a module folder name into `{ order, suffix, title }`.
 * `module 1 hc` sorts immediately after `module 1`.
 *
 * A folder with no leading number keeps its name and sorts last, so a `bonus`
 * folder doesn't silently disappear.
 */
export function parseModuleName(folderName) {
  const m = folderName.match(MODULE_NAME);
  if (!m) {
    return {
      order: Number.MAX_SAFE_INTEGER,
      suffix: "",
      title: prettify(folderName),
    };
  }

  const label = labelFor(m[1], "Module");
  const order = Number(m[2]);
  const suffix = m[3].trim();

  return {
    order,
    suffix,
    title: suffix ? `${label} ${order} · ${prettify(suffix)}` : `${label} ${order}`,
  };
}

/** URL-safe slug used to build ids. */
function slugify(text) {
  return (
    text
      .toLowerCase()
      .replace(/_epm$/i, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "item"
  );
}

/** Real sub-directories, skipping macOS/VCS noise and hidden folders. */
async function readDirs(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !IGNORED_DIRS.has(e.name) && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
}

/** The best subtitle file inside a lesson folder, preferring .srt. */
async function findSubtitleFile(lessonDir) {
  let entries;
  try {
    entries = await fs.readdir(lessonDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const files = entries.filter((e) => e.isFile() && !IGNORED_FILES.has(e.name)).map((e) => e.name);
  for (const ext of SUBTITLE_EXTENSIONS) {
    const match = files.find((f) => f.toLowerCase().endsWith(ext));
    if (match) return path.join(lessonDir, match);
  }
  return null;
}

/**
 * Scan one course directory into ordered modules.
 * Returns an empty module list when the folder isn't shaped like a course,
 * which is what the layout auto-detection keys off.
 */
async function scanOneCourse(courseDir, courseId) {
  const moduleNames = await readDirs(courseDir);

  const parsed = moduleNames
    .map((name) => ({ name, ...parseModuleName(name) }))
    .sort((a, b) => a.order - b.order || a.suffix.localeCompare(b.suffix));

  const modules = [];
  const lessons = [];
  const usedIds = new Set();

  for (const mod of parsed) {
    const moduleDir = path.join(courseDir, mod.name);
    const moduleId = slugify(mod.name);
    const lessonNames = await readDirs(moduleDir);

    const parsedLessons = lessonNames
      .map((name) => ({ name, ...parseLessonName(name) }))
      .sort(
        (a, b) =>
          (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9) ||
          (a.order ?? 1e9) - (b.order ?? 1e9) ||
          a.title.localeCompare(b.title)
      );

    const moduleLessons = [];

    for (const lesson of parsedLessons) {
      const filePath = await findSubtitleFile(path.join(moduleDir, lesson.name));
      if (!filePath) continue; // no subtitle file — nothing to index or show

      // Ids must be unique: two modules can each hold a `chapter-1` folder.
      let id = `${courseId}:${moduleId}--${slugify(lesson.name)}`;
      if (usedIds.has(id)) {
        let n = 2;
        while (usedIds.has(`${id}-${n}`)) n++;
        id = `${id}-${n}`;
      }
      usedIds.add(id);

      const entry = {
        id,
        courseId,
        moduleId,
        moduleTitle: mod.title,
        moduleOrder: mod.order,
        lessonOrder: lesson.order,
        kind: lesson.kind,
        title: lesson.title,
        untitled: lesson.untitled === true,
        // Absolute path resolved by us — never derived from client input.
        filePath: path.resolve(filePath),
        format: path.extname(filePath).slice(1).toLowerCase(),
        durationMs: null,
      };

      moduleLessons.push(entry);
      lessons.push(entry);
    }

    if (moduleLessons.length > 0) {
      modules.push({ id: moduleId, title: mod.title, order: mod.order, lessons: moduleLessons });
    }
  }

  return { modules, lessons };
}

/**
 * Optional overlay of human/generated titles for lessons whose folder name
 * carried none (e.g. `chapter-3_epm`). Written by scripts/generate-titles.js.
 * Absent by default; a malformed file is ignored rather than fatal.
 */
async function readTitleOverrides() {
  try {
    const raw = await fs.readFile(config.course.titlesFile, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Fill in `durationMs` for every lesson by reading its last cue.
 *
 * Measured on this corpus: 87 files parse in ~199ms cold and ~97ms warm, so
 * doing it at startup is cheap enough to leave on. Set SCAN_DURATIONS=false to
 * skip it if a much larger library ever makes that untrue.
 */
async function attachDurations(lessons) {
  await Promise.all(
    lessons.map(async (lesson) => {
      try {
        const cues = await readSubtitleFile(lesson.filePath);
        lesson.durationMs = cues.at(-1)?.endMs ?? null;
        lesson.cueCount = cues.length;
      } catch {
        lesson.durationMs = null; // unreadable file shouldn't break the catalog
      }
    })
  );
}

/**
 * Scan the configured root into courses.
 *
 * Layout detection: we try the single-course shape first. If it yields no
 * lessons, the root's children are treated as separate courses. A multi-course
 * root scanned as a single course finds nothing (the subtitle files sit one
 * level deeper), so the fallback is unambiguous.
 *
 * @param {string} [rootDir] defaults to `config.course.path`
 */
export async function scanCourses(rootDir = config.course.path) {
  let rootEntries;
  try {
    rootEntries = await readDirs(rootDir);
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error(
        `Course directory not found: ${rootDir}\n` +
          `Point COURSE_PATH at a folder containing your module folders, or at a ` +
          `parent folder of several courses.`
      );
    }
    throw err;
  }

  const courses = [];

  // --- attempt 1: the root is itself one course -----------------------------
  const singleId = slugify(config.course.name || path.basename(rootDir));
  const single = await scanOneCourse(rootDir, singleId);

  if (single.lessons.length > 0) {
    courses.push({
      id: singleId,
      title: config.course.name || prettify(path.basename(rootDir)),
      dir: rootDir,
      ...single,
    });
  } else {
    // --- attempt 2: each child folder is a course --------------------------
    for (const name of rootEntries) {
      const courseId = slugify(name);
      const scanned = await scanOneCourse(path.join(rootDir, name), courseId);
      if (scanned.lessons.length === 0) continue;

      courses.push({
        id: courseId,
        title: prettify(name),
        dir: path.join(rootDir, name),
        ...scanned,
      });
    }
  }

  const lessons = courses.flatMap((c) => c.lessons);

  // Apply title overrides before building the lookup maps.
  const overrides = await readTitleOverrides();
  for (const lesson of lessons) {
    const override = overrides[lesson.id];
    if (typeof override === "string" && override.trim() !== "") {
      lesson.title = override.trim();
      lesson.untitled = false;
    }
  }

  if (config.course.scanDurations) await attachDurations(lessons);

  const byId = new Map(lessons.map((l) => [l.id, l]));
  const byCourse = new Map(courses.map((c) => [c.id, c]));

  return { courses, lessons, byId, byCourse };
}

/**
 * Cached scan. The tree comes from a read-only folder that doesn't change while
 * the server runs, so scanning once keeps `/api/catalog` off the disk on every
 * page load. A failed scan is not cached, so fixing COURSE_PATH takes effect on
 * the next request without a restart.
 */
let cached = null;

export function getCourses() {
  if (!cached) {
    cached = scanCourses().catch((err) => {
      cached = null;
      throw err;
    });
  }
  return cached;
}

/** Discard the cached scan (used by tests and the ingest script). */
export function clearCourseCache() {
  cached = null;
}

/** Resolve a client-supplied lesson id to its trusted catalog entry, or null. */
export async function findLesson(lessonId) {
  if (typeof lessonId !== "string" || lessonId === "") return null;
  const { byId } = await getCourses();
  return byId.get(lessonId) ?? null;
}

/** Resolve a client-supplied course id, or null. Used to validate query scope. */
export async function findCourse(courseId) {
  if (typeof courseId !== "string" || courseId === "") return null;
  const { byCourse } = await getCourses();
  return byCourse.get(courseId) ?? null;
}

/** Light list for the course switcher — no module trees, no paths. */
export async function listCourses() {
  const { courses } = await getCourses();

  return courses.map((c) => ({
    id: c.id,
    title: c.title,
    totalModules: c.modules.length,
    totalLessons: c.lessons.length,
    durationMs: c.lessons.reduce((sum, l) => sum + (l.durationMs ?? 0), 0) || null,
  }));
}

/**
 * The module/lesson tree for one course, shaped for the UI.
 * No filesystem paths leak out.
 *
 * @param {string} [courseId] defaults to the first course
 */
export async function getCatalog(courseId) {
  const { courses } = await getCourses();
  const course = courseId ? courses.find((c) => c.id === courseId) : courses[0];
  if (!course) return null;

  return {
    courseId: course.id,
    courseTitle: course.title,
    totalModules: course.modules.length,
    totalLessons: course.lessons.length,
    modules: course.modules.map((m) => ({
      id: m.id,
      title: m.title,
      order: m.order,
      lessons: m.lessons.map((l) => ({
        id: l.id,
        title: l.title,
        order: l.lessonOrder,
        kind: l.kind,
        durationMs: l.durationMs,
      })),
    })),
  };
}

/**
 * Compact plain-text syllabus used as context for catalog questions
 * ("how many lessons in module 5?"). Roughly 1200 tokens for this course, so
 * handing the model the whole thing is cheaper than building a query language.
 */
export async function renderSyllabus(courseId) {
  const { courses } = await getCourses();
  const list = courseId ? courses.filter((c) => c.id === courseId) : courses;
  const lines = [];

  for (const course of list) {
    lines.push(`COURSE: ${course.title} (${course.lessons.length} lessons)`);
    for (const mod of course.modules) {
      lines.push(`  ${mod.title} — ${mod.lessons.length} lesson(s)`);
      for (const lesson of mod.lessons) {
        const badge = lesson.kind === "mini-project" ? " [mini-project]" : "";
        const mins = lesson.durationMs ? ` (${Math.round(lesson.durationMs / 60000)} min)` : "";
        lines.push(`    ${lesson.lessonOrder ?? "-"}. ${lesson.title}${badge}${mins}`);
      }
    }
  }

  return lines.join("\n");
}
