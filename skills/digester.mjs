/**
 * KalKaro skill: Notes-Digester.
 *
 * Takes the messy notes file nobody wants to re-read and returns the
 * three things the user actually needs: what it says, what was decided,
 * and who owes what by when.
 *
 * QA hardening (defect #8): the old flow wrote the Summary in the same
 * call as the Decisions, and the summary cheerfully misstated one —
 * QA's notes had "Dark mode: OUT of v1" in the Decisions list while
 * the Summary said the group "agreed on the use of dark mode", and the
 * Decisions section then repeated all four action items. The flow is
 * now: decisions FIRST (they are the facts), action items second,
 * decisions de-duplicated against the action items, and the summary
 * written LAST with the settled decisions in front of the model — plus
 * a deterministic consistency pass that removes any summary sentence
 * claiming an OUT/dropped decision was adopted.
 */

import { chatText } from "../lib/model.mjs";

function decisionsPrompt(notesText) {
  return `Read these messy meeting notes and list ONLY the decisions — choices the group actually settled.

"""
${notesText.slice(0, 6000)}
"""

Output ONLY markdown bullet lines starting with "- ". Problems, open issues and tasks are NOT decisions. If something was decided AGAINST (dropped, rejected, out of scope), state that plainly in the bullet, e.g. "- Dark mode: OUT of v1". If the notes say someone WILL decide something later, or a choice is still open (e.g. two options with no pick), it is NOT a decision — leave it out. If no decision was made, output exactly: None recorded.`;
}

function actionsPrompt(notesText) {
  return `Read these messy meeting notes and extract ONLY the action items — the things specific people agreed to do.

"""
${notesText.slice(0, 6000)}
"""

Output ONLY markdown lines in this exact form, one per action:
- [ ] <who> — <what> (by <when, if the notes mention one>)

Rules: only actions the notes really assign to someone — do not invent tasks, people or dates. If a name is not given, use the role or "Someone". If there are no action items, output exactly: None recorded.`;
}

function summaryPrompt(notesText, decisionsList, extra = "") {
  return `You are the Notes-Digester skill of KalKaro. Below are messy, rambling notes the user has been putting off making sense of.

"""
${notesText.slice(0, 6000)}
"""

The decisions that were settled, already extracted from these notes — these are the facts:
${decisionsList}

Write a 2-3 sentence summary: what this was about and where things stand. Describe each decision EXACTLY as listed above: if a decision says something is OUT, dropped or rejected, say plainly that it was dropped — NEVER write that the group "agreed on", "will use" or "adopted" something the list marks as out. Do not list action items or who is doing what — the summary is prose only.${extra}

Output ONLY the summary sentences — no heading, no bullets.`;
}

/** Parse a decisions reply into bullet lines; null means "none recorded". */
function parseDecisionList(raw) {
  const text = String(raw || "");
  if (/none recorded/i.test(text) && !text.includes("- ")) return null;
  const bullets = text
    .split("\n")
    .map((l) => l.trim().replace(/^•\s*/, "- ").replace(/^- \[ \]\s*/, "- "))
    .filter((l) => l.startsWith("- "))
    // Content-free bullets ("- -", "- —") are not decisions: a reply of
    // bare dashes means the model found nothing, so the list is empty
    // and the brief must say "None recorded." (QA re-run nit.)
    .filter((l) => /[a-z0-9]/i.test(l.slice(2)));
  return bullets.length ? bullets.slice(0, 12) : null;
}

const tokenSet = (s) =>
  new Set(
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3)
  );

/**
 * Decisions must not repeat action items (QA defect #8): QA's brief
 * re-listed all four actions under the decisions. A decision bullet
 * whose words mostly match an action item's core (owner prefix aside)
 * is a task wearing a decision's clothes — drop it.
 */
export function dropActionDuplicates(decisions, actionLines) {
  if (!decisions || !actionLines.length) return decisions;
  const cores = actionLines.map((l) =>
    tokenSet(l.replace(/^- \[ \]\s*/, "").replace(/^[^-—]{1,40}—\s*/, ""))
  );
  return decisions.filter((d) => {
    // Strip a leading "Name:" owner prefix like the action cores get —
    // "- Priya: write the checklist" vs Priya's action item is the same
    // task, and the prefix tokens alone pushed one QA re-run bullet to
    // 0.57 overlap, just under the 0.6 bar.
    const dt = tokenSet(d.replace(/^- /, "").replace(/^[A-Z][A-Za-z]+:\s*/, ""));
    if (!dt.size) return true;
    return !cores.some((c) => {
      let hit = 0;
      for (const w of dt) if (c.has(w)) hit++;
      return hit / dt.size >= 0.6;
    });
  });
}

/**
 * Unresolved items are not decisions (QA re-run residual): the model
 * filed "Annual discount: 10% or 15% Nadia will decide" under Decisions
 * — the notes explicitly leave that choice open, so presenting it as
 * settled misleads the skim-reader the brief exists for. Deterministic
 * split: a bullet carrying an unresolved marker (someone WILL decide,
 * TBD, undecided, an either/or figure with no pick) is diverted to
 * Open questions; a stray section header ("- Who is doing what:")
 * the model sheds into the list is dropped outright.
 */
const UNRESOLVED_MARKER =
  /\b(will decide|to be decided|to decide|decide later|undecided|not (yet )?decided|no decision|tbd|pending decision|still open|open question|yet to decide)\b/i;
const EITHER_OR_FIGURE = /\b\d[\d.,]*\s*(?:%|percent)?\s+or\s+\d[\d.,]*\s*(?:%|percent)(?![a-z])/i;
const STRAY_HEADER = /^[^.!?]{1,40}:$/;

export function splitDecisions(decisions) {
  if (!decisions) return { settled: decisions, open: [] };
  const settled = [];
  const open = [];
  for (const d of decisions) {
    const body = d.replace(/^- /, "").trim();
    if (STRAY_HEADER.test(body)) continue;
    if (UNRESOLVED_MARKER.test(body) || EITHER_OR_FIGURE.test(body)) open.push(d);
    else settled.push(d);
  }
  return { settled: settled.length ? settled : null, open };
}

/** Summary sentences that claim an OPEN question was decided. */
export function openContradictions(summary, open) {
  if (!open || !open.length) return [];
  const subjects = open
    .map((d) => {
      const body = d.replace(/^- /, "");
      const subj = body.includes(":") ? body.split(":")[0] : body.split(/\s+/).slice(0, 3).join(" ");
      return subj
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 4);
    })
    .filter((tokens) => tokens.length);
  if (!subjects.length) return [];
  const CLAIM = /(decision was|was decided|decided|agreed|settled|finali[sz]ed)/i;
  const HEDGE = /(undecided|still open|open|pending|will decide|to decide|not decided)/i;
  return String(summary)
    .split(/(?<=[.!?])\s+/)
    .filter((s) => {
      const sl = s.toLowerCase();
      if (!CLAIM.test(sl) || HEDGE.test(sl)) return false;
      return subjects.some((tokens) => tokens.some((tok) => sl.includes(tok)));
    });
}

/** Subjects of decisions that REJECTED something ("Dark mode: OUT of v1"). */
function outDecisionSubjects(decisions) {
  if (!decisions) return [];
  return decisions
    .filter((d) => /\b(out of|dropped|rejected|not included|not in|removed|cut)\b/i.test(d) || /:\s*out\b/i.test(d))
    .map((d) => {
      const body = d.replace(/^- /, "");
      const subj = body.includes(":") ? body.split(":")[0] : body.split(/\s+/).slice(0, 3).join(" ");
      return subj
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 4);
    })
    .filter((tokens) => tokens.length);
}

const ADOPTION = /(agreed|decided|adopt|approv|will use|will include|using|use of|going with)/i;
const NEGATION = /(not|never|no longer|without|dropped|rejected|out of)/i;

/** Summary sentences that claim an OUT decision was adopted. */
export function contradictorySentences(summary, decisions) {
  const outs = outDecisionSubjects(decisions);
  if (!outs.length) return [];
  return String(summary)
    .split(/(?<=[.!?])\s+/)
    .filter((s) => {
      const sl = s.toLowerCase();
      if (NEGATION.test(sl) || !ADOPTION.test(sl)) return false;
      return outs.some((tokens) => tokens.some((tok) => sl.includes(tok)));
    });
}

function removeSentences(summary, bad) {
  const badSet = new Set(bad);
  return String(summary)
    .split(/(?<=[.!?])\s+/)
    .filter((s) => !badSet.has(s))
    .join(" ")
    .trim();
}

/**
 * Write the summary with the decisions in front of the model, then
 * verify it deterministically. A misstating sentence is removed; if
 * the whole summary misstates, one regeneration is tried; if it still
 * misstates, an honest removal note replaces it — a missing summary
 * is better than a wrong one in the most-read section of the brief.
 */
async function writeSummary(model, notesText, decisions, open = []) {
  const list =
    decisions && decisions.length
      ? decisions.map((d) => d.replace(/^- /, "")).join("; ")
      : "None recorded.";
  const openNote = open.length
    ? `\nThese points were raised but NOT decided — if you mention them, say plainly they are still open: ${open
        .map((d) => d.replace(/^- /, ""))
        .join("; ")}`
    : "";
  const flaws = (s) => [
    ...contradictorySentences(s, decisions),
    ...openContradictions(s, open),
  ];
  const clean = (s) => String(s || "").replace(/^##\s*Summary\s*/i, "").trim();
  let summary = clean(await chatText(model, summaryPrompt(notesText, list, openNote)));
  let bad = flaws(summary);
  if (!bad.length) return summary;
  const repaired = removeSentences(summary, bad);
  if (repaired && !flaws(repaired).length) return repaired;
  summary = clean(
    await chatText(
      model,
      summaryPrompt(
        notesText,
        list,
        openNote +
          "\nIMPORTANT: a previous summary misstated a decision. Describe each decision EXACTLY as listed, especially anything marked OUT or dropped, and never present an open point as decided."
      )
    )
  );
  bad = flaws(summary);
  if (!bad.length) return summary;
  const repaired2 = removeSentences(summary, bad);
  if (repaired2 && !flaws(repaired2).length) return repaired2;
  return "The model's summary misstated a decision and was removed — the Decisions and Action items below are the reliable record.";
}

/**
 * Digest raw notes into a clean markdown brief.
 *
 * Focused calls instead of one three-section call: a 1B model asked
 * for three sections reliably writes two and stops — and the section
 * it drops is always the action items, the part the user actually
 * needs. Order matters too: decisions and actions are extracted first
 * because the summary is written from them (see the header note).
 *
 * @param {string} model     local model tag
 * @param {string} notesText the full raw notes
 * @returns {Promise<string>} markdown: Summary / Decisions / Action items
 */
export async function digestNotes(model, notesText) {
  const decisions = parseDecisionList(await chatText(model, decisionsPrompt(notesText)));

  let actionsRaw = await chatText(model, actionsPrompt(notesText));
  if (!actionsRaw.includes("- [ ]") && !/none recorded/i.test(actionsRaw)) {
    // One pointed retry if the extraction came back in the wrong shape.
    actionsRaw = await chatText(model, actionsPrompt(notesText));
  }
  const noActions = /none recorded/i.test(actionsRaw) && !actionsRaw.includes("- [ ]");
  const items = noActions ? "None recorded." : dedupeItems(actionsRaw);
  const actionLines = noActions ? [] : items.split("\n").filter((l) => l.startsWith("- [ ]"));

  const { settled, open } = splitDecisions(decisions);
  const keptDecisions = dropActionDuplicates(settled, actionLines);
  const summary = await writeSummary(model, notesText, keptDecisions, open);
  const decisionsText =
    keptDecisions && keptDecisions.length ? keptDecisions.join("\n") : "None recorded.";
  const openSection = open.length ? `\n\n## Open questions\n${open.join("\n")}` : "";

  return `## Summary\n${summary}\n\n## Decisions\n${decisionsText}${openSection}\n\n## Action items\n${items}`;
}

/**
 * The extraction call can fall into a repetition loop (the same item
 * forty times until the token cap). Identical lines carry no extra
 * information, so collapse them — the model's words, minus the echo.
 */
function dedupeItems(actions) {
  const seen = new Set();
  const lines = [];
  for (const raw of actions.split("\n")) {
    let l = raw.trim();
    if (!l) continue;
    if (l.startsWith("- ") && !l.startsWith("- [ ]")) l = l.replace(/^- /, "- [ ] ");
    if (!l.startsWith("- [ ]")) continue;
    // Drop fragments ("- [ ] [") the model sheds when a generation
    // is cut short — a real item names a who and a what.
    const rest = l.replace(/^- \[ \]\s*/, "");
    if ((rest.match(/[a-z0-9]+/gi) || []).length < 2) continue;
    const key = l.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(l);
    if (lines.length >= 12) break;
  }
  return lines.length ? lines.join("\n") : "None recorded.";
}
