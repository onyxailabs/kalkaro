# KalKaro — Full QA Re-Run Report (post-fix)

**Tester stance:** independent re-run of the ORIGINAL QA battery against the
FIXED code. Product code was not edited. Original inputs used **verbatim**
(byte-compared against the preserved `qa-run/` fixtures before running).
**Date:** 2026-10-22 (Asia/Karachi)
**Code under test:** fresh copy of `~/workspace/devto-challenge-week3/kalkaro/`
at `qa-rerun/kalkaro-fresh/` (`diff -r` against the repo: identical).
**Environment:** Node v24.20.0; Ollama serving `llama3.2:1b-instruct-q4_K_M`
(807,709,787 bytes, the exact README tag — Ollama was down at start, started
with `~/.local/ollama/bin/ollama serve`, same as original QA); `pdftotext`
present; VM load ~1.9–4.2 during runs (quieter than the original QA's ~5–9,
so timings are not directly comparable — behaviour is).

## Verdict summary

| Test | Original QA | Re-run | Wall (was) |
|---|---|---|---|
| B — folder organizing, end-to-end CLI | **FAIL** | ✅ **PASS** | 200 s (1,062 s) |
| A — professor extension email | PARTIAL | ✅ **PASS** | 46 s (131 s) |
| C — client-call notes digest | PARTIAL | ⚠ **PARTIAL** | 75 s (116 s) |
| D2 — nonsense task | **FAIL** | ✅ **PASS** | 1 s (545 s) |

Both CRITICAL defects and both HIGH defects from the original report are
verifiably fixed end-to-end. One MEDIUM-class residual remains in Test C
(unresolved item filed under Decisions — different mechanism from the
original Test C defects, which are all fixed). Detail below.

---

## Test B — Fresh organizing task (end-to-end CLI) — ✅ PASS

- **Input (verbatim):** "Sort out my messy folder of invoices, documents,
  code, screenshots and personal files at last."
- **Fixture:** the original 10 unseen files, copied fresh; SHA-256 of every
  file verified against the original `before-manifest.json` before the run
  (10/10 MATCH).
- **Command:** `node kalkaro.mjs tasks.txt --folder messy --notes
  placeholder-notes.txt --apply --out out` (same shape as original QA;
  report header confirms "Organizer mode: applied (files moved)").
- **Exit/time:** exit **0**; **200 s** wall. Original: exit 0 but task
  failed after 1,062 s with a planner JSON parse error.
- **Planner behaviour:** heartbeat lines printed every 15 s (fix #6 live);
  the first attempt's heartbeats run 15→60 s, then a second attempt's
  counter restarts and the plan lands — "plan: 5 step(s) in 1m 31s". No
  JSON parse failure reached the user; the tolerant-parse/retry path in
  `lib/model.mjs` (`extractJSON`) absorbed whatever the first attempt
  produced. The 150 s/call cap was never needed because attempt 2
  succeeded, so `fallbackPlan()` was not exercised this run (it was
  exercised live in the fixer's test (e)).
- **Per-file result — 10/10 filed, content intact:**

| File | Result | Judgement |
|---|---|---|
| `Acme_Invoice_2026-03-14.pdf` | `Invoice/2026-10/acme-invoice-2026-03-14.pdf` — "Invoice from Acme Supplies" | ✓ category, grounded name + date |
| `IMG_9082.jpg` | `Media/2026-10/img-9082.jpg` | ✓ |
| `Maya_CV.pdf` | `Document/2026-10/maya-cv.pdf` — "Maya Chen's Curriculum Vitae" | ✓ grounded |
| `Screenshot_2026-04-02_143511.png` | `Screenshot/2026-10/screenshot-2026-04-02-143511.png` | ✓ |
| `budget-q2.csv` | `Document/2026-10/q2-budget.csv` — "Spreadsheet of past expenses, from its own content" | ✓ name grounded in filename; reason is supported by the CSV's actual rows (Rent/Software/Travel amounts) |
| `deploy-notes.js` | `Code/2026-10/deploy-notes.js` | ✓ |
| `electricity-bill-march.pdf` | `Invoice/2026-10/electricity-bill-march.pdf` — **grounding guard fired**, original name kept, reason says why | ✓ QA stamped this file "hostnest-invoice"; now correct |
| `meeting-photo.png` | `Media/2026-10/meeting-photo.png` | ✓ |
| `passport-scan.pdf` | `Document/2026-10/passport-scan.pdf` — "Passport identity page scan" (the PDF's own text) | ✓ QA had this as a fabricated "hostnest invoice"; now name AND reason are the file's own |
| `random.txt` (balcony plant ideas) | `Document/2026-10/random.txt` — **guard fired**, original name kept | ✓ QA had this as "expense-export-sept / Spreadsheet of past expenses"; now honest |

- **No "hostnest", no "expense-export", no invented name or reason
  anywhere.** The two renames the guard rejected fell back to the original
  filenames with an honest explanation, exactly as designed
  (`skills/organizer.mjs` `groundName()`).
- **Integrity:** sorted SHA-256 multiset after the run is **identical** to
  the before-manifest — no file lost, no content altered.
- **Tallies/report:** executed 1 · prepared 0 · failed 0 · files filed 10;
  remaining step is the correct organizer one: "Open the folder and
  eyeball the new layout."
- **Cosmetic observations (not failures):** the planner emitted three
  organizer steps ("Sort out…", "classify", "rename") — the duplicates
  were visibly merged (↺ lines) and only one organizer run happened; the
  plan's human step was titled "send" (planner boilerplate), though the
  report's actual remaining-step text was correctly replaced with the
  organizer-appropriate one.

## Test A — Professor extension email — ✅ PASS

- **Input (verbatim):** "Email my professor: my assignment will be 2 days
  late because of a family emergency; ask politely for an extension."
- **Command:** `node kalkaro.mjs tasks.txt --notes placeholder-notes.txt
  --out out`. **Exit 0; 46 s** (original: 131 s).
- **Actual draft:**

> Hello,
>
> I'm reaching out because I'm facing a family emergency that's caused an
> unexpected delay in my assignment. I'm concerned that I won't be able to
> submit it on time, and I was wondering if it would be possible to get an
> extension. I would greatly appreciate an extra day or two to complete
> the work and submit it by the new deadline. I'm confident that I can
> complete the assignment within the new timeframe, and I'm committed to
> delivering high-quality work. I'm available to discuss this further if
> needed, and I appreciate your understanding in this matter. I'm looking
> forward to hearing back from you and finding a solution. Thank you for
> your time and consideration. Best regards

- **Against every reason the original QA withheld PASS:**
  1. *Never asked for the extension* → **fixed.** "…if it would be
     possible to get an extension. I would greatly appreciate an extra
     day or two…" is an explicit, polite request.
  2. *`[Date]` placeholder* → **fixed.** No bracketed placeholder
     anywhere; the missing date is phrased around ("submit it by the new
     deadline"), never invented.
  3. *No greeting/closing* → **fixed.** "Hello," greeting and "Best
     regards" sign-off present.
  4. *"Postponed: ~2 day(s)" metric flaw* → **fixed.** Report says
     "Postponed: not stated" and the table shows "—" (`daysFromText` no
     longer counts "will be 2 days late").
  5. First person ✓, family emergency ✓, two-day scale ("an extra day or
     two") ✓, no invented names/dates/times ✓ (the `validateDraft`
     guard's rules all satisfied — no regeneration was needed).
- **Cosmetic observations:** the draft body is one long paragraph and the
  greeting/sign-off sit inline rather than on their own lines — a tidy-up,
  consistent with the README's now-honest claim ("a strong first draft you
  review, tidy and send"); the report's remaining step reads "Send email
  and organize files" — "press send" is right for a draft, but the
  trailing "and organize files" is planner filler (this task has no
  files). The step-replacement pass (fix #9) only rewrites steps when no
  draft executed, so planner text passed through here.

## Test C — Client-call notes digest — ⚠ PARTIAL

- **Input (verbatim):** task "Make sense of my client call notes and pull
  out the decisions and who owes what." + the original
  `client-call-notes.txt` (byte-identical copy).
- **Command:** `node kalkaro.mjs tasks.txt --notes client-call-notes.txt
  --out out`. **Exit 0; 75 s** (original: 116 s).
- **Action items: 4/4 correct, identical to the original QA's expected
  list** (Omar — revised SOW by Friday Oct 23; Leena — checkout mockups
  by Wednesday Oct 21; Tomas — refund-flow testing by Monday Oct 26;
  Priya — regression checklist after API freeze Oct 28). Nothing
  invented.
- **Decisions — the four real ones are all correct:** price $79 ✓,
  launch Nov 11 ✓, "Dark mode: OUT of v1" ✓, legal-approved privacy
  wording ✓.
- **Every defect the original QA cited for C is fixed:**
  1. *Summary implied dark mode was adopted* → **fixed.** Summary now
     says only "the dark mode decision made"; Decisions say OUT.
  2. *Decisions duplicated all four action items* → **fixed.**
     `dropActionDuplicates()` removed them; no action item is re-listed
     under Decisions.
  3. *Remaining step was "press send" for a notes task* → **fixed.**
     Now "Open the digest and star your action items."
- **NEW residual defect (why PARTIAL, not PASS):** the explicitly
  **unresolved** discount question is filed under **Decisions**:
  - Decisions contains "- Annual discount: 10% or 15% Nadia will decide"
  - Summary says "The annual discount decision was also made, with Nadia
    to decide after finance reviews" — internally contradictory.
  - The original QA explicitly credited the old run with the opposite:
    "The unresolved 10% vs 15% annual discount was correctly not
    promoted into a decision." This run promotes it. The bullet's text
    does disclose that Nadia will decide, so it is a filing/framing
    error rather than a fabricated fact — but a skim-reader of the
    Decisions section (the section QA worried about) sees an undecided
    question presented as a decision.
  - A stray empty "- Who is doing what:" header also sits inside
    Decisions (cosmetic, same section).
- **Root cause (diagnosed, not fixed):** `skills/digester.mjs`. The
  decisions-extraction call itself returned the unresolved item and the
  section header, and no deterministic guard filters them:
  `dropActionDuplicates()` only drops bullets that match action items
  (the discount bullet matches none), and `contradictorySentences()`
  only polices summary sentences that use adoption language about an
  OUT-decision's subject (the discount is not an OUT decision). There is
  no "source marks this unresolved → keep it out of Decisions" pass.
  The original run's model simply didn't emit the item; this run's did —
  model variance exposing a guard gap.

## Test D2 — Nonsense task ("Do the thing with the stuff.") — ✅ PASS

- **Input (verbatim):** "Do the thing with the stuff."
- **Command:** `node kalkaro.mjs nonsense-tasks.txt --notes
  placeholder-notes.txt --out out-nonsense`.
- **Exit 0; 1 s wall** (0.0 s measured task time). Original: exit 0 after
  545 s with a fabricated Sunday-lunch draft counted as success.
- **Actual behaviour:** the deterministic scope gate (`taskCoverage()` in
  `kalkaro.mjs`) refused **before any model call**:
  "⚠ prepared only — KalKaro can't do this one: no skill covers it".
  Report states plainly: "Nothing was executed for it, and it is not
  counted as done." Remaining step: "Do this one by hand."
- **Tallies:** executed **0** · prepared-only **1** · failed **0** ·
  drafts **0**. **No draft file exists** in the output tree (report.md
  only) — the Drafter's old voice-example contamination has no surface
  to leak through, and the example itself was removed from the prompt.
- **Exit code 0 is correct here by design:** a can't-do refusal is an
  honest result, not a failure (fix #10 sets exit 1 only when
  `totals.failed > 0` — `kalkaro.mjs:481`, statically confirmed; the
  exit-1-on-real-failure path was demonstrated live in the fixer's test
  (e): folder task with no `--folder` → failed 1, exit 1, 151 s).

## Cross-cutting checks

- **Prompt-contamination guards:** exercised live in B (the
  `groundName()` guard fired twice, visibly, with honest fallback
  reasons) and structurally in D2/A (no example text exists to leak;
  A's draft contains no ungrounded names, times or bracketed text).
- **README honesty vs behaviour — all original documentation defects
  verified fixed in the shipped README:** real clone URL
  (`git clone https://github.com/onyxailabs/kalkaro`, README:37);
  `pdftotext`/Poppler disclosed as optional with the filename-only
  fallback stated (README:41, :87); `YYYY-MM` explicitly defined as the
  file's *modification* month (README:24); Ollama-not-running
  troubleshooting with `ollama serve` (README:43); draft claim softened
  to "a strong first draft you review, tidy and send" (README:23) — and
  Test A's draft matches that claim.
- **Git history (defect #12):** 13 original commits now carry
  Oct 21–22 +0500 author/committer dates exactly as the fix log records;
  3 fix commits sit on top with real timestamps. No future-dated commits
  remain.
- **Network independence:** not re-scanned line-by-line this run; all
  four tests ran entirely against the local Ollama with no cloud calls
  observed, consistent with the original QA's code scan.

## Bottom line

The product that the original QA said a stranger "cannot trust with a
task they actually care about" now: files a real 10-file folder
end-to-end in 3m 19s with grounded names and zero content loss; writes
an extension email that actually asks, with no placeholders or invented
facts; digests notes with perfect action extraction; and refuses a
nonsense task in 0.0 s instead of fabricating work for 9 minutes. The
one remaining blemish is Test C's unresolved discount filed under
Decisions — a MEDIUM-class framing defect in `skills/digester.mjs`
(no unresolved-item guard on the decisions list), found by model
variance, with an honest-but-misfiled bullet rather than a fabricated
fact.

**Recommendation to parent:** clean enough to proceed to demo
regeneration, GitHub repo creation and DEV publish prep. If the demo or
the DEV entry showcases a notes digest, consider landing the small
digester guard first (drop decision bullets the notes mark unresolved /
route them to an "Unresolved" line, and drop empty section headers) and
re-running only Test C (~75 s) — the parent decides; no code was
changed in this re-run.
