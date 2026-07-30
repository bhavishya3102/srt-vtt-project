import OpenAI from "openai";
import { config, assertOpenAIKey } from "./config.js";

// Shared OpenAI client used for both embeddings and chat completions.
export const openai = new OpenAI({ apiKey: config.openai.apiKey });

/** Create an embedding vector for a single piece of text. */
export async function embedText(text) {
  assertOpenAIKey();
  const res = await openai.embeddings.create({
    model: config.openai.embeddingModel,
    input: text,
  });
  return res.data[0].embedding;
}

/** Create embeddings for many texts (batched to stay within limits). */
export async function embedTexts(texts, batchSize = 100) {
  if (texts.length === 0) return [];
  assertOpenAIKey();

  const vectors = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const res = await openai.embeddings.create({
      model: config.openai.embeddingModel,
      input: batch,
    });
    for (const item of res.data) vectors.push(item.embedding);
  }
  return vectors;
}

/**
 * Chat completion constrained to a JSON schema.
 *
 * Structured output beats parsing markers out of prose: the model cannot return
 * a shape we didn't ask for, and the API retries internally on a mismatch. Used
 * for query classification, query rewriting and answer generation alike.
 *
 * @param {{ name: string, schema: object, system: string, user: string,
 *           temperature?: number, model?: string }} options
 * @returns {Promise<object>} the parsed object, never a string
 */
export async function chatJSON({ name, schema, system, user, temperature = 0.2, model }) {
  assertOpenAIKey();

  const completion = await openai.chat.completions.create({
    model: model ?? config.openai.chatModel,
    temperature,
    response_format: {
      type: "json_schema",
      json_schema: { name, strict: true, schema },
    },
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) throw new Error(`Model returned no content for "${name}"`);

  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Model returned invalid JSON for "${name}": ${err.message}`);
  }
}

/** Plain-text chat completion, for the one place we want prose (HyDE). */
export async function chatText({ system, user, temperature = 0.3, model }) {
  assertOpenAIKey();

  const completion = await openai.chat.completions.create({
    model: model ?? config.openai.chatModel,
    temperature,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  return completion.choices[0]?.message?.content?.trim() ?? "";
}
