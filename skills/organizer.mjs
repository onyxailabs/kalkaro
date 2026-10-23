/**
 * KalKaro skill: Organizer.
 *
 * Classifies, renames and sorts a messy folder using the local model:
 * each file goes to <out>/<Category>/<YYYY-MM>/ with a clean kebab-case name.
 * Nothing moves unless `apply` is true.
 *
 * Adapted from the LazyFiler prototype (built earlier in this challenge
 * window) — same filing engine, now driven by KalKaro's task planner.
 *
 * QA hardening (defects #3, #4, #5): the classify prompt's worked
 * example stamped its invented name ("…hostnest-invoice") and reason
 * onto unrelated files — a passport scan, a utility bill, a plant-ideas
 * text file. Two defences now: (1) the prompt's examples only ever
 * rename a file to a cleaned form of its OWN filename, so copying the
 * pattern is safe; (2) a deterministic grounding guard (groundName)
 * rejects any proposed name whose words do not appear in the file's
 * own filename or extracted content, falling back to a sanitised
 * version of the original filename with a generic reason.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chatJSON } from "../lib/model.mjs";

const CATEGORIES = [
  "Invoice",
  "Receipt",
  "Contract",
  "Screenshot",
  "Document",
  "Code",
  "Media",
  "Other",
];

const TEXT_EXTS = new Set([".txt", ".md", ".csv", ".json", ".log", ".tsv"]);
const CODE_EXTS = new Set([
  ".js", ".mjs", ".ts", ".py", ".rb", ".go", ".rs", ".java", ".c", ".cpp",
  ".sh", ".html", ".css", ".yml", ".yaml", ".toml",
]);

/** Extract whatever text we honestly can from a file. */
function extractText(file) {
  const ext = path.extname(file).toLowerCase();
  try {
    if (TEXT_EXTS.has(ext) || CODE_EXTS.has(ext)) {
      return fs.readFileSync(file, "utf8").slice(0, 4000);
    }
    if (ext === ".pdf") {
      try {
        const out = execFileSync("pdftotext", ["-l", "2", file, "-"], {
          encoding: "utf8",
          timeout: 15000,
          maxBuffer: 1024 * 1024,
        });
        return out.slice(0, 4000);
      } catch {
        return ""; // pdftotext missing or failed: filename only
      }
    }
  } catch {
    return "";
  }
  return ""; // images & everything else: filename only
}

/** Ask the local model to classify one file. Returns {category, newName, reason}. */
async function classify(model, file, text) {
  const name = path.basename(file);
  const prompt = `You are the Organizer skill of KalKaro, a filing assistant. Look at this file and decide where it belongs.

Filename: ${name}
Content excerpt:
"""
${text || "(no readable text — judge by the filename alone)"}
"""

Categories (pick exactly one): ${CATEGORIES.join(", ")}.
- Invoice: a bill asking for payment. Receipt: proof of a payment already made.
- Contract: an agreement between parties. Screenshot: a screen capture image.
- Document: letters, notes, articles, forms, anything written that is not above.
- Code: source code or config. Media: audio/video/image that is not a screenshot.
- Other: nothing fits.
- A spreadsheet listing expenses that were already paid is a Document, not an Invoice.

Examples (note: every example renames a file to a cleaned form of its
OWN filename — that is the pattern to follow):
- Filename "IMG_4021.png", no readable text → {"category": "Media", "newName": "img-4021", "reason": "Camera photo, judged by filename"}
- Filename "q2-budget.csv", content is a list of dated expenses already paid → {"category": "Document", "newName": "q2-budget", "reason": "Spreadsheet of past expenses, from its own content"}
- Filename "scan_003.pdf", content says "INVOICE #1042 ... TOTAL DUE $26.99" → {"category": "Invoice", "newName": "scan-003", "reason": "Invoice asking for payment, from its own text"}
- Filename "invoice-2026-03-14.pdf", content is a bill from the company named in the file → {"category": "Invoice", "newName": "invoice-2026-03-14", "reason": "Invoice, date from its own filename"}

Propose a clean new filename: lowercase kebab-case, descriptive, keep it short.
CRITICAL: every word in newName must come from THIS file's filename or its content excerpt above. Never use a word from these instructions or from the examples — a name the file itself does not support will be rejected and the original filename kept.
If the content shows a clear date (e.g. an invoice date), start the name with YYYY-MM-DD-.
NEVER invent a date: use one only if it literally appears in the filename or the content above.
If the document says INVOICE, or asks for a payment that is still due, it is an Invoice — never a Receipt.
A filename like IMG_4021 or PXL_2024... with no readable text is a camera photo: Media.
Do NOT include the file extension in the name; it is added automatically.
Reply with JSON only: {"category": "...", "newName": "...", "reason": "one short sentence"}`;

  return chatJSON(model, prompt, {
    type: "object",
    properties: {
      category: { type: "string", enum: CATEGORIES },
      newName: { type: "string" },
      reason: { type: "string" },
    },
    required: ["category", "newName", "reason"],
  });
}

function sanitizeName(raw, ext) {
  let n = String(raw || "untitled")
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,5}$/i, "") // model sometimes adds the extension anyway
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  if (!n) n = "untitled";
  return n + ext.toLowerCase();
}

function uniqueDest(dir, filename) {
  let dest = path.join(dir, filename);
  let i = 2;
  const ext = path.extname(filename);
  const stem = filename.slice(0, -ext.length);
  while (fs.existsSync(dest)) {
    dest = path.join(dir, `${stem}-${i}${ext}`);
    i += 1;
  }
  return dest;
}

/**
 * Anti-hallucination guardrail: a date prefix in the proposed name must
 * literally appear in the filename or the file's own text. Small models
 * invent plausible dates from nothing, and a wrong date is worse than
 * no date at all.
 */
function groundDate(newName, source) {
  const name = String(newName || "");
  const m = name.match(/^(\d{4})-(\d{2})-(\d{2})-/);
  if (!m) return name;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  const dmy = `${m[3]}-${m[2]}-${m[1]}`;
  if (source.includes(iso) || source.includes(dmy)) return name;
  return name.slice(iso.length + 1);
}

/**
 * Anti-hallucination guardrail for NAMES (QA defects #4, #5): the date
 * guard above was not enough — QA's classifier stamped the prompt
 * example's invented name onto a passport scan and a utility bill,
 * because nothing checked the WORDS. Now every word of a proposed name
 * (date parts and the category word aside) must literally appear in
 * the file's own filename or its extracted content. If any word is
 * ungrounded, the rename falls back to a sanitised version of the
 * original filename: a boring name the file earned, never an invented
 * one. The reason falls back with it — a fabricated reason must not
 * survive a rejected name.
 */
export function groundName(newName, originalStem, source, category) {
  const src = String(source || "").toLowerCase();
  const tokens = String(newName || "")
    .toLowerCase()
    .split("-")
    .filter(Boolean);
  const isDatePart = (w) => /^\d{4}$/.test(w) || /^\d{2}$/.test(w);
  const ungrounded = tokens.filter(
    (w) => !isDatePart(w) && w !== String(category || "").toLowerCase() && !src.includes(w)
  );
  if (!ungrounded.length) return { name: newName, grounded: true };
  return { name: originalStem, grounded: false };
}

/**
 * Organize `folder` into `out` (default: <folder>/_organized).
 * Returns an array of {from, to, category, reason} describing every file.
 */
export async function organizeFolder({ folder, out, apply = false, model }) {
  const SRC = path.resolve(folder);
  const OUT = out ? path.resolve(out) : path.join(SRC, "_organized");
  const entries = fs
    .readdirSync(SRC, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith("."))
    .map((e) => path.join(SRC, e.name))
    .sort();

  const results = [];
  const place = (file, category, newName, reason) => {
    const ext = path.extname(file);
    const ym = fs.statSync(file).mtime.toISOString().slice(0, 7); // YYYY-MM
    const destDir = path.join(OUT, category, ym);
    const dest = uniqueDest(destDir, sanitizeName(newName, ext));
    if (apply) {
      fs.mkdirSync(destDir, { recursive: true });
      fs.renameSync(file, dest);
    }
    results.push({ from: path.basename(file), to: path.relative(SRC, dest), category, reason });
  };

  for (const file of entries) {
    const ext = path.extname(file).toLowerCase();
    if (CODE_EXTS.has(ext)) {
      // A .js file is code. No model needed — and no chance for the model
      // to hallucinate it into an "invoice", which it genuinely tried.
      place(file, "Code", path.basename(file, ext), "Source code — filed by extension, no model call needed");
      continue;
    }
    const text = extractText(file);
    const r = await classify(model, file, text);
    let category = CATEGORIES.includes(r.category) ? r.category : "Other";
    if (!text.trim()) {
      // The model cannot read this file (a photo, a scan, a binary) —
      // so it must not claim content it never saw ("Invoice asking for
      // payment" about an opaque PNG). The filename is the only honest
      // evidence: let it speak, and keep the model's name out of it.
      const base = path.basename(file);
      if (/receipt/i.test(base)) category = "Receipt";
      else if (/screenshot|screen[-_ ]?shot/i.test(base)) category = "Screenshot";
      else if (!["Media", "Screenshot", "Receipt", "Other"].includes(category)) {
        category = [".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext) ? "Media" : "Other";
      }
      place(file, category, path.basename(file, ext), "No readable content — filed by filename");
      continue;
    }
    const src = `${path.basename(file)}\n${text}`;
    const dated = groundDate(r.newName, src);
    const g = groundName(dated, path.basename(file, ext), src, category);
    let reason = r.reason;
    if (!g.grounded) {
      reason = `Filed as ${category} — kept the original filename (the suggested rename used words that are not in this file)`;
    } else if (/hostnest/i.test(String(reason || ""))) {
      reason = `Filed as ${category}, judged from the file itself`;
    }
    place(file, category, g.name, reason);
  }
  return results;
}
