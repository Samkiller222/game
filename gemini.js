// Gemini API calls, made directly from the browser with the user's own API key.
// (GitHub Pages is static hosting, so there's no server to hide a key behind.)

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

// Google retires model versions regularly, so the models are picked at runtime
// from the ones the user's key can actually use (newest Flash wins). These are
// only fallbacks if listing models fails.
const FALLBACK_TEXT_MODEL = "gemini-3.6-flash";
const FALLBACK_IMAGE_MODEL = "gemini-3.1-flash-image";

let modelCache = null; // { apiKey, promise } — shared so parallel calls list models once

export function resolveModels(apiKey) {
  if (modelCache?.apiKey !== apiKey) modelCache = { apiKey, promise: pickModels(apiKey) };
  return modelCache.promise;
}

async function pickModels(apiKey) {
  let names = [];
  try {
    let pageToken = "";
    do {
      const res = await fetch(`${API_BASE}/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`, {
        headers: { "x-goog-api-key": apiKey },
      });
      if (!res.ok) break;
      const data = await res.json();
      for (const m of data.models || []) {
        if (m.supportedGenerationMethods?.includes("generateContent")) names.push(m.name.replace(/^models\//, ""));
      }
      pageToken = data.nextPageToken || "";
    } while (pageToken);
  } catch {
    names = [];
  }

  return {
    text: pickNewest(names, /^gemini-(\d+(?:\.\d+)*)-flash(-preview(-[\w-]+)?)?$/) || FALLBACK_TEXT_MODEL,
    image:
      pickNewest(names, /^gemini-(\d+(?:\.\d+)*)-flash-image(-preview(-[\w-]+)?)?$/) ||
      pickNewest(names, /^gemini-(\d+(?:\.\d+)*)-pro-image(-preview(-[\w-]+)?)?$/) ||
      pickNewest(names, /^gemini-(\d+(?:\.\d+)*)-[\w-]*image[\w-]*$/) ||
      FALLBACK_IMAGE_MODEL,
  };
}

// Stable models beat previews (previews have tight limits and change often); then the highest version wins.
function pickNewest(names, pattern) {
  let best = null;
  for (const name of names) {
    const match = name.match(pattern);
    if (!match) continue;
    const version = match[1].split(".").map(Number);
    while (version.length < 3) version.push(0);
    const preview = name.includes("preview") ? 0 : 1;
    const score = [preview, ...version];
    if (!best || compare(score, best.score) > 0) best = { name, score };
  }
  return best?.name || null;
}

function compare(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

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
// API calls
// ---------------------------------------------------------------------------

async function callGemini(apiKey, model, body) {
  const url = `${API_BASE}/models/${encodeURIComponent(model)}:generateContent`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
    });
    if (res.ok) return res.json();

    const text = await res.text();
    // Retry rate limits and transient overloads a couple of times with backoff.
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      continue;
    }
    if (res.status === 404) modelCache = null; // model retired: re-pick next time
    let message = text;
    try {
      message = JSON.parse(text).error?.message || text;
    } catch {}
    throw new Error(`Gemini error (${res.status}): ${message}`);
  }
}

function responseParts(data) {
  const candidate = data.candidates?.[0];
  if (!candidate) {
    const reason = data.promptFeedback?.blockReason;
    throw new Error(reason ? `Gemini blocked this request (${reason}).` : "Gemini returned no result.");
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

export async function makePlan(apiKey, image, style) {
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

  const { text: model } = await resolveModels(apiKey);
  const data = await callGemini(apiKey, model, {
    contents: [{ role: "user", parts: [{ inline_data: { mime_type: image.mimeType, data: image.data } }, { text: prompt }] }],
    generationConfig: { responseMimeType: "application/json", responseSchema: PLAN_SCHEMA },
  });

  const text = responseParts(data).map((p) => p.text || "").join("");
  let plan;
  try {
    plan = JSON.parse(text);
  } catch {
    throw new Error("Gemini returned a plan that wasn't valid JSON. Please try again.");
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

export async function makeStageImage(apiKey, stageId, source, style) {
  const stage = STAGE_BY_ID[stageId];
  const prompt = `${stageId === "final" ? finalPrompt(style) : stage.prompt} ${KEEP_ALIGNED}`;

  const { image: model } = await resolveModels(apiKey);
  const data = await callGemini(apiKey, model, {
    contents: [{ role: "user", parts: [{ inline_data: { mime_type: source.mimeType, data: source.data } }, { text: prompt }] }],
    generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
  });

  for (const part of responseParts(data)) {
    const inline = part.inlineData || part.inline_data;
    if (inline?.data) return { mimeType: inline.mimeType || inline.mime_type || "image/png", data: inline.data };
  }
  throw new Error("Gemini didn't return an image for this stage. Try redrawing it.");
}
