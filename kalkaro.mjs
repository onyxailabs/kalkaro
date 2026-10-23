#!/usr/bin/env node
/**
 * KalKaro — "kal karo" is Urdu/Hindi for "do it tomorrow".
 *
 * Everyone has a list of tasks they keep saying that to: the reply that is
 * six days late, the Downloads folder that has become an archaeological
 * site, the meeting notes nobody has made sense of. KalKaro takes that
 * list, breaks every task into micro-steps with a local open-weight model,
 * and then *does* the machine-doable steps itself — it drafts the reply,
 * files the folder, digests the notes. What is left for the human is one
 * tiny step per task: press send, glance at a summary, pick a time.
 *
 * 100% local: Ollama + Llama 3.2 1B on your own machine. No cloud, no API
 * keys, no subscription, and your dreaded tasks never leave your disk.
 *
 * Usage:
 *   node kalkaro.mjs tasks.txt [--apply] [--out DIR] [--model TAG]
 *                      [--folder DIR] [--notes FILE]
 *
 *   tasks.txt   one dreaded task per line, in plain words
 *   --apply     let the Organizer actually move files (default: plan only)
 *   --folder    the messy folder Organizer steps should work on
 *   --notes     the messy notes file Digester steps should work on
 */

import fs from "node:fs";
import path from "node:path";
import { ensureModel, pickModel, chatJSON } from "./lib/model.mjs";
import { organizeFolder } from "./skills/organizer.mjs";
import { writeDraft } from "./skills/drafter.mjs";
import { digestNotes } from "./skills/digester.mjs";

// ---------- tiny helpers -------------------------------------------------

const fmtTime = (ms) => {
  const s = ms / 1000;
  if (s < 90) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
};
const now = () => Date.now();
const short = (t, n = 52) => (t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t);

// ---------- args ----------------------------------------------------------

function parseArgs(argv) {
  const args = { apply: false, out: "kalkaro-out", model: null, folder: null, notes: null, tasksFile: null };
  const rest = [...argv];
  while (rest.length) {
    const a = rest.shift();
    if (a === "--apply") args.apply = true;
    else if (a === "--out") args.out = rest.shift();
    else if (a === "--model") args.model = rest.shift();
    else if (a === "--folder") args.folder = rest.shift();
    else if (a === "--notes") args.notes = rest.shift();
    else if (a === "--help" || a === "-h") args.help = true;
    else if (!a.startsWith("--") && !args.tasksFile) args.tasksFile = a;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

// ---------- the planner ---------------------------------------------------

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    daysPostponed: { type: "number" },
    manualMinutes: { type: "number" },
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          owner: { type: "string", enum: ["machine", "human"] },
          skill: { type: "string", enum: ["organizer", "drafter", "digester", "none"] },
          detail: { type: "string" },
          firstAction: { type: "string" },
        },
        required: ["title", "owner", "skill", "detail"],
      },
    },
  },
  required: ["steps"],
};

async function planTask(model, task) {
  const prompt = `You are the planner of KalKaro, an assistant that finishes the boring 90% of tasks people keep postponing.

The user has been putting off this task:
"${task}"

Machine skills you can assign (owner "machine"):
- "drafter": the task is really about replying to someone — it writes the actual ready-to-send message. In "detail", give the facts and tone the message needs (who it is to, what happened, any apology for being late).
- "organizer": the task is about a messy folder of files — it classifies, renames and sorts the files.
- "digester": the task is about messy notes — it produces a summary, the decisions, and the action items.
Any other step belongs to the human: owner "human", skill "none", and give "firstAction": the tiniest possible first move, something that takes under two minutes.

Break the task into 2-4 small steps. Machine steps do the heavy lifting; leave the human as little as possible.
Rules for assigning skills — follow them strictly:
- Assign "organizer" ONLY if the task explicitly mentions a folder or files. Assign "digester" ONLY if it explicitly mentions notes.
- A task about replying to someone needs exactly ONE "drafter" step — never two.
- EVERY task must end with exactly ONE human step (skill "none"): the tiny final action only a human can do, like pressing send.
Be BRIEF: every title under 6 words, every detail at most 10 words, every firstAction under 10 words. Never make one step per file or per item — one step per skill.
Output the JSON on ONE single line — no line breaks, no indentation.
Set daysPostponed to 0 — code computes the wait from the task text itself, because a planner's guess about "days" proved unreliable. manualMinutes = roughly how many minutes the human would need to do the WHOLE task by hand.
Reply with JSON only.`;
  // QA defect #1/#6: the planner gets a SMALLER token cap (a plan is a
  // few short steps, not an essay) and a HARD wall-clock timeout, with a
  // heartbeat so the user sees "still thinking…" instead of a frozen
  // terminal while a slow local model generates.
  return chatJSON(model, prompt, PLAN_SCHEMA, {
    numPredict: 800,
    timeoutMs: 150000,
    onHeartbeat: (ms) => console.log(`  … still thinking (${Math.round(ms / 1000)}s)`),
  });
}

/**
 * Deterministic fallback plan (QA defect #1). Planning is a means, not
 * the product: if the model cannot produce a usable plan for a task the
 * scope gate has already classified, the minimal plan is the one the
 * task's own words dictate — e.g. a folder task gets an Organizer-only
 * plan instead of failing the whole task.
 */
function fallbackPlan(task, covered) {
  const steps = [];
  if (covered.includes("organizer"))
    steps.push({ title: "Organise the folder", owner: "machine", skill: "organizer", detail: "Classify, rename and sort the files" });
  if (covered.includes("digester"))
    steps.push({ title: "Digest the notes", owner: "machine", skill: "digester", detail: "Turn the notes into a summary, decisions and action items" });
  if (covered.includes("drafter"))
    steps.push({ title: "Draft the reply", owner: "machine", skill: "drafter", detail: `Write the reply this task is about: ${task}` });
  return { steps, daysPostponed: 0, manualMinutes: null };
}

// ---------- routing guardrails -------------------------------------------
// A 1B planner is enthusiastic and sloppy: it assigns the Organizer to a
// notes task, or forgets the Digester entirely. So the model proposes,
// and plain deterministic rules — grounded in the user's own words —
// dispose. Visible in the transcript whenever they fire.

const mentionsNotes = (t) => /\bnotes?\b/i.test(t);
const mentionsFiles = (t) => /\b(folder|files?|downloads?|directory)\b/i.test(t);
const mentionsReply = (t) => /\b(reply|respond|answer|email|e-mail|message|write back|get back to|write|letter|apolog\w*|reach out)\b/i.test(t);

/**
 * Scope gate (QA defect #2): which skills could this task possibly
 * need, judged ONLY from the user's own words — deterministically,
 * before any model call. If the answer is "none", the task is either
 * outside KalKaro's three skills (it cannot book, call, buy or remind)
 * or too vague to classify ("do the thing with the stuff"), and the
 * honest outcome is prepared-only / can't-do — never a forced draft
 * reported as success.
 */
function taskCoverage(task) {
  return {
    organizer: mentionsFiles(task),
    digester: mentionsNotes(task),
    drafter: mentionsReply(task),
  };
}
const coveredSkills = (cov) => ["organizer", "drafter", "digester"].filter((s) => cov[s]);

function applyRoutingGuardrails(task, steps, log) {
  const out = [...steps];
  const has = (skill) => out.some((s) => s.owner === "machine" && s.skill === skill);
  // Drop skills the task never asked for.
  for (let i = out.length - 1; i >= 0; i--) {
    const s = out[i];
    if (s.owner !== "machine") continue;
    if (s.skill === "organizer" && !mentionsFiles(task)) {
      log(`  ⛨ guardrail: dropped an Organizer step — this task mentions no folder or files`);
      out.splice(i, 1);
    } else if (s.skill === "digester" && !mentionsNotes(task)) {
      log(`  ⛨ guardrail: dropped a Digester step — this task mentions no notes`);
      out.splice(i, 1);
    } else if (s.skill === "drafter" && !mentionsReply(task)) {
      log(`  ⛨ guardrail: dropped a Drafter step — this task asks for no reply or message`);
      out.splice(i, 1);
    }
  }
  // A notes task produces a digest, not a message — unless it also
  // explicitly asks for a reply, a Drafter step there is planner noise.
  if (mentionsNotes(task) && !mentionsReply(task)) {
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i].owner === "machine" && out[i].skill === "drafter") {
        log(`  ⛨ guardrail: dropped a Drafter step — a notes task needs a digest, not a message`);
        out.splice(i, 1);
      }
    }
  }
  // Add the skill the task clearly needs but the planner missed.
  if (mentionsNotes(task) && !has("digester")) {
    out.push({ title: "Digest the notes", owner: "machine", skill: "digester", detail: "Turn the notes into a summary, decisions and action items" });
    log(`  ⛨ guardrail: added the Digester step the planner missed`);
  }
  if (mentionsFiles(task) && !has("organizer")) {
    out.push({ title: "Organise the folder", owner: "machine", skill: "organizer", detail: "Classify, rename and sort the files" });
    log(`  ⛨ guardrail: added the Organizer step the planner missed`);
  }
  if (mentionsReply(task) && !has("drafter")) {
    out.push({ title: "Draft the reply", owner: "machine", skill: "drafter", detail: "Write the reply this task is about" });
    log(`  ⛨ guardrail: added the Drafter step the planner missed`);
  }
  return out;
}

/**
 * Days postponed — from the user's own words, and ONLY when the words
 * say the task itself has been waiting (QA defect #9). QA's Test A
 * ("my assignment will be 2 days late") was reported as "postponed ~2
 * days" because the old code grabbed any number near "days"; a
 * deliverable being late is not the task being postponed. The planner's
 * own estimate is not trusted for this either — code is the source.
 */
function daysFromText(task) {
  const patterns = [
    /(\d+)\s*days?\s+ago\b/i, // "his email came 6 days ago"
    /\bfor\s+(?:the\s+)?(?:past\s+)?(\d+)\s*days?\b/i, // "putting it off for 6 days"
    /\bpostpon\w*\s+(?:for\s+)?(\d+)\s*days?\b/i, // "postponed for 3 days"
    /(\d+)\s*days?\s+overdue\b/i, // "the reply is 4 days overdue"
    /\bwaiting\s+(?:for\s+)?(\d+)\s*days?\b/i, // "waiting 5 days"
  ];
  for (const re of patterns) {
    const m = task.match(re);
    if (m) return Number(m[1]);
  }
  if (/\ball week\b|\ba week\b/i.test(task)) return 7;
  return 0;
}

// ---------- main ----------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.tasksFile) {
    console.log(`KalKaro — does the boring 90% of your "kal karo" (do it tomorrow) tasks.

Usage: node kalkaro.mjs tasks.txt [--apply] [--out DIR] [--model TAG] [--folder DIR] [--notes FILE]`);
    process.exit(args.help ? 0 : 1);
  }

  const model = pickModel(args.model);
  await ensureModel(model);

  const tasks = fs
    .readFileSync(args.tasksFile, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  const OUT = path.resolve(args.out);
  const DRAFTS = path.join(OUT, "drafts");
  const DIGESTS = path.join(OUT, "digests");
  fs.mkdirSync(DRAFTS, { recursive: true });
  fs.mkdirSync(DIGESTS, { recursive: true });

  console.log(`KalKaro — ${tasks.length} dreaded task(s), model ${model}, 100% local.`);
  console.log(`Started ${new Date().toLocaleString()}\n`);

  const report = [];
  report.push(`# KalKaro — done-for-you report`);
  report.push(``);
  report.push(`Run: ${new Date().toLocaleString()} · Model: \`${model}\` (local, via Ollama) · Organizer mode: ${args.apply ? "applied (files moved)" : "plan only (dry run)"}`);
  report.push(``);

  const totals = { done: 0, prepared: 0, failed: 0, drafts: 0, filesFiled: 0 };
  const tableRows = [];
  let draftNo = 0;
  let digestNo = 0;

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const taskStart = now();
    console.log(`▸ Task ${i + 1}: ${task}`);

    // Scope gate first (QA defect #2): judged from the task's own words,
    // before any model call. A task no skill covers gets an honest
    // can't-do — nothing planned, nothing executed, nothing counted as
    // done. This also saves the minutes QA's nonsense task burned in
    // the planner before being force-fit to the Drafter.
    const coverage = taskCoverage(task);
    const covered = coveredSkills(coverage);
    const taskDays = daysFromText(task);

    if (!covered.length) {
      totals.prepared += 1;
      const agentTime = fmtTime(now() - taskStart);
      console.log(`  ⚠ prepared only — KalKaro can't do this one: no skill covers it`);
      report.push(`## ${i + 1}. ${task}`, ``);
      report.push(`Postponed: ${taskDays ? `~${taskDays} day(s)` : "not stated"} · Doing it by hand: no estimate · KalKaro took: ${agentTime} (measured)`);
      report.push(``);
      report.push(`### Done for you`);
      report.push(`- ⚠ **Prepared only — KalKaro can't do this one.** No skill covers it: KalKaro can draft a reply, file a folder, or digest notes, and this task needs none of those (or is too vague to tell). Nothing was executed for it, and it is not counted as done.`);
      report.push(``);
      report.push(`### Your tiny remaining step`);
      report.push(`- **Do this one by hand** — first move: start it yourself; KalKaro cannot help with this one`);
      report.push(``);
      tableRows.push({
        task,
        days: taskDays ? String(taskDays) : "—",
        manual: "—",
        agent: agentTime,
        left: "do it by hand — KalKaro can't do this one",
      });
      console.log(`  done in ${agentTime}\n`);
      continue;
    }

    let plan;
    try {
      const t0 = now();
      plan = await planTask(model, task);
      console.log(`  plan: ${(plan.steps || []).length} step(s) in ${fmtTime(now() - t0)}`);
    } catch (e) {
      // Deterministic fallback (QA defect #1): a failed plan no longer
      // fails the task. The scope gate already classified this task, so
      // the minimal honest plan is built from the task's own words.
      plan = fallbackPlan(task, covered);
      console.log(`  ⛨ planner failed (${e.message}) — deterministic fallback plan: ${covered.join(" + ")} only`);
    }

    let steps = Array.isArray(plan.steps) ? plan.steps : [];
    steps = applyRoutingGuardrails(task, steps, (m) => console.log(m));
    if (!steps.some((s) => s.owner === "machine" && covered.includes(s.skill))) {
      // The planner answered but left nothing executable for a task the
      // gate classified as covered — same fallback, same honesty.
      steps = [...fallbackPlan(task, covered).steps, ...steps.filter((s) => s.owner !== "machine")];
      console.log(`  ⛨ guardrail: plan had no executable step for a covered task — fallback step(s) used`);
    }
    plan.daysPostponed = taskDays;
    if (!(plan.manualMinutes >= 1)) plan.manualMinutes = null;
    for (const s of steps) {
      console.log(`  - [${s.owner}/${s.skill}] ${s.title || "(untitled step)"}`);
    }
    const doneLines = [];
    const humanSteps = [];
    const executedSkills = new Set();

    for (const step of steps) {
      const label = step.title || "(untitled step)";
      if (step.owner === "human" || step.skill === "none" && step.owner !== "machine") {
        humanSteps.push(step);
        continue;
      }
      if (step.owner === "machine" && step.skill === "none") {
        totals.prepared += 1;
        doneLines.push(`- ⚠ Prepared only (no skill can execute this): **${label}** — ${step.detail}`);
        console.log(`  ⚠ prepared only: ${label}`);
        continue;
      }
      // machine step with a real skill — one run of each skill per task;
      // a small planner model loves assigning the same skill twice.
      if (executedSkills.has(step.skill)) {
        doneLines.push(`- ↺ Merged (**${label}**) — the ${step.skill} step above already covers this.`);
        console.log(`  ↺ merged duplicate ${step.skill} step: ${label}`);
        continue;
      }
      executedSkills.add(step.skill);
      const t0 = now();
      try {
        if (step.skill === "drafter") {
          const draft = await writeDraft(model, task, step.detail);
          draftNo += 1;
          const file = path.join(DRAFTS, `draft-${draftNo}.md`);
          fs.writeFileSync(file, draft + "\n");
          totals.done += 1;
          totals.drafts += 1;
          doneLines.push(`- ✓ **Draft written** (${label}) → \`drafts/draft-${draftNo}.md\``, ``, `> ${draft.replace(/\n/g, "\n> ")}`, ``);
          console.log(`  ✓ draft written → drafts/draft-${draftNo}.md (${fmtTime(now() - t0)})`);
        } else if (step.skill === "organizer") {
          if (!args.folder) throw new Error("no folder given — pass --folder <dir>");
          const moves = await organizeFolder({ folder: args.folder, apply: args.apply, model });
          totals.done += 1;
          totals.filesFiled += moves.length;
          doneLines.push(`- ✓ **Folder ${args.apply ? "organised" : "organisation planned"}** (${label}) — ${moves.length} file(s):`);
          for (const m of moves) doneLines.push(`  - \`${m.from}\` → \`${m.to}\` — ${m.reason}`);
          console.log(`  ✓ organiser: ${moves.length} file(s) ${args.apply ? "moved" : "planned"} (${fmtTime(now() - t0)})`);
        } else if (step.skill === "digester") {
          if (!args.notes) throw new Error("no notes file given — pass --notes <file>");
          const text = fs.readFileSync(args.notes, "utf8");
          const digest = await digestNotes(model, text);
          digestNo += 1;
          const file = path.join(DIGESTS, `digest-${digestNo}.md`);
          fs.writeFileSync(file, digest + "\n");
          totals.done += 1;
          doneLines.push(`- ✓ **Notes digested** (${label}) → \`digests/digest-${digestNo}.md\``, ``, digest, ``);
          console.log(`  ✓ notes digested → digests/digest-${digestNo}.md (${fmtTime(now() - t0)})`);
        }
      } catch (e) {
        totals.failed += 1;
        doneLines.push(`- ✗ **Failed** (${label}): ${e.message}`);
        console.log(`  ✗ ${label} failed: ${e.message}`);
      }
    }

    // The product contract: every task ends with ONE tiny human step.
    // If the planner forgot to leave one, name the obvious one.
    if (!humanSteps.length) {
      if (executedSkills.has("drafter")) {
        humanSteps.push({ title: "Send the draft", firstAction: "Open the draft, copy it into the thread, press send" });
      } else if (executedSkills.has("organizer")) {
        humanSteps.push({ title: "Glance at the result", firstAction: "Open the folder and eyeball the new layout" });
      } else if (executedSkills.has("digester")) {
        humanSteps.push({ title: "Read your action items", firstAction: "Open the digest and star what is yours" });
      }
    }

    // Remaining-step text must fit what actually happened (QA defect
    // #9): QA's notes digest was left with "first move: press send" —
    // there is nothing to send. If no draft exists, a planner step
    // about sending is replaced with the step that fits the skill
    // that ran (or the honest by-hand step when none did).
    if (!executedSkills.has("drafter")) {
      for (const h of humanSteps) {
        if (/\bsend\b/i.test(`${h.title || ""} ${h.firstAction || ""}`)) {
          h.title = "Your remaining step";
          h.firstAction = executedSkills.has("digester")
            ? "Open the digest and star your action items"
            : executedSkills.has("organizer")
              ? "Open the folder and eyeball the new layout"
              : "Do this one by hand — KalKaro could not execute any of it";
        }
      }
    }

    const agentTime = fmtTime(now() - taskStart);
    console.log(`  done in ${agentTime}\n`);

    report.push(`## ${i + 1}. ${task}`);
    report.push(``);
    report.push(`Postponed: ${plan.daysPostponed ? `~${plan.daysPostponed} day(s)` : "not stated"} · Doing it by hand: ${plan.manualMinutes ? `~${plan.manualMinutes} min (planner's estimate)` : "no estimate"} · KalKaro took: ${agentTime} (measured)`);
    report.push(``);
    report.push(`### Done for you`);
    report.push(...(doneLines.length ? doneLines : [`- (nothing the machine could do)`]));
    report.push(``);
    report.push(`### Your tiny remaining step${humanSteps.length === 1 ? "" : "s"}`);
    if (humanSteps.length) {
      for (const h of humanSteps) {
        report.push(`- **${h.title || "One small thing"}**${h.firstAction ? ` — first move: ${h.firstAction}` : ""}`);
      }
    } else {
      report.push(`- Nothing. It is done.`);
    }
    report.push(``);

    tableRows.push({
      task,
      days: plan.daysPostponed ? String(plan.daysPostponed) : "—",
      manual: plan.manualMinutes ? `~${plan.manualMinutes} min` : "—",
      agent: agentTime,
      left: humanSteps.length
        ? short(humanSteps[0].firstAction || humanSteps[0].title || "one small step", 60)
        : "nothing",
    });
  }

  report.push(`## The totals`);
  report.push(``);
  report.push(`Machine steps executed: **${totals.done}** · prepared-only: **${totals.prepared}** · failed: **${totals.failed}** · drafts written: **${totals.drafts}** · files filed: **${totals.filesFiled}**`);
  report.push(``);
  report.push(`| # | Dreaded task | Days postponed | By hand (est.) | KalKaro (measured) | Your remaining step |`);
  report.push(`|---|--------------|----------------|----------------|--------------------|---------------------|`);
  tableRows.forEach((r, i) => {
    report.push(`| ${i + 1} | ${short(r.task, 44)} | ${r.days} | ${r.manual} | ${r.agent} | ${r.left} |`);
  });
  report.push(``);
  report.push(`KalKaro never sends, posts or deletes anything. Every draft waits for a human to press send — that part is yours, and it takes seconds.`);

  const reportFile = path.join(OUT, "report.md");
  fs.writeFileSync(reportFile, report.join("\n") + "\n");

  console.log(`Report: ${reportFile}`);
  console.log(`Machine steps executed: ${totals.done} · prepared-only: ${totals.prepared} · failed: ${totals.failed} · drafts: ${totals.drafts} · files filed: ${totals.filesFiled}`);

  // QA defect #10: the report was always honest, but the process still
  // exited 0 when the only task failed (QA Test B) — a script or CI
  // checking $? would record a broken run as success. Any failed task
  // now makes the run exit non-zero. All-success still exits 0.
  if (totals.failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`KalKaro stopped: ${e.message}`);
  process.exit(1);
});
