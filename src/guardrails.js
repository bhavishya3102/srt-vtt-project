/**
 * Redacts secrets from text before it leaves the process, and from model output
 * before it reaches the screen.
 *
 * Pure regex — no model call, so this costs nothing and runs on every query.
 *
 * THE RISK THAT MATTERS HERE is false positives, not false negatives. This app
 * is built entirely out of things that look like personal data:
 *
 *     00:00:06,420   subtitle timestamps — the whole point of the project
 *     #c3f53c        hex colours from the theme
 *     8081 0.0.0.0   ports and addresses, because the course teaches code
 *     1.2.3          version numbers
 *
 * A naive phone-number pattern eats every one of them. So the patterns below are
 * deliberately narrow: a missed secret is recoverable, but silently corrupting
 * timestamps would break the feature this app exists for. All four cases above
 * are pinned as negative tests.
 */

/**
 * Ordered so that broader patterns run after specific ones — a JWT should be
 * reported as a token, not chopped up by the long-hex rule.
 *
 * Each `pattern` must be a global regex.
 */
const RULES = [
  {
    type: "email",
    placeholder: "[email redacted]",
    pattern: /\b[\w.%+-]+@[\w-]+(?:\.[\w-]+)+\b/g,
  },
  {
    // OpenAI-style keys: sk-..., sk-proj-..., and friends.
    type: "api_key",
    placeholder: "[api key redacted]",
    pattern: /\b(?:sk|pk|rk)-(?:[A-Za-z0-9]+-)?[A-Za-z0-9_-]{16,}\b/g,
  },
  {
    // GitHub tokens (ghp_, gho_, ghs_, github_pat_) and Slack (xoxb-).
    type: "api_key",
    placeholder: "[api key redacted]",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
  },
  {
    // JWTs — three base64url segments. Matched before the generic hex rule.
    type: "token",
    placeholder: "[token redacted]",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    // `Authorization: Bearer xxx`, `api_key = xxx`, `password: xxx`.
    // The optional scheme word lets `Authorization: Bearer <token>` match on the
    // token rather than stopping at the word "Bearer".
    type: "credential",
    placeholder: "$1: [redacted]",
    pattern:
      /\b(bearer|authorization|api[_-]?key|apikey|access[_-]?token|secret|password|passwd|token)\b\s*[:=]\s*(?:(?:bearer|token)\s+)?["']?[^\s"',;]{8,}["']?/gi,
  },
  {
    // Long opaque hex/base64 blobs. 32 is the shortest length that is clearly a
    // digest rather than a colour, an id fragment, or a hash prefix in prose.
    // The lookbehind keeps `#c3f53c` and `#deadbeefdeadbeef...` out of scope.
    type: "token",
    placeholder: "[token redacted]",
    pattern: /(?<![#\w])[A-Fa-f0-9]{32,}(?![\w])/g,
  },
  {
    // Phone numbers, conservatively.
    //
    // A loose candidate is matched and then counted in `validate`, because the
    // digit-grouping rules are far easier to state in code than in a regex.
    //
    // `:` `,` and `.` are excluded from the separator class and from both
    // boundaries. That is what keeps the dangerous cases safe: in
    // `00:00:06,420` and `0.0.0.0` and `1.2.3`, the separators that would join
    // the short digit groups into a phone-length run are all disallowed.
    type: "phone",
    placeholder: "[phone redacted]",
    pattern: /(?<![\d.:,\-])\+?\d[\d ()-]{7,18}\d(?![\d.:,\-])/g,
    validate: (match) => {
      const digits = match.replace(/\D/g, "");
      // With a country code, accept the full international range. Without one,
      // insist on exactly 10 digits so years, ports and id runs don't qualify.
      return match.trimStart().startsWith("+")
        ? digits.length >= 10 && digits.length <= 15
        : digits.length === 10;
    },
  },
];

/**
 * Mask secrets in `text`.
 *
 * @param {string} text
 * @returns {{ text: string, found: Array<{ type: string, count: number }> }}
 */
export function maskPII(text) {
  if (typeof text !== "string" || text === "") return { text: text ?? "", found: [] };

  const counts = new Map();
  let masked = text;

  for (const rule of RULES) {
    // Reset lastIndex: these are module-level global regexes, reused per call.
    rule.pattern.lastIndex = 0;

    masked = masked.replace(rule.pattern, (match, group1) => {
      // A rule may match loosely and then decide in code — returning the match
      // untouched is how it declines.
      if (rule.validate && !rule.validate(match)) return match;

      counts.set(rule.type, (counts.get(rule.type) ?? 0) + 1);
      return rule.placeholder.includes("$1")
        ? rule.placeholder.replace("$1", group1)
        : rule.placeholder;
    });
  }

  return {
    text: masked,
    found: [...counts].map(([type, count]) => ({ type, count })),
  };
}

/** Total number of redactions, for the "1 secret masked" UI notice. */
export function countMasked(found) {
  return found.reduce((sum, f) => sum + f.count, 0);
}

/**
 * Human-readable summary of what was masked, e.g. "1 api key, 2 emails".
 * Used in the composer notice so the user knows what we changed.
 */
export function describeMasked(found) {
  const labels = {
    email: ["email", "emails"],
    api_key: ["API key", "API keys"],
    token: ["token", "tokens"],
    credential: ["credential", "credentials"],
    phone: ["phone number", "phone numbers"],
  };

  return found
    .map(({ type, count }) => {
      const [one, many] = labels[type] ?? [type, `${type}s`];
      return `${count} ${count === 1 ? one : many}`;
    })
    .join(", ");
}
