// functions/api/objects.js
// POST /api/objects
// multipart/form-data field: "file" (image/*)
// Uses Workers AI (LLaVA) with raw image bytes (array of 0–255)
// Returns JSON only.

const MODEL = "@cf/llava-hf/llava-1.5-7b-hf";

export async function onRequestPost({ request, env }) {
  let bytes = null;

  try {
    const ct = request.headers.get("content-type") || "";
    if (!ct.includes("multipart/form-data")) {
      return json({ ok: false, error: "Send multipart/form-data with field 'file'." }, 400);
    }

    const form = await request.formData();
    const file = form.get("file");

    const isImage =
      file &&
      typeof file === "object" &&
      typeof file.arrayBuffer === "function" &&
      typeof file.type === "string" &&
      file.type.startsWith("image/");

    if (!isImage) {
      return json({ ok: false, error: "Missing or invalid image file (field 'file')." }, 400);
    }

    if (!env.AI || typeof env.AI.run !== "function") {
      return json(
        {
          ok: false,
          error:
            "Workers AI binding 'AI' is missing in Pages project. Add: Pages → Settings → Functions → Bindings → Workers AI, name it AI.",
        },
        500
      );
    }

    // ✅ RAW bytes → array of ints 0..255 (what LLaVA expects on Workers AI)
    bytes = new Uint8Array(await file.arrayBuffer());
    const image = Array.from(bytes);

    // LLaVA endpoint uses `prompt` (not chat messages) on Workers AI docs. :contentReference[oaicite:1]{index=1}
    const prompt =
      'Vrať POUZE platný JSON (bez markdownu a bez vysvětlování) ve tvaru {"objects":[{"name":"...","confidence":"low|medium|high"}]}. ' +
      "Vyjmenuj objekty na fotce česky. Nedělej duplicity, používej nejběžnější název.";

    const ai = await env.AI.run(MODEL, {
      image,        // <-- array of ints
      prompt,       // <-- prompt string
      max_tokens: 512,
    });

    // Podle docs je output typicky { description: "..." } :contentReference[oaicite:2]{index=2}
    const description =
      ai?.description ??
      ai?.result ??
      ai?.response ??
      (typeof ai === "string" ? ai : "");

    // Pokus: vytáhnout JSON z description
    const parsed = tryParseJsonFromText(description);

    if (parsed && Array.isArray(parsed.objects)) {
      return json({ ok: true, model: MODEL, objects: parsed.objects, raw: ai });
    }

    // Fallback: vrať aspoň popis (a raw) pro ladění promptu
    return json({
      ok: true,
      model: MODEL,
      objects: [],
      note: "Model returned non-JSON output; see description/raw and we will tighten the prompt.",
      description,
      raw: ai,
    });
  } catch (e) {
    return json(
      {
        ok: false,
        model: MODEL,
        error: String(e),
        debug: { bytesLength: bytes?.length ?? null },
      },
      500
    );
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function tryParseJsonFromText(text) {
  if (!text || typeof text !== "string") return null;
  const s = text.trim();

  try {
    return JSON.parse(s);
  } catch {}

  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const sub = s.slice(start, end + 1);
    try {
      return JSON.parse(sub);
    } catch {}
  }
  return null;
}
