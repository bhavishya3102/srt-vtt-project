/**
 * Format milliseconds as a timecode. Hours appear only when the lesson is long
 * enough to need them, so most chips stay four characters wide.
 *
 * @example formatTimecode(262000)  // "04:22"
 * @example formatTimecode(3862000) // "1:04:22"
 */
export function formatTimecode(ms) {
  if (!Number.isFinite(ms)) return "--:--";

  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n) => String(n).padStart(2, "0");

  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/** Rounded lesson length for the rail: "12 min", "1h 04m". */
export function formatLength(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "";

  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} min`;

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${String(rest).padStart(2, "0")}m`;
}

/** How long an answer took: "840 ms" / "3.20 s". */
export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return "";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

/** Truncate on a word boundary. */
export function truncate(text, max) {
  if (!text || text.length <= max) return text ?? "";
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * Turn a retrieval-variant label into something readable. These come straight
 * from the backend's ranked-list labels.
 */
export function variantLabel(label) {
  const names = {
    rewritten: "Rewritten",
    stepBack: "Step-back",
    hyde: "HyDE",
    subQuery1: "Sub-query",
    subQuery2: "Sub-query 2",
  };
  return names[label] ?? label;
}
