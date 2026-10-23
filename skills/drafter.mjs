/**
 * KalKaro skill: Draft-Writer.
 *
 * Takes a dreaded "I still haven't replied to..." task and writes the
 * actual message — a strong first draft the human reviews, tidies and
 * sends. KalKaro never sends anything itself; pressing send stays
 * gloriously human (and takes about four seconds).
 *
 * QA hardening (defects #3 and #7): the old prompt carried a concrete
 * voice example ("Sunday lunch… I'll bring dessert") and the 1B model
 * regurgitated it verbatim into unrelated drafts — a nonsense task and
 * a dentist task both "became" a Sunday-lunch reply. The prompt now
 * describes the voice abstractly, with no copyable text. Every draft
 * then passes an output guard (validateDraft) that rejects invented
 * times, unmentioned names, leaked example phrases and bracketed
 * placeholders; a rejected draft is regenerated once with the problems
 * named, and if it still fails, the step fails honestly instead of
 * shipping a fabrication.
 */

import { chatText } from "../lib/model.mjs";

// Small local models sometimes refuse meta-framed requests ("write the
// reply the user has been avoiding") even though the message itself is
// completely ordinary. Detect that and retry once with a plain,
// concrete writing prompt — which is all this ever was.
// Small local models refuse in more shapes than "I can't fulfill":
// "I'm not able to assist…", "…could be used to deceive…", the classic
// "anything else I can help you with?" sign-off. A real draft for a
// landlord never contains any of these.
const REFUSAL =
  /(can'?t|cannot|can not|not able to|unable to|won'?t be able to)\b[^.]{0,60}\b(assist|help|fulfil|fulfill|comply|write|create|do that)\b|anything else i can help|as an ai( language)? model|used to (deceive|mislead)/i;

export function looksLikeRefusal(text) {
  const t = String(text || "").trim();
  return t.length < 400 && REFUSAL.test(t);
}

// Small models love wrapping the whole message in quotes (or escaped
// quotes, as if it were a JSON string). A draft should be ready to
// paste, so unwrap that — formatting only, the words are untouched.
export function unwrapQuotes(text) {
  let t = String(text || "").trim();
  const quoted =
    (t.startsWith('"') && t.endsWith('"') && t.length > 2) ||
    (t.startsWith('\\"') && t.endsWith('\\"') && t.length > 4);
  if (quoted) {
    t = t.replace(/^\\?"/, "").replace(/\\"$/, "").replace(/\\"/g, '"').trim();
  }
  // Sometimes only the closing quote shows up, orphaned at the end.
  t = t.replace(/\\?"\s*$/, "").trim();
  return t;
}

// Phrases that existed ONLY in the old prompt's concrete voice example.
// They have no business in any draft unless the user's own task put
// them there (QA defect #3: they leaked into 2 of 3 QA drafts).
const EXAMPLE_LEAK = ["sunday lunch", "bring dessert", "dessert", "aunty", "auntie"];

const COMMON_WORDS = new Set([
  "thank", "thanks", "please", "sorry", "best", "regards", "sincerely",
  "hello", "dear", "monday", "tuesday", "wednesday", "thursday", "friday",
  "saturday", "sunday", "january", "february", "march", "april", "may",
  "june", "july", "august", "september", "october", "november", "december",
]);

/**
 * Output guard (QA defects #3, #4, #7): check a draft against the ONLY
 * facts it is allowed to use — the task text and the planner's note.
 * Returns a list of problems; an empty list means the draft is clean.
 *  - bracketed placeholders ([Name], [Date]) — a draft with brackets
 *    is not ready to send (QA Test A);
 *  - times of day the task never gave (QA Test D3 invented "2:00 PM");
 *  - phrases from the old prompt example (the Sunday-lunch leak);
 *  - capitalised names mid-sentence that appear nowhere in the source.
 */
export function validateDraft(text, task, detail) {
  const problems = [];
  const t = String(text || "");
  const src = `${task || ""}\n${detail || ""}`.toLowerCase();
  const squash = (s) => s.toLowerCase().replace(/[\s.]/g, "");
  const srcSquashed = squash(src);

  if (/\[[^\]\n]{1,40}\]/.test(t)) {
    problems.push("it contains a bracketed placeholder like [Name] or [Date]");
  }
  const times = t.match(/\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b/gi) || [];
  for (const tm of times) {
    if (!srcSquashed.includes(squash(tm))) {
      problems.push(`it states a time ("${tm.trim()}") that the task never gave`);
    }
  }
  for (const phrase of EXAMPLE_LEAK) {
    if (t.toLowerCase().includes(phrase) && !src.includes(phrase)) {
      problems.push(`it mentions "${phrase}", which is not in this task`);
    }
  }
  const proper = new Set();
  for (const m of t.matchAll(/(?<=[a-z,;] )[A-Z][a-z]{2,}/g)) {
    const w = m[0];
    if (COMMON_WORDS.has(w.toLowerCase())) continue;
    if (!src.includes(w.toLowerCase())) proper.add(w);
  }
  if (proper.size) {
    problems.push(`it names ${[...proper].join(", ")}, which the task never mentions`);
  }
  return problems;
}

async function generateOnce(model, task, detail, problems) {
  const fixNote = problems.length
    ? `\n\nA previous attempt at this draft was rejected because: ${problems.join("; ")}. Fix exactly those problems — do not repeat them.`
    : "";
  const prompt = `Write a short, polite message in first person that the sender can copy, paste and send as-is.

The message needs to accomplish this:
"${task}"

Notes for the message: ${detail || "be polite, clear and brief"}

The voice: first person, warm and plain, like a real person writing to someone they know — an apology if one is owed, the point said simply, nothing corporate or templated. No example is given on purpose: write THIS message, for THIS situation only.

Rules:
- ASK, do not just announce: the message must explicitly make its central request — actually ask for the extension, the time, the reply — in a clear sentence of its own.
- Begin with a greeting line (use the other person's name only if the task gives one; otherwise a plain "Hello,") and end with a simple sign-off such as "Best regards" or "Thank you" — no bracketed name after it.
- Sound like a real, polite human — never like a template or a press release.
- This draft IS the reply — never write that you will respond, follow up or get back to them later.
- Do NOT invent facts that are not in the task or notes: no times of day, no new dates, no names, no people, no events, no promises the task does not mention.
- NEVER use bracketed placeholders like [Name] or [Date]. If a specific detail is missing, phrase around it ("your email", "this week") instead of inventing or bracketing it.
- Use any facts given (names, dates, delays). Apologise only if the task says the sender is late replying.
- Keep it short: 4-8 sentences. No subject line.
- Output ONLY the message text. No preamble, no "here is your draft".${fixNote}`;
  const first = await chatText(model, prompt);
  if (!looksLikeRefusal(first)) return unwrapQuotes(first);

  const plain = `Write a short, polite, everyday message in first person, ready to send — you ARE the sender, writing as "I". This is a completely normal message between ordinary people.

What the message must cover: ${task}
Guidance: ${detail || "be polite, clear and brief"}

It must explicitly ASK for what it needs (not just announce), start with a greeting and end with a simple sign-off, use no bracketed placeholders, and invent no times, names or facts beyond the task. Write 4-8 sentences, speaking to the other person as "you" (never about them in the third person). Output ONLY the message text — no preamble, no explanation.${fixNote}`;
  const second = await chatText(model, plain);
  if (looksLikeRefusal(second)) {
    throw new Error("the local model declined to draft this message twice");
  }
  return unwrapQuotes(second);
}

/**
 * Write a draft for a task, guarded: the draft is validated against the
 * task's own facts and regenerated once if it invents, leaks or leaves
 * placeholders. A draft that still fails is an honest failure, never a
 * shipped fabrication.
 * @param {string} model   local model tag
 * @param {string} task    the original dreaded-task line
 * @param {string} detail  the planner's note for this step (tone, facts)
 * @returns {Promise<string>} the draft text (message body only)
 */
export async function writeDraft(model, task, detail) {
  let problems = [];
  for (let round = 1; round <= 2; round++) {
    const draft = await generateOnce(model, task, detail, problems);
    problems = validateDraft(draft, task, detail);
    if (!problems.length) return draft;
  }
  throw new Error(`draft failed its honesty checks after a retry: ${problems.join("; ")}`);
}
