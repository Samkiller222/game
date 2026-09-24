# ✏️ Draw Guide

Upload any image and get a step-by-step guide to drawing it, with a picture for every stage:

1. **Basic shapes**: construction circles, boxes and guidelines
2. **Rough sketch**: loose pencil forms
3. **Clean line art**: confident final outlines
4. **Details**: features, textures and hatching
5. **Base colours**: flat colour fills
6. **Shading & finishing**: the finished piece

Each step also gets written instructions specific to your image, plus a list of materials and a colour palette.

## How it works

- `public/` is a plain HTML/CSS/JS frontend. It shrinks the upload to 1024px and sends it to the server.
- `server.js` is a zero-dependency Node server that keeps your Gemini API key private and calls Gemini:
  - **Text model** (`gemini-2.5-flash`): looks at the image and returns the written guide as structured JSON.
  - **Image model** (`gemini-2.5-flash-image`): makes each stage picture.
- The stage pictures are generated **backwards** (finished → colours → details → line art → sketch → shapes).
  Each one is made by *removing* something from the next stage, so the steps line up far better than
  drawing each one from scratch. Use **Redraw** on any step to regenerate it and the steps before it.

## Run it

Requires Node.js 20.12 or newer. There's nothing to `npm install`.

```bash
cp .env.example .env      # then put your key in .env
npm start                 # http://localhost:3000
```

Get a free API key at <https://aistudio.google.com/apikey>.

### Configuration (`.env`)

| Variable | Default | |
|---|---|---|
| `GEMINI_API_KEY` | (required) | Your Gemini API key |
| `PORT` | `3000` | Server port |
| `GEMINI_TEXT_MODEL` | `gemini-2.5-flash` | Model that writes the instructions |
| `GEMINI_IMAGE_MODEL` | `gemini-2.5-flash-image` | Model that draws the stages. Try a newer/pro image model for better consistency |

## Notes

- One guide costs 1 text call and 5–6 image calls, and takes about 1–2 minutes.
- For photos, choose a drawing style (cartoon, anime, …) so the guide teaches a drawing instead of copying a photo.
  "Keep the original style" uses your upload as the final step.
- Deploy anywhere that runs Node (Render, Railway, Fly.io, a VPS…) and set `GEMINI_API_KEY` as an environment variable there.
