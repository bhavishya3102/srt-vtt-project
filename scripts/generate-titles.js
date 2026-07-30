#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { getCourses } from "../src/catalog.js";
import { readSubtitleFile } from "../src/subtitles.js";
import { chatJSON } from "../src/openai.js";
import { config } from "../src/config.js";

/**
 * Derives titles for lessons whose folder name carried none.
 *
 * A handful of folders in a platform export are named only `chapter-3_epm`,
 * which leaves the rail showing "Chapter 1, Chapter 2, Chapter 3" — technically
 * accurate and completely useless. This reads the opening of each such
 * transcript and asks the model what the lesson is actually about.
 *
 * Opt-in and idempotent. Output goes to data/lesson-titles.json, which the
 * catalog overlays when present; delete the file to go back to the folder names.
 *
 *   npm run titles:generate
 *   npm run titles:generate -- --all      re-title every lesson, not just untitled
 *   npm run titles:generate -- --dry-run  print, don't write
 */

/** Cues to read before deciding. Enough to hear the intro, not the whole lesson. */
const OPENING_CUES = 40;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: {
      type: "string",
      description:
        "A short, specific lesson title in Title Case, 3-8 words, naming the actual topic. No lesson numbers, no trailing punctuation, no quotes.",
    },
  },
  required: ["title"],
};

const SYSTEM = `You name lessons in a mobile app development course (Expo / React Native).

Given the opening lines of a lesson's transcript, write the title that lesson should have: short, specific, Title Case, 3-8 words. Name the concrete topic — "Configuring EAS Build Profiles", not "Advanced Concepts".

The transcript is an auto-generated subtitle file, so expect mangled words ("dot tsx" is ".tsx"). Never include a lesson or chapter number. Never add punctuation at the end.`;

function parseArgs(argv) {
  return {
    all: argv.includes("--all"),
    dryRun: argv.includes("--dry-run"),
    help: argv.includes("--help") || argv.includes("-h"),
  };
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));

  if (flags.help) {
    console.log(`
Derive titles for lessons whose folder name has none.

  --all       re-title every lesson, not only the untitled ones
  --dry-run   print the results without writing the file
  --help      this message
`);
    return;
  }

  if (!config.openai.apiKey) {
    console.error("❌ OPENAI_API_KEY is not set. Copy .env.example to .env and add your key.");
    process.exit(1);
  }

  const { lessons } = await getCourses();
  const targets = flags.all ? lessons : lessons.filter((l) => l.untitled);

  if (targets.length === 0) {
    console.log("✅ Every lesson already has a real title — nothing to do.");
    return;
  }

  console.log(`📝 Naming ${targets.length} lesson(s)…\n`);

  // Start from whatever is already on disk so a partial run isn't lost.
  let existing = {};
  try {
    existing = JSON.parse(await fs.readFile(config.course.titlesFile, "utf8"));
  } catch {
    /* first run */
  }

  const titles = { ...existing };
  let failures = 0;

  for (const lesson of targets) {
    try {
      const cues = await readSubtitleFile(lesson.filePath);
      const opening = cues
        .slice(0, OPENING_CUES)
        .map((c) => c.text)
        .join(" ");

      if (opening.trim() === "") throw new Error("transcript is empty");

      const { title } = await chatJSON({
        name: "lesson_title",
        schema: SCHEMA,
        system: SYSTEM,
        user: `MODULE: ${lesson.moduleTitle}\n\nOPENING OF THE TRANSCRIPT:\n${opening}`,
        temperature: 0.3,
      });

      const clean = title.trim().replace(/[.]+$/, "");
      titles[lesson.id] = clean;
      console.log(`  ${lesson.moduleTitle} · ${lesson.title}\n    → ${clean}\n`);
    } catch (err) {
      failures++;
      console.error(`  ✗ ${lesson.title}: ${err.message}\n`);
    }
  }

  if (flags.dryRun) {
    console.log("(--dry-run: nothing written)");
    return;
  }

  await fs.mkdir(path.dirname(config.course.titlesFile), { recursive: true });
  await fs.writeFile(config.course.titlesFile, `${JSON.stringify(titles, null, 2)}\n`, "utf8");

  console.log(`✅ Wrote ${Object.keys(titles).length} title(s) to ${config.course.titlesFile}`);
  if (failures > 0) console.log(`   ${failures} failed — re-run to retry just those.`);
  console.log("   Restart the API to pick them up.");
}

try {
  await main();
  process.exit(0);
} catch (err) {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
}
