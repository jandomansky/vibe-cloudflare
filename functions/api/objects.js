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

    // Binding must exist in Pages project (not in a separate Worker)
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

    // ✅ RAW bytes for LLaVA (per Cloudflare docs)
    bytes = new Uint8Array(await file.arrayBuffer());
    const image = Array.from(bytes);

    // ✅ Prompt: force real objects (no placeholder examples)
    const prompt =
      "Jsi API pro tagování obrázků. Vrať POUZE platný JSON (žádný markdown, žádné vysvětlení, žádný další text). " +
      'Výstup MUSÍ být přesně ve formátu: {"objects":[{"name":"...","confidence":"low|medium|high"}]}. ' +
      "Ale POZOR: v poli objects NESMÍ být žádné placeholdery jako \"...\", \"xxx\", \"object\" ani prázdné názvy. " +
      "Každý name musí být konkrétní české podstatné jméno (např. \"auto\", \"jeřáb\", \"helma\", \"beton\", \"člověk\"). " +
      "Zkus najít aspoň 5 objektů; když jich je méně, vrať tolik, kolik opravdu vidíš. " +
      'Pokud nepoznáš vůbec nic, vrať přesně {"objects":[]}.' +
      "\n\nDŮLEŽITÉ: Nevracej příklad. Vracej skutečné objekty z obrázku.";

    const ai = await env.AI.run(MODEL, {
      image,          // array of ints
      prompt,         // string prompt
      max_tokens: 512,
    });

    // Cloudflare docs show output like { description: "..." }
    const description =
      ai?.description ??
      ai?.result ??
      ai?.response ??
      (typeof ai === "string" ? ai : "");

    // 1) Try parse JSON from description
    const parsed = tryParseJsonFromText(description);

    if (parsed && Array.isArray(parsed.objects)) {
      const cleaned = cleanObjects(parsed.objects);
      return json({ ok: true, model: MODEL, objects: cleaned, raw: ai });
    }

    // 2) Fallback: extract tags from free text description
    const fallbackObjects = extractObjectsFromText(description);
    return json({
      ok: true,
      model: MODEL,
      objects: fallbackObjects,
      note: "Model returned non-JSON; objects were extracted from text fallback.",
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

  // direct parse
  try {
    return JSON.parse(s);
  } catch {}

  // try to find first {...} block
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

    // de-dup by name
    if (out.some(x => x.name.toLowerCase() === lower)) continue;

    out.push({ name, confidence });
  }

  return out;
}

// Very simple fallback: turn description into tags.
// We keep it conservative; you can refine later into a Metrostav dictionary.
function extractObjectsFromText(text) {
  if (!text || typeof text !== "string") return [];

  // Split by common separators
  const raw = text
    .replace(/\s+/g, " ")
    .replace(/[•·]/g, ",")
    .split(/[,;:\n]/)
    .map(s => s.trim())
    .filter(Boolean);

  // Keep short-ish noun-like fragments, remove obvious noise
  const cleaned = [];
  for (const s of raw) {
    const t = s
      .replace(/^[-–—]\s*/, "")
      .replace(/\.$/, "")
      .trim();

    if (!t) continue;
    if (t.length > 40) continue;
    if (t.toLowerCase().includes("json")) continue;
    if (t === "..." || t.toLowerCase() === "object") continue;

    cleaned.push(t);
  }

  // de-dup and map to confidence=low (fallback guess)
  const uniq = [];
  for (const t of cleaned) {
    if (uniq.some(x => x.toLowerCase() === t.toLowerCase())) continue;
    uniq.push(t);
  }

  // limit to 15 to stay tidy
  return uniq.slice(0, 15).map(name => ({ name, confidence: "low" }));
}
