// Draw Guide frontend. Runs entirely in the browser (GitHub Pages friendly).

import { STAGES, makePlan, makeStageImage } from "./gemini.js";

const MAX_SIDE = 1024; // downscale uploads to save bandwidth and tokens
const KEY_STORAGE = "draw-guide:gemini-key";

const els = {
  keyForm: document.getElementById("key-form"),
  keyInput: document.getElementById("key-input"),
  keySaved: document.getElementById("key-saved"),
  keyForget: document.getElementById("key-forget"),
  dropzone: document.getElementById("dropzone"),
  fileInput: document.getElementById("file-input"),
  preview: document.getElementById("preview"),
  hint: document.getElementById("dropzone-hint"),
  style: document.getElementById("style-select"),
  generate: document.getElementById("generate-btn"),
  status: document.getElementById("status"),
  guide: document.getElementById("guide"),
  summary: document.getElementById("summary"),
  steps: document.getElementById("steps"),
  template: document.getElementById("step-template"),
};

const stages = STAGES; // in drawing order
let reference = null; // { mimeType, data } of the uploaded (downscaled) image
let apiKey = "";

// State of the current run. Bumping runId makes older in-flight requests ignore their results.
let run = null;
let runId = 0;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

try {
  apiKey = localStorage.getItem(KEY_STORAGE) || "";
} catch {
  // storage blocked (private mode etc.) — the key just won't be remembered
}
showKeyState();

els.keyForm.addEventListener("submit", (e) => {
  e.preventDefault();
  apiKey = els.keyInput.value.trim();
  if (!apiKey) return;
  try {
    localStorage.setItem(KEY_STORAGE, apiKey);
  } catch {}
  els.keyInput.value = "";
  showKeyState();
});

els.keyForget.addEventListener("click", () => {
  apiKey = "";
  try {
    localStorage.removeItem(KEY_STORAGE);
  } catch {}
  showKeyState();
  els.keyInput.focus();
});

function showKeyState() {
  els.keyForm.hidden = Boolean(apiKey);
  els.keySaved.hidden = !apiKey;
  els.generate.disabled = !(apiKey && reference);
}

els.fileInput.addEventListener("change", () => loadFile(els.fileInput.files[0]));

for (const type of ["dragenter", "dragover"]) {
  els.dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    els.dropzone.classList.add("dragging");
  });
}
for (const type of ["dragleave", "drop"]) {
  els.dropzone.addEventListener(type, () => els.dropzone.classList.remove("dragging"));
}
els.dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  loadFile(e.dataTransfer.files[0]);
});

els.generate.addEventListener("click", startGuide);

// ---------------------------------------------------------------------------
// Upload handling
// ---------------------------------------------------------------------------

async function loadFile(file) {
  if (!file) return;
  if (!file.type.startsWith("image/")) return setStatus("That file isn't an image.", true);
  try {
    reference = await downscale(file);
  } catch {
    return setStatus("Couldn't read that image. Try a PNG or JPG.", true);
  }
  els.preview.src = dataUrl(reference);
  els.preview.hidden = false;
  els.hint.hidden = true;
  els.generate.disabled = !apiKey;
  setStatus("");
}

// Draw onto a canvas (white background, max 1024px) and export as JPEG.
async function downscale(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const url = canvas.toDataURL("image/jpeg", 0.9);
  return { mimeType: "image/jpeg", data: url.slice(url.indexOf(",") + 1) };
}

// ---------------------------------------------------------------------------
// Generating the guide
// ---------------------------------------------------------------------------

async function startGuide() {
  if (!reference) return;
  if (!apiKey) return setStatus("Add your Gemini API key first.", true);
  const id = ++runId;
  run = {
    id,
    apiKey,
    style: els.style.value,
    images: {}, // stageId -> { mimeType, data }
    busy: new Set(),
  };

  els.guide.hidden = false;
  els.summary.innerHTML = `<p class="meta">Studying your picture…</p>`;
  renderStepCards();
  els.generate.disabled = true;
  setStatus("Writing the guide and drawing each stage. This usually takes a minute or two…");

  // The written plan and the pictures are independent, so do both at once.
  const planDone = loadPlan(id);
  const imagesDone = runChainFrom(stages.length - 1, id);
  await Promise.allSettled([planDone, imagesDone]);

  if (id !== runId) return;
  els.generate.disabled = !apiKey;
  const failed = stages.some((s) => !run.images[s.id]);
  setStatus(failed ? "Some steps failed. Use “Try again” on a step to retry it." : "Your guide is ready. Happy drawing!", failed);
}

async function loadPlan(id) {
  try {
    const plan = await makePlan(run.apiKey, reference, run.style);
    if (id !== runId) return;
    renderSummary(plan);
    for (const step of plan.steps) renderInstructions(step);
  } catch (err) {
    if (id !== runId) return;
    els.summary.innerHTML = "";
    const p = document.createElement("p");
    p.className = "status error";
    p.textContent = `Couldn't write the instructions: ${err.message}`;
    const retry = document.createElement("button");
    retry.textContent = "Try again";
    retry.onclick = () => {
      els.summary.innerHTML = `<p class="meta">Studying your picture…</p>`;
      loadPlan(id);
    };
    els.summary.append(p, retry);
    for (const s of stages) renderInstructions({ id: s.id, title: s.title, instructions: [], tip: "" });
  }
}

// Stage images are generated backwards (final -> shapes). Each one is made
// from the stage after it, so a failure pauses everything before it.
async function runChainFrom(index, id) {
  for (let i = index; i >= 0; i--) {
    const stage = stages[i];
    if (run.images[stage.id]) continue;
    const source = i === stages.length - 1 ? reference : run.images[stages[i + 1].id];

    // "Keep the original style": the finished stage is just the uploaded image.
    if (stage.id === "final" && run.style === "original") {
      run.images.final = reference;
      showImage(stage, reference);
      continue;
    }

    showLoading(stage);
    run.busy.add(stage.id);
    try {
      const image = await makeStageImage(run.apiKey, stage.id, source, run.style);
      if (id !== runId) return;
      run.images[stage.id] = image;
      showImage(stage, image);
    } catch (err) {
      if (id !== runId) return;
      showError(stage, i, err.message);
      for (let j = i - 1; j >= 0; j--) showWaiting(stages[j], "Waiting for the step after this one");
      return;
    } finally {
      run.busy.delete(stage.id);
    }
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderStepCards() {
  els.steps.innerHTML = "";
  stages.forEach((stage, i) => {
    const card = els.template.content.firstElementChild.cloneNode(true);
    card.id = `step-${stage.id}`;
    card.querySelector(".step-number").textContent = `Step ${i + 1}`;
    card.querySelector(".step-title").textContent = stage.title;
    card.querySelector(".step-instructions").innerHTML = `<li class="loading">Writing instructions…</li>`;
    els.steps.append(card);
    showWaiting(stage, "Queued");
  });
}

function renderSummary(plan) {
  els.summary.innerHTML = "";
  const h2 = document.createElement("h2");
  h2.textContent = `How to draw: ${plan.subject}`;
  const meta = document.createElement("p");
  meta.className = "meta";
  meta.textContent = [plan.difficulty, plan.estimatedTime].filter(Boolean).join(" · ");
  els.summary.append(h2, meta);

  if (plan.materials.length) {
    els.summary.append(heading("You'll need"), chipList(plan.materials.map((m) => [m])));
  }
  if (plan.palette.length) {
    els.summary.append(heading("Colour palette"), chipList(plan.palette.map((c) => [c.name, c.hex])));
  }
}

function heading(text) {
  const h = document.createElement("h4");
  h.textContent = text;
  return h;
}

function chipList(items) {
  const ul = document.createElement("ul");
  ul.className = "chips";
  for (const [label, hex] of items) {
    const li = document.createElement("li");
    if (hex) {
      const dot = document.createElement("span");
      dot.className = "swatch";
      dot.style.background = hex;
      li.append(dot);
    }
    li.append(label);
    ul.append(li);
  }
  return ul;
}

function renderInstructions(step) {
  const card = document.getElementById(`step-${step.id}`);
  if (!card) return;
  card.querySelector(".step-title").textContent = step.title;
  const list = card.querySelector(".step-instructions");
  list.innerHTML = "";
  for (const text of step.instructions) {
    const li = document.createElement("li");
    li.textContent = text;
    list.append(li);
  }
  const tip = card.querySelector(".step-tip");
  tip.hidden = !step.tip;
  tip.textContent = step.tip ? `💡 ${step.tip}` : "";
}

function stageBox(stage) {
  const card = document.getElementById(`step-${stage.id}`);
  card.querySelector(".step-actions")?.remove();
  return card.querySelector(".step-image");
}

function placeholder(box, html) {
  box.innerHTML = `<div class="placeholder">${html}</div>`;
}

function showWaiting(stage, text) {
  placeholder(stageBox(stage), `<span>${text}</span>`);
}

function showLoading(stage) {
  placeholder(stageBox(stage), `<div class="spinner"></div><span>Drawing this stage…</span>`);
}

function showError(stage, index, message) {
  const box = stageBox(stage);
  placeholder(box, `<span class="error"></span>`);
  box.querySelector(".error").textContent = message;

  const retry = document.createElement("button");
  retry.textContent = "Try again";
  retry.onclick = () => retryFrom(index);
  box.closest(".step-media").append(actions(retry));
}

function showImage(stage, image) {
  const box = stageBox(stage);
  box.innerHTML = "";
  const img = document.createElement("img");
  img.alt = `${stage.title} stage`;
  img.src = dataUrl(image);
  box.append(img);

  const download = document.createElement("a");
  download.href = img.src;
  download.download = `step-${stages.indexOf(stage) + 1}-${stage.id}.${image.mimeType.split("/")[1] || "png"}`;
  download.textContent = "Download";
  const buttons = [download];

  // Regenerating an AI stage also regenerates the stages before it, so they stay consistent.
  if (!(stage.id === "final" && run.style === "original")) {
    const redo = document.createElement("button");
    redo.textContent = "Redraw";
    redo.title = "Redraw this stage (and the steps before it)";
    redo.onclick = () => retryFrom(stages.indexOf(stage));
    buttons.push(redo);
  }
  box.closest(".step-media").append(actions(...buttons));
}

function actions(...children) {
  const div = document.createElement("div");
  div.className = "step-actions";
  div.append(...children);
  return div;
}

async function retryFrom(index) {
  if (run.busy.size) return setStatus("Please wait for the current step to finish.", true);
  for (let j = index; j >= 0; j--) delete run.images[stages[j].id];
  for (let j = index - 1; j >= 0; j--) showWaiting(stages[j], "Queued");
  setStatus("Redrawing…");
  const id = runId;
  await runChainFrom(index, id);
  if (id !== runId) return;
  const failed = stages.some((s) => !run.images[s.id]);
  setStatus(failed ? "Some steps failed. Use “Try again” on a step to retry it." : "Your guide is ready. Happy drawing!", failed);
}

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle("error", isError);
}

function dataUrl(image) {
  return `data:${image.mimeType};base64,${image.data}`;
}
