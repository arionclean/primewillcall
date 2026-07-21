/**
 * Turn a customer's SMS reply to the "rate us 1-5" ask into a rating.
 *
 * Deterministic parse first, model only as a fallback. Almost every reply is
 * literally "5", so the parser handles the common case for free and the model
 * is never called. Same shape as the voucher vision chain (deterministic match
 * first, Groq second).
 *
 * Ported from Xano fn 269 "analyze inbound message_v2", which sent every reply
 * to gpt-4o-mini. The rule it encoded, and that we keep: a message saying the
 * tour was great with no downsides counts as a 5.
 *
 * Without GROQ_API_KEY the fallback is skipped and non-numeric replies come
 * back "unclear", which the funnel treats as "record it, send nothing".
 */

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_TEXT_MODEL = "openai/gpt-oss-120b";

export type RatingClassification =
  | { kind: "rating"; rating: number; via: "parser" | "model" }
  | { kind: "unclear"; via: "parser" | "model" };

const WORD_NUMBERS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
};

/**
 * Matches only unambiguous ratings: "5", "5!", "5/5", "5 stars", "five".
 * Anything chattier ("4 of us had a blast") deliberately falls through to the
 * model rather than risk reading a pax count as a rating.
 */
export function parseRating(body: string): number | null {
  const text = body.trim().toLowerCase().replace(/\s+/g, " ");

  const numeric = text.match(/^([1-5])\s*(?:\/\s*5)?\s*(?:stars?|\*+)?\s*[.!]*$/);
  if (numeric) {
    return Number(numeric[1]);
  }

  const word = text.match(/^(one|two|three|four|five)\s*(?:stars?)?\s*[.!]*$/);
  if (word) {
    return WORD_NUMBERS[word[1]] ?? null;
  }

  return null;
}

async function classifyWithGroq(body: string): Promise<number | null> {
  const key = process.env.GROQ_API_KEY ?? "";
  if (!key) {
    return null;
  }

  try {
    const response = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: GROQ_TEXT_MODEL,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              'A tour company asked a customer: "How would you rate the tour from 1 to 5, ' +
              '5 being excellent?" Classify the customer reply as a rating from 1 to 5. ' +
              "If they say it was great, perfect or amazing and mention no downsides, that is a 5. " +
              "If the reply carries no opinion about the tour at all (a question, a greeting, " +
              "an unrelated message), it has no rating. " +
              'Respond only as JSON: {"rating": <integer 1-5, or null>}.',
          },
          { role: "user", content: body },
        ],
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      console.error("Review classifier: Groq returned", response.status);
      return null;
    }

    const json = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = json.choices?.[0]?.message?.content;
    if (!content) {
      return null;
    }

    const parsed = JSON.parse(content) as { rating?: unknown };
    const rating = Number(parsed.rating);
    return Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : null;
  } catch (error) {
    // Never let the classifier break the inbound webhook.
    console.error("Review classifier failed:", error instanceof Error ? error.message : error);
    return null;
  }
}

export async function classifyRating(body: string): Promise<RatingClassification> {
  const parsed = parseRating(body);
  if (parsed !== null) {
    return { kind: "rating", rating: parsed, via: "parser" };
  }

  const modelled = await classifyWithGroq(body);
  if (modelled !== null) {
    return { kind: "rating", rating: modelled, via: "model" };
  }

  return { kind: "unclear", via: "model" };
}
