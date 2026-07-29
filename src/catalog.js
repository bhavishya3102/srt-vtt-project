import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

/**
 * Builds the course tree from the subtitle folder on disk.
 *
 * The folder names are the raw export from the course platform, so they are
 * inconsistent — `01_what-is-mobile-development_epm`, `chapter-3_epm`,
 * `mini-project-1-init-project-setup_epm`, `4. expo file system_epm`. This
 * module turns that into ordered modules and readable lesson titles.
 *
 * SECURITY: lesson ids are looked up in a Map built by scanning the course
 * directory — a client-supplied id is never joined into a path. That makes
 * path traversal structurally impossible rather than something we filter for.
 */

/** Folders macOS adds to zip exports; they contain no real content. */
const IGNORED_DIRS = new Set(["__MACOSX", ".git", "node_modules"]);
const IGNORED_FILES = new Set([".DS_Store"]);

/** Subtitle extensions, in the order we prefer to read them. */
const SUBTITLE_EXTENSIONS = [".srt", ".vtt"];

/**
 * Words that should keep a fixed casing when we title-case a folder name.
 * Without this, `eas-update` renders as "Eas Update" and `expo-sqllite` as
 * "Expo Sqllite", which looks careless in a course syllabus.
 */
const ACRONYMS = new Map(
  Object.entries({
    api: "API",
    apis: "APIs",
    crud: "CRUD",
    eas: "EAS",
    env: "env",
    hc: "HC",
    io: "IO",
    iot: "IoT",
    ios: "iOS",
    js: "JS",
    json: "JSON",
    oauth: "OAuth",
    sdk: "SDK",
    sqlite: "SQLite",
    sqllite: "SQLite",
    ui: "UI",
    url: "URL",
    urls: "URLs",
    ux: "UX",
  })
);

/** Small words that stay lowercase inside a title (never at the start). */
const MINOR_WORDS = new Set(["a", "an", "and", "the", "of", "in", "on", "to", "vs", "for", "with", "your"]);

/**
 * Leading ordinal patterns seen in the export, e.g. `chapter-2-`, `01_`,
 * `4. `, `mini-project-1-`, `10-`. Captures the label and the number so a
 * lesson with no title left over can still be called "Chapter 3".
 */
const ORDINAL_PREFIX = /^(chapter|mini[-\s]?project|lesson|part|section)?[-_.\s]*(\d{1,3})\s*[-_.)\s]+/i;

/** Same, but for a folder that is *only* an ordinal, e.g. `chapter-3`. */
const ORDINAL_ONLY = /^(chapter|mini[-\s]?project|lesson|part|section)?[-_.\s]*(\d{1,3})$/i;

/** Normalise the label captured by the ordinal patterns for display. */
function labelFor(rawLabel) {
  if (!rawLabel) return "Lesson";
  const compact = rawLabel.toLowerCase().replace(/[\s_]+/g, "-");
  if (compact === "mini-project") return "Mini-project";
  return compact.charAt(0).toUpperCase() + compact.slice(1);
}

/**
 * Make a raw folder name presentable.
 *
 * Words that already carry capitals are left untouched — a lot of the folders
 * are written properly ("Bring Native Maps Into Your App") and re-casing them
 * would only do damage. Only all-lowercase words get title-cased.
 */
function titleCase(text) {
  const words = text.split(/\s+/).filter(Boolean);

  return words
    .map((word, i) => {
      const bare = word.toLowerCase().replace(/[^a-z0-9]/g, "");
      const acronym = ACRONYMS.get(bare);
      if (acronym) return word.replace(/[a-z0-9]+/i, acronym);

      // Respect existing capitalisation (e.g. "Expo", "TextInput", "OAuth").
      if (word !== word.toLowerCase()) return word;

      if (i > 0 && MINOR_WORDS.has(bare)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

/**
 * Turn a lesson folder name into `{ order, title }`.
 *
 * @example "01_what-is-mobile-development_epm" -> { order: 1, title: "What Is Mobile Development" }
 * @example "chapter-3_epm"                     -> { order: 3, title: "Chapter 3" }
 */
export function parseLessonName(folderName) {
  // `_epm` is the course platform's suffix on every folder; it means nothing here.
  let name = folderName.replace(/_epm$/i, "").trim();

  const onlyOrdinal = name.match(ORDINAL_ONLY);
  if (onlyOrdinal) {
    const order = Number(onlyOrdinal[2]);
    return { order, title: `${labelFor(onlyOrdinal[1])} ${order}` };
  }

  let order = null;
  let label = null;
  const prefix = name.match(ORDINAL_PREFIX);
  if (prefix) {
    label = prefix[1];
    order = Number(prefix[2]);
    name = name.slice(prefix[0].length);
  }

  // Separators -> spaces, but keep the ones inside bracketed component lists.
  const title = titleCase(name.replace(/[_]+/g, " ").replace(/-+/g, " ").replace(/\s+/g, " ").trim());

  return {
    order,
    title: title || (order != null ? `${labelFor(label)} ${order}` : folderName),
  };
}

/**
 * Turn a module folder name into `{ order, suffix, title }`.
 * `module 1 hc` sorts immediately after `module 1`.
 */
export function parseModuleName(folderName) {
  const m = folderName.match(/^module\s*(\d{1,3})\s*(.*)$/i);
  if (!m) return { order: Number.MAX_SAFE_INTEGER, suffix: folderName, title: titleCase(folderName) };

  const order = Number(m[1]);
  const suffix = m[2].trim();
  return {
    order,
    suffix,
    title: suffix ? `Module ${order} · ${titleCase(suffix)}` : `Module ${order}`,
  };
}

/** URL-safe slug used to build lesson ids. */
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

/** List real sub-directories, skipping the macOS/VCS noise. */
async function readDirs(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !IGNORED_DIRS.has(e.name) && !e.name.startsWith("."))
    .map((e) => e.name);
}

/** Find the best subtitle file inside a lesson folder, preferring .srt. */
async function findSubtitleFile(lessonDir) {
  const entries = await fs.readdir(lessonDir, { withFileTypes: true });
  const files = entries.filter((e) => e.isFile() && !IGNORED_FILES.has(e.name)).map((e) => e.name);

  for (const ext of SUBTITLE_EXTENSIONS) {
    const match = files.find((f) => f.toLowerCase().endsWith(ext));
    if (match) return path.join(lessonDir, match);
  }
  return null;
}

/**
 * Scan the course directory into an ordered tree.
 *
 * @param {string} [rootDir] defaults to `config.course.path`
 * @returns {Promise<{ modules: Array, lessons: Array, byId: Map<string, object> }>}
 */
export async function scanCourse(rootDir = config.course.path) {
  let moduleDirs;
  try {
    moduleDirs = await readDirs(rootDir);
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error(
        `Course directory not found: ${rootDir}\n` +
          `Set COURSE_PATH in .env to the folder containing your "module N" subtitle folders.`
      );
    }
    throw err;
  }

  const parsedModules = moduleDirs
    .map((name) => ({ name, ...parseModuleName(name) }))
    .sort((a, b) => a.order - b.order || a.suffix.localeCompare(b.suffix));

  const modules = [];
  const lessons = [];
  const byId = new Map();
  const usedIds = new Set();

  for (const mod of parsedModules) {
    const moduleDir = path.join(rootDir, mod.name);
    const moduleId = slugify(mod.name);

    const lessonDirs = await readDirs(moduleDir);
    const parsedLessons = lessonDirs
      .map((name) => ({ name, ...parseLessonName(name) }))
      // Folders without a leading number keep their on-disk order at the end.
      .sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || a.title.localeCompare(b.title));

    const moduleLessons = [];

    for (const lesson of parsedLessons) {
      const lessonDir = path.join(moduleDir, lesson.name);
      const filePath = await findSubtitleFile(lessonDir);
      if (!filePath) continue; // folder with no subtitle file — nothing to index

      // Ids must be unique: two modules can hold a `chapter-1` folder.
      let id = `${moduleId}--${slugify(lesson.name)}`;
      if (usedIds.has(id)) {
        let n = 2;
        while (usedIds.has(`${id}-${n}`)) n++;
        id = `${id}-${n}`;
      }
      usedIds.add(id);

      const entry = {
        id,
        moduleId,
        moduleTitle: mod.title,
        moduleOrder: mod.order,
        lessonOrder: lesson.order,
        title: lesson.title,
        // Absolute path, resolved by us — never derived from client input.
        filePath: path.resolve(filePath),
        format: path.extname(filePath).slice(1).toLowerCase(),
      };

      moduleLessons.push(entry);
      lessons.push(entry);
      byId.set(id, entry);
    }

    if (moduleLessons.length > 0) {
      modules.push({
        id: moduleId,
        title: mod.title,
        order: mod.order,
        lessons: moduleLessons,
      });
    }
  }

  return { modules, lessons, byId };
}

/**
 * Cached course scan. The tree is derived from a read-only folder that doesn't
 * change while the server runs, so scanning once is enough — and it keeps
 * `/api/catalog` from hitting the disk on every page load.
 *
 * A failed scan is not cached, so a fixed COURSE_PATH takes effect on retry.
 */
let cached = null;

export function getCourse() {
  if (!cached) {
    cached = scanCourse().catch((err) => {
      cached = null;
      throw err;
    });
  }
  return cached;
}

/** Resolve a client-supplied lesson id to its trusted catalog entry, or null. */
export async function findLesson(lessonId) {
  if (typeof lessonId !== "string" || lessonId === "") return null;
  const { byId } = await getCourse();
  return byId.get(lessonId) ?? null;
}

/** The module/lesson tree shaped for the UI — no filesystem paths leak out. */
export async function getCatalog() {
  const { modules, lessons } = await getCourse();

  return {
    totalModules: modules.length,
    totalLessons: lessons.length,
    modules: modules.map((m) => ({
      id: m.id,
      title: m.title,
      order: m.order,
      lessons: m.lessons.map((l) => ({ id: l.id, title: l.title, order: l.lessonOrder })),
    })),
  };
}
