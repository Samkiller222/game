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

It's a fully static site (HTML/CSS/JS, no build step), so it runs on **GitHub Pages**.

- `index.html`, `style.css` and `app.js` are the page and UI. Uploads are shrunk to 1024px in the browser.
- `gemini.js` calls the Gemini API directly from the browser:
  - **Text model** (`gemini-2.5-flash`): looks at the image and returns the written guide as structured JSON.
  - **Image model** (`gemini-2.5-flash-image`): makes each stage picture.
- The stage pictures are generated **backwards** (finished → colours → details → line art → sketch → shapes).
  Each one is made by *removing* something from the next stage, so the steps line up far better than
  drawing each one from scratch. Use **Redraw** on any step to regenerate it and the steps before it.

## Your API key

GitHub Pages can't keep secrets, so **the key is never stored in this repo**. Each visitor pastes their own
free key from [Google AI Studio](https://aistudio.google.com/apikey) into the page. It's saved in that
browser's `localStorage` and sent only to Google. Use **Change or remove key** to clear it.

Never commit an API key to this repo. It would be public, and Google automatically disables leaked keys.

## Publish on GitHub Pages

1. On GitHub go to **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
3. Choose the branch with this code and the **/ (root)** folder, then **Save**.
4. After a minute the site is live at `https://<your-username>.github.io/<repo-name>/`.

## Run it locally

Any static file server works, for example:

```bash
python3 -m http.server 8000   # then open http://localhost:8000
```

(Opening `index.html` directly as a file won't work, because browsers block ES modules on `file://`.)

## Notes

- One guide costs 1 text call and 5–6 image calls, and takes about 1–2 minutes.
- For photos, choose a drawing style (cartoon, anime, …) so the guide teaches a drawing instead of copying a photo.
  "Keep the original style" uses your upload as the final step.
- To change models, edit `TEXT_MODEL` / `IMAGE_MODEL` at the top of `gemini.js`.
