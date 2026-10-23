/**
 * Shared local-model plumbing for KalKaro.
 *
 * Everything talks to Ollama on localhost. No cloud APIs, no keys, no cost:
 * the model lives on the user's own machine, and so does their data.
 *
 * Model: Llama 3.2 1B Instruct (open-weight, Llama 3.2 Community License),
 * q4_K_M quant by default — small enough to run on any laptop CPU.
 * Override with --model or KALKARO_MODEL.
 */

export const OLLAMA = process.env.OLLAMA_HOST || "http://localhost:11434";
export const DEFAULT_MODEL = "llama3.2:1b-instruct-q4_K_M";

export function pickModel(flag) {
  return flag || process.env.KALKARO_MODEL || DEFAULT_MODEL;
}

/** Fail loudly and helpfully if the local model is not reachable/installed. */
export async function ensureModel(model) {
  let tags;
  try {
    tags = await (await fetch(`${OLLAMA}/api/tags`)).json();
  } catch {
    throw new Error(
      `Cannot reach Ollama at ${OLLAMA}. Start it with:  ollama serve\n` +
        "KalKaro runs 100% locally, so the model has to live on this machine."
    );
  }
  const names = (tags.models || []).map((m) => m.name);
  if (!names.some((n) => n === model || n.startsWith(model.split(":")[0]))) {
    throw new Error(
      `Model "${model}" not found in Ollama. Installed: ${names.join(", ") || "(none)"}\n` +
        `Pull it with:  ollama pull ${model}`
    );
  }
}

/**
 * One streaming chat call; returns the full reply text.
 *
 * Streaming matters: with stream:false, Ollama sends nothing until the
 * whole reply is generated, and on a busy CPU that can exceed fetch's
 * 300 s headers timeout — the call dies with "fetch failed" even though
 * the model was working fine. Streaming keeps bytes flowing.
 *
 * Transient connection failures (a busy local server, a dropped socket)
 * are retried: a tool for lazy people should not need babysitting.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One streaming chat call with a HARD wall-clock timeout and an optional
 * heartbeat. QA defect #6: a token cap alone does not bound time — at
 * 1–4 tokens/second on a busy CPU, a "bounded" 1,600-token call ran for
 * over 8 minutes, and a task burned 17m42s in the planner. The timeout
 * aborts the call so the caller can retry shorter or fall back, and the
 * heartbeat lets the CLI print "still thinking…" instead of freezing.
 */
async function chatStreamOnce(model, prompt, { format, temperature, numPredict, timeoutMs = 600000, onHeartbeat, heartbeatMs = 15000 } = {}) {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  timer.unref?.();
  const heartbeat = onHeartbeat
    ? setInterval(() => onHeartbeat(Date.now() - started), heartbeatMs)
    : null;
  heartbeat?.unref?.();
  try {
    const res = await fetch(`${OLLAMA}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        model,
        stream: true,
        ...(format ? { format } : {}),
        messages: [{ role: "user", content: prompt }],
        options: { temperature, ...(numPredict ? { num_predict: numPredict } : {}) },
      }),
    });
    if (!res.ok) throw new Error(`Ollama replied ${res.status}: ${await res.text()}`);
    let out = "";
    let buf = "";
    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        const obj = JSON.parse(line);
        if (obj.error) throw new Error(`Ollama error: ${obj.error}`);
        if (obj.message && obj.message.content) out += obj.message.content;
      }
    }
    return out;
  } catch (e) {
    if (ctrl.signal.aborted) {
      const err = new Error(
        `model call timed out after ${Math.round(timeoutMs / 1000)}s (wall-clock limit)`
      );
      err.code = "ETIMEOUT";
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
    if (heartbeat) clearInterval(heartbeat);
  }
}

async function chatStream(model, prompt, opts = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await chatStreamOnce(model, prompt, opts);
    } catch (e) {
      lastErr = e;
      // HTTP errors and model errors are real answers, not transients.
      if (/^Ollama (replied|error)/.test(e.message)) throw e;
      // A wall-clock timeout is not a transient either: retrying the
      // same call would just burn the same minutes again (QA defect #1).
      // The caller's shorter-retry / fallback path handles it.
      if (e.code === "ETIMEOUT") throw e;
      if (attempt < 3) await sleep(attempt * 5000);
    }
  }
  throw lastErr;
}

/**
 * Tolerant JSON extraction (QA defect #1). The planner died on
 * "Expected double-quoted property name in JSON at position 6612" —
 * raw JSON.parse with no recovery. This strips code fences and
 * surrounding prose, then applies two conservative repairs (trailing
 * commas, unquoted keys) before giving up. Repairs only run after a
 * strict parse of the extracted object has already failed.
 */
export function extractJSON(text) {
  let t = String(text || "").trim();
  t = t.replace(/```(?:json)?/gi, "");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  try {
    return JSON.parse(t);
  } catch {
    /* fall through to repairs */
  }
  const repaired = t
    .replace(/,\s*([}\]])/g, "$1") // trailing commas
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3'); // unquoted keys
  try {
    return JSON.parse(repaired);
  } catch {
    /* genuinely not JSON */
  }
  throw new Error("model reply was not valid JSON");
}

/** One chat call that must come back as JSON matching `schema`. */
export async function chatJSON(model, prompt, schema, callOpts = {}) {
  // The token cap bounds small-model rambling: the grammar constrains the
  // shape of the JSON, not its length, and an uncapped 1B planner happily
  // writes a 3,000-token plan for a two-step task. Callers (the planner)
  // pass a smaller cap and a hard timeout via callOpts.
  const opts = { format: schema, temperature: 0.1, numPredict: 1600, ...callOpts };
  const text = await chatStream(model, prompt, opts);
  try {
    return extractJSON(text);
  } catch {
    // The usual cause is truncation: the model pretty-prints a plan so
    // long it hits the token cap mid-string. A shorter reply fits —
    // so ask for exactly that instead of repeating the same request.
    const shorter =
      prompt +
      "\n\nIMPORTANT: your previous reply could not be used (too long or not valid JSON). Reply again MUCH shorter and stricter: at most 3 steps, every detail under 8 words, all JSON on a single line, double quotes around every key.";
    const retry = await chatStream(model, shorter, opts);
    return extractJSON(retry);
  }
}

/** One plain-text chat call. Returns the model's reply text. */
export async function chatText(model, prompt, callOpts = {}) {
  const text = await chatStream(model, prompt, { temperature: 0.3, numPredict: 700, ...callOpts });
  return text.trim();
}
