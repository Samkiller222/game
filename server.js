// Draw Guide server: serves the frontend and proxies requests to the Gemini API
// so the API key never reaches the browser. No dependencies — Node 20.12+ only.

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

try {
  process.loadEnvFile(); // reads .env if present
} catch {
  // no .env file — rely on real environment variables
}

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.GEMINI_API_KEY;
const API_BASE = process.env.GEMINI_API_BASE || "https://generativelanguage.googleapis.com/v1beta";
const TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || "gemini-2.5-flash";
const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const MAX_BODY_BYTES = 20 * 1024 * 1024;
const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);

// ---------------------------------------------------------------------------
// Drawing stages, in the order the user draws them.
// Images are generated in REVERSE order (final -> shapes): each stage is made
// by stripping something away from the next one, which keeps the pictures far
// more consistent than inventing each stage from scratch.
// ---------------------------------------------------------------------------

const KEEP_ALIGNED =
  "Keep exactly the same composition, framing, pose, proportions and aspect ratio so this stage lines up with the others. " +
  "Plain white paper background. Output only the image, no text, labels or borders.";

export const STAGES = [
  {
    id: "shapes",
    title: "Basic shapes",
    prompt:
      "Turn this drawing into the very first construction stage of a drawing tutorial: only simple geometric shapes " +
      "(circles, ovals, boxes, cylinders) and guidelines (centre lines, an action/gesture line) drawn in light blue-grey pencil, " +
      "placed exactly where the main masses of the subject are. No outlines of the final form, no details, no colour.",
  },
  {
    id: "sketch",
    title: "Rough sketch",
    prompt:
      "Turn this line art into a loose, rough graphite pencil sketch: light, sketchy, overlapping exploratory strokes that " +
      "establish the main forms and contours. Keep faint construction lines visible. No fine details, no shading, no colour.",
  },
  {
    id: "lineart",
    title: "Clean line art",
    prompt:
      "Simplify this ink drawing into clean line art: keep only the main confident outlines and the major interior lines " +
      "in black ink. Remove hatching, texture marks and small details. No colour, no shading.",
  },
  {
    id: "details",
    title: "Details",
    prompt:
      "Remove ALL colour from this image, turning it into black ink line art on white paper that keeps every detail: " +
      "facial features, textures, folds, patterns, and light hatching to suggest where the shadows are. No colour or grey fills.",
  },
  {
    id: "colours",
    title: "Base colours",
    prompt:
      "Turn this illustration into the flat-colour stage: keep the same black line art, but replace all shading, highlights, " +
      "gradients and texture with flat, solid base colours (one colour per area).",
  },
  {
    id: "final",
    title: "Shading & finishing",
    prompt: null, // built from the chosen style, see finalPrompt()
  },
];
const STAGE_BY_ID = Object.fromEntries(STAGES.map((s) => [s.id, s]));

const STYLES = {
  original: null, // use the uploaded image as the final stage
  cartoon: "a clean, friendly cartoon illustration with bold outlines and cel shading",
  anime: "an anime / manga style illustration with crisp line art and cel shading",
  realistic: "a realistic coloured-pencil drawing with soft blended shading",
  watercolour: "a watercolour and ink illustration with soft washes over ink lines",
  chibi: "a cute chibi style illustration with big head, small body and simple shading",
};

function finalPrompt(style) {
  return (
    `Redraw this image as a finished hand-drawn illustration in the style of ${STYLES[style]}, ` +
    "with clear outlines, full colour and shading. Keep the same subject, pose, composition and framing."
  );
}

// ---------------------------------------------------------------------------
// Gemini calls
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function callGemini(model, body) {
  if (!API_KEY) throw new HttpError(500, "GEMINI_API_KEY is not set on the server. Add it to .env and restart.");

  const url = `${API_BASE}/models/${encodeURIComponent(model)}:generateContent`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": API_KEY },
      body: JSON.stringify(body),
    });
    if (res.ok) return res.json();

    const text = await res.text();
    // Retry rate limits and transient overloads a couple of times with backoff.
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      continue;
    }
    let message = text;
    try {
      message = JSON.parse(text).error?.message || text;
    } catch {}
    throw new HttpError(res.status === 429 ? 429 : 502, `Gemini error (${res.status}): ${message}`);
  }
}

function responseParts(data) {
  const candidate = data.candidates?.[0];
  if (!candidate) {
    const reason = data.promptFeedback?.blockReason;
    throw new HttpError(422, reason ? `Gemini blocked this request (${reason}).` : "Gemini returned no result.");
  }
  return candidate.content?.parts || [];
}

const PLAN_SCHEMA = {
  type: "OBJECT",
  properties: {
    subject: { type: "STRING", description: "Short name of what is being drawn, e.g. 'Sleeping orange cat'." },
    difficulty: { type: "STRING", enum: ["Beginner", "Intermediate", "Advanced"] },
    estimatedTime: { type: "STRING", description: "Rough total drawing time, e.g. '45 minutes'." },
    materials: { type: "ARRAY", items: { type: "STRING" } },
    palette: {
      type: "ARRAY",
      description: "4 to 8 main colours needed.",
      items: {
        type: "OBJECT",
        properties: { name: { type: "STRING" }, hex: { type: "STRING", description: "#RRGGBB" } },
        required: ["name", "hex"],
      },
    },
    steps: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          id: { type: "STRING", enum: STAGES.map((s) => s.id) },
          title: { type: "STRING" },
          instructions: { type: "ARRAY", items: { type: "STRING" } },
          tip: { type: "STRING" },
        },
        required: ["id", "title", "instructions"],
      },
    },
  },
  required: ["subject", "difficulty", "materials", "palette", "steps"],
};

async function makePlan(image, style) {
  const styleNote = STYLES[style]
    ? `The learner wants to draw it as ${STYLES[style]}.`
    : "Keep the style of the reference image.";
  const prompt =
    "You are a patient drawing teacher. Look at this reference image and write a step-by-step guide for drawing it by hand. " +
    `${styleNote}\n\nWrite exactly one step for each of these stages, in this order:\n` +
    STAGES.map((s, i) => `${i + 1}. id "${s.id}" — ${s.title}`).join("\n") +
    "\n\nFor each step give 3-6 short, concrete instructions specific to THIS image (which shapes to use for which parts, " +
    "where to place them, which lines to keep, which colours go where, where the light comes from), plus one helpful tip. " +
    "Also list the materials needed and the main colour palette as hex codes.";

  const data = await callGemini(TEXT_MODEL, {
    contents: [{ role: "user", parts: [{ inline_data: { mime_type: image.mimeType, data: image.data } }, { text: prompt }] }],
    generationConfig: { responseMimeType: "application/json", responseSchema: PLAN_SCHEMA },
  });

  const text = responseParts(data).map((p) => p.text || "").join("");
  let plan;
  try {
    plan = JSON.parse(text);
  } catch {
    throw new HttpError(502, "Gemini returned a plan that wasn't valid JSON. Please try again.");
  }

  // Normalise to exactly our stages, in order, even if the model skipped or reordered some.
  const byId = Object.fromEntries((plan.steps || []).map((s) => [s.id, s]));
  plan.steps = STAGES.map((stage) => ({
    id: stage.id,
    title: byId[stage.id]?.title || stage.title,
    instructions: byId[stage.id]?.instructions?.length ? byId[stage.id].instructions : [],
    tip: byId[stage.id]?.tip || "",
  }));
  plan.palette = (plan.palette || []).filter((c) => /^#[0-9a-f]{6}$/i.test(c.hex));
  plan.materials ||= [];
  return plan;
}

async function makeStageImage(stageId, source, style) {
  const stage = STAGE_BY_ID[stageId];
  const prompt = `${stageId === "final" ? finalPrompt(style) : stage.prompt} ${KEEP_ALIGNED}`;

  const data = await callGemini(IMAGE_MODEL, {
    contents: [{ role: "user", parts: [{ inline_data: { mime_type: source.mimeType, data: source.data } }, { text: prompt }] }],
    generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
  });

  for (const part of responseParts(data)) {
    const inline = part.inlineData || part.inline_data;
    if (inline?.data) return { mimeType: inline.mimeType || inline.mime_type || "image/png", data: inline.data };
  }
  throw new HttpError(502, "Gemini didn't return an image for this stage. Try regenerating it.");
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Image is too large (max 20 MB).");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body must be JSON.");
  }
}

function validateImage(image) {
  if (!image || typeof image.data !== "string" || !ALLOWED_MIME.has(image.mimeType)) {
    throw new HttpError(400, "Send an image as { mimeType: 'image/png' | 'image/jpeg' | 'image/webp', data: <base64> }.");
  }
  return image;
}

function validateStyle(style) {
  return Object.hasOwn(STYLES, style) ? style : "original";
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

async function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const filePath = path.join(PUBLIC_DIR, urlPath === "/" ? "index.html" : urlPath);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: "Forbidden" });
  try {
    const body = await fs.readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream" });
    res.end(body);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/api/config") {
      return sendJson(res, 200, {
        hasKey: Boolean(API_KEY),
        stages: STAGES.map(({ id, title }) => ({ id, title })),
        styles: Object.keys(STYLES),
      });
    }
    if (req.method === "POST" && req.url === "/api/plan") {
      const body = await readJson(req);
      const plan = await makePlan(validateImage(body.image), validateStyle(body.style));
      return sendJson(res, 200, plan);
    }
    if (req.method === "POST" && req.url === "/api/stage") {
      const body = await readJson(req);
      if (!STAGE_BY_ID[body.stage]) throw new HttpError(400, "Unknown stage.");
      const image = await makeStageImage(body.stage, validateImage(body.image), validateStyle(body.style));
      return sendJson(res, 200, { image });
    }
    if (req.method === "GET") return serveStatic(req, res);
    sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error(err);
    sendJson(res, status, { error: err.message || "Something went wrong." });
  }
});

server.listen(PORT, () => {
  console.log(`Draw Guide running at http://localhost:${PORT}`);
  if (!API_KEY) console.warn("Warning: GEMINI_API_KEY is not set — copy .env.example to .env and add your key.");
});
