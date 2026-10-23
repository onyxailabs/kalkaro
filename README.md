# KalKaro

**"Kal karo" is Urdu/Hindi for "do it tomorrow."** It is also, not coincidentally, what I have been saying to the same three tasks for about a week.

KalKaro is a small local AI agent that takes the list of tasks you keep postponing, breaks each one into micro-steps, and then **does the machine-doable 90% itself** — today, on your own machine. What it leaves you is the tiny human step at the end: press send, glance at a summary, pick a morning.

It runs **100% locally** on an open-weight model (Llama 3.2 1B via Ollama). No cloud, no API key, no subscription — and your dreaded tasks, including the embarrassing overdue ones, never leave your disk.

## What it does

Give KalKaro a plain-words list of dreaded tasks:

```text
Reply to my landlord Mr. Rashid about the kitchen tap that has been leaking — his email came 6 days ago...
Sort out my Downloads folder at last — it is a mess of receipts, scans and random files...
Make sense of my meeting notes from Tuesday's team call...
```

For each task, a local planner model breaks it into micro-steps and labels each one **DOABLE-BY-MACHINE** or **NEEDS-HUMAN** (with the tiniest possible first action). Then KalKaro executes the machine steps with three built-in skills:

| Skill | What it actually does |
|---|---|
| **Drafter** | Writes the reply you have been avoiding — a strong first draft you review, tidy and send |
| **Organizer** | Classifies, renames and sorts a messy folder into `Category/YYYY-MM/` with clean names (the `YYYY-MM` is the file's modification month, not a date inside the document) |
| **Digester** | Turns rambling notes into a summary, the decisions, and who-owes-what action items |

Everything lands in one **done-for-you report** (`report.md`): what was finished, the drafts themselves, the digests, per-task measured timings — and for whatever is left, exactly one tiny human step per task.

A 1B planner is enthusiastic and sloppy, so KalKaro wraps it in **deterministic guardrails** — plain rules grounded in your own words that dispose of what the model proposes. They drop skills a task never mentioned, add the one it clearly needs, file code by extension instead of asking the model, forbid dates — and now names — in filenames that do not exist in the source, refuse tasks no skill can honestly do instead of faking them, and dedupe the model's echoes. Every guardrail prints a `⛨` line in the transcript when it fires. The model proposes; the rules dispose; you can watch both.

One guard deserves its own line, because it protects the section people skim: an item the notes leave **undecided** is never filed as a decision — a deterministic pass splits it into an **Open questions** section instead. The nasty fixture behind that rule (client-call notes with a discount explicitly left open) ships as `demo/notes-hard.txt` with its task line in `demo/tasks-hard.txt`, and the three post-fix verification re-runs are written up in `QA-RERUN-REPORT.md` — the claim is checkable, not asserted.

KalKaro **never sends, posts or deletes anything.** Pressing send stays human. It takes about four seconds, which is rather the point.

## Setup (5 steps)

1. Install [Ollama](https://ollama.com) — one command on macOS/Linux/Windows.
2. Pull the model: `ollama pull llama3.2:1b-instruct-q4_K_M` (~800 MB, open-weight, Llama 3.2 Community License).
3. Clone this repo: `git clone https://github.com/onyxailabs/kalkaro` and `cd kalkaro`.
4. Write your dreaded list in `tasks.txt` — one task per line, plain words, no format to learn.
5. Run it: `node kalkaro.mjs tasks.txt --folder ~/Downloads --notes notes.txt --out out`

Node 18+ is the only other requirement. One optional extra: Poppler's `pdftotext` lets the Organizer read the text inside PDFs when it classifies them; without it, PDFs are filed by filename alone and everything else works the same. Add `--apply` when you want the Organizer to actually move files (it plans first by default, so you can see what *would* happen). Read `out/report.md` and do your tiny steps.

**Troubleshooting:** if KalKaro says it cannot reach Ollama, the server isn't running — start it with `ollama serve` and run KalKaro again.

## A real run

The `demo/` folder contains a complete, honest demo — a dreaded list, a messy folder, a messy notes file — and `demo/run-demo.sh` runs KalKaro on a copy of it, saving the full transcript to `demo/DEMO-OUTPUT.txt`. Nothing in that file is staged or edited. Here is what the latest run actually did.

The list:

```text
Reply to my landlord Mr. Rashid about the kitchen tap that has been leaking — his email came 6 days ago...
Sort out my Downloads folder at last — it is a mess of receipts, scans, screenshots and random files...
Make sense of my meeting notes from Tuesday's team call...
```

**Task 1 — the overdue reply.** The planner proposed five steps but forgot the one step that mattered; a guardrail added the Drafter step it had missed, and the Drafter wrote this (draft in 82.7 seconds; the task took 3m 8s):

> Hello Mr. Rashid,
>
> I wanted to follow up on my email from six days ago regarding the kitchen tap that has been leaking. I've been meaning to address this issue, but I've been putting it off. I'm now at a point where I need to apologize for the delay and ask for your assistance in sending a plumber to fix the problem this week. I would greatly appreciate it if you could provide a specific time for the plumber to arrive. I've been keeping track of the time, and I'm expecting the plumber to arrive sometime this week. I'm hoping this will be resolved soon, and I'm grateful for your understanding in this matter. I'm looking forward to hearing back from you and finding a solution to this issue. Thank you for your time and assistance.
>
> Best regards

Imperfect in new ways — it muddles who emailed whom ("follow up on *my* email", when Mr. Rashid's email is the one being answered) and breezily presumes the plumber's arrival — but the apology and the ask are in there, sendable after a 30-second tidy, which is the deal KalKaro offers: the human's remaining step was *"Compose email."*

**Task 2 — the folder.** This run, the folder task's planner call timed out at 150 seconds, so a deterministic fallback plan — organizer only, no planner involved — did the filing: five files in, five filed correctly (2m 19s of organizing; the task took 4m 49s):

| Before | After |
|---|---|
| `IMG_4021.png` | `Media/2026-10/img-4021.png` (no readable content — filed by filename) |
| `expense-export-sept.csv` | `Document/2026-10/expense-export-sept.csv` (a spreadsheet of past expenses, from its own content) |
| `fix-login-bug.js` | `Code/2026-10/fix-login-bug.js` (source code — filed by extension, no model call needed) |
| `receipt-coffee-shop.jpg` | `Receipt/2026-10/receipt-coffee-shop.jpg` (no readable content — filed by filename) |
| `scan_003.pdf` | `Invoice/2026-10/scan-003.pdf` (an invoice asking for payment, from its own text — it kept its scanner name this run; the old run's date-based rename did not repeat) |

**Task 3 — the notes.** A guardrail dropped a Drafter step the planner invented — a notes task needs a digest, not a message — and the Digester wrote its brief in 3m 43s (the task took 5m 17s; the notes had sat for ~7 days against ~30 minutes by hand). It is the run's honest weak spot: the summary states both real decisions (landing page v2; the discount until Oct 31) and then repeats them in a second paragraph; the Decisions section came back **"None recorded."**; and the nine action lines cover what is really four jobs — Sara's banner sizes twice, the designer-invoice chase four times under two different owners, the blog read-through given to the wrong person, two lines with invented owners, and Dev's image-compression job missing entirely. All of it is in the transcript, unedited.

**The honest tally for that run:** 3 machine steps executed · 0 prepared-only · 0 failed · 1 draft written · 5 of 5 files filed · the routing guardrails had to correct 2 of the 3 plans, and the third plan never arrived (the 150s timeout) — its task finished anyway on the fallback · **0 tasks failed**, though the notes digest earns "did not fail", not "did it well". Total wall time was about 13 minutes on this 2-core development VM with its load average spiking past 8 — the same contention that timed the planner out.

## Honest limits

- **The model is small on purpose.** A 1B model that runs on any laptop CPU will occasionally misfile a file, write a slightly stiff sentence, or misread which step belongs to a human. The planner's estimates (days postponed, minutes-by-hand) are estimates and are labelled as such; KalKaro's own timings are measured, not estimated.
- **A bigger or cloud model would do better** at nuanced drafting (tone, sarcasm, long threads), at classifying ambiguous documents, and at digesting very long notes. It would also cost money, need your data on someone else's server, and — in my experience — give you one more dashboard to postpone opening. KalKaro trades a little polish for zero cost, total privacy, and actually existing on your machine today.
- **Speed depends on your machine.** On this project's development VM (a contended shared CPU), a single model call takes ~30–60 seconds. On a normal laptop the same 1B quant is noticeably quicker. Slow and steady is, after all, the theme.
- The Digester reads the first ~6,000 characters of a notes file, and the Organizer judges images by filename (it cannot see pictures without a vision model).

## Tech

- **Model:** Llama 3.2 1B Instruct, `q4_K_M` quant — Meta's open-weight model under the [Llama 3.2 Community License](https://www.llama.com/llama-downloads/).
- **Runtime:** [Ollama](https://ollama.com) (MIT) serving on localhost; KalKaro talks to it over its local HTTP API. No other dependencies — just Node, plus the optional `pdftotext` (Poppler) for reading PDF text; without it, PDFs are filed by filename only.
- **Code:** MIT licensed (see `LICENSE`). The Organizer skill grew out of LazyFiler, a filing prototype built earlier in the same Hacktoberfest window.

---

*Built Oct 2026 for the DEV Hacktoberfest Week 3 challenge ("Slow and Steady"). All repository work happened inside the challenge window, Oct 19–25, 2026.*
