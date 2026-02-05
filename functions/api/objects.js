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

    bytes = new Uint8Array(await file.arrayBuffer());
    const image = Array.from(bytes);

    // ✅ Debug: hash obrázku (abychom věděli, že se skutečně mění)
    const sha = await sha256Hex(bytes);
    const imageFingerprint = sha.slice(0, 12); // zkráceně

    // ✅ Nový prompt: méně biasu, víc reality
    const prompt =
      "Jsi přesný vizuální analyzátor. Nehádej a nevymýšlej. " +
      "Pokud si nejsi jistý objektem, NEUVÁDĚJ ho. " +
      "Nepředpokládej stavbu ani stavební prostředí, pokud to není jasně vidět. " +
      "Vrať POUZE platný JSON bez markdownu a bez dalšího textu.\n\n" +
      'Formát: {"caption":"...","objects":[{"name":"...","confidence":"low|medium|high"}]}\n' +
      "caption = jedna věta česky, co je na fotce. " +
      "objects = 5–12 konkrétních objektů, pouze to co opravdu vidíš.\n" +
      "Zakázáno: placeholdery jako \"...\", \"object\", \"xxx\".\n";

    const ai = await env.AI.run(MODEL, {
      image,
      prompt,
      max_tokens: 512,
    });

    const description =
      ai?.description ??
      ai?.result ??
      ai?.response ??
      (typeof ai === "string" ? ai : "");

    const parsed = tryParseJsonFromText(description);

    if (parsed && Array.isArray(parsed.objects)) {
      const cleaned = cleanObjects(parsed.objects);
      const caption = typeof parsed.caption === "string" ? parsed.caption.trim() : "";

      return json({
        ok: true,
        model: MODEL,
        imageFingerprint,
        bytesLength: bytes.length,
        caption,
        objects: cleaned,
        raw: ai,
      });
    }

    // fallback, když model nevrátí JSON
    return json({
      ok: true,
      model: MODEL,
      imageFingerprint,
      bytesLength: bytes.length,
      caption: "",
      objects: [],
      note: "Model returned non-JSON output; see description/raw.",
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

function cleanObjects(objects) {
  const out = [];
  for (const o of objects) {
    if (!o || typeof o !== "object") continue;

    const name = typeof o.name === "string" ? o.name.trim() : "";
    const confidence = typeof o.confidence === "string" ? o.confidence.trim() : "";

    if (!name) continue;
    const lower = name.toLowerCase();
    if (name === "..." || lower === "xxx" || lower === "object") continue;
    if (!["low", "medium", "high"].includes(confidence)) continue;

    if (out.some(x => x.name.toLowerCase() === lower)) continue;
    out.push({ name, confidence });
  }
  return out;
}

async function sha256Hex(u8) {
  // u8 -> ArrayBuffer
  const buf = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  const arr = Array.from(new Uint8Array(hash));
  return arr.map(b => b.toString(16).padStart(2, "0")).join("");
}
