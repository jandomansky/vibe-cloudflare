// functions/api/objects.js
// POST /api/objects
// multipart/form-data field: "file" (image/*)
// Workers AI (LLaVA) expects raw image bytes as an array of ints (0..255).
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

    // Debug: fingerprint to ensure different images are actually sent
    const imageFingerprint = (await sha256Hex(bytes)).slice(0, 12);

    // ✅ Prompt tuned for "ALL objects" behavior
    // - Avoid guessing / hallucinating
    // - Return as many objects as possible (30+ if present)
    // - Use low confidence for uncertain detections
    // - Strict JSON only
const prompt =
  "Vrať pouze čistý JSON. Žádný markdown, žádné vysvětlení.\n" +
  "Úkol: Najdi a vypiš VŠECHNY viditelné FYZICKÉ objekty na obrázku (věci/předměty). " +
  "Nevymýšlej role ani vztahy (ne 'máma', ne 'děti'). Použij obecně 'člověk' nebo 'osoba'. " +
  "Nevymýšlej místa/scény (ne 'pláž').\n\n" +
  "JSON formát:\n" +
  "{\"caption\":\"...\",\"objects\":[{\"name\":\"...\",\"confidence\":\"low|medium|high\"}]}\n\n" +
  "Pravidla:\n" +
  "- caption = 1 faktická věta česky, co je vidět.\n" +
  "- objects = co nejdelší seznam objektů (klidně 30+), bez duplicit.\n" +
  "- name musí být krátký konkrétní český název objektu (např. jeřáb, bagr, náklaďák, helma, reflexní vesta, beton, bednění, armatura, paleta, cihla, kolečko).\n" +
  "- Pokud si nejsi jistý, dej confidence=low.\n" +
  "- NESMÍŠ vracet šablonové texty typu 'konkrétní český název'. Vrať skutečné objekty z fotky.\n";


    const ai = await env.AI.run(MODEL, {
      image,
      prompt,
      // víc prostoru pro dlouhý seznam objektů
      max_tokens: 1400,
    });

    const description =
      ai?.description ??
      ai?.result ??
      ai?.response ??
      (typeof ai === "string" ? ai : "");

    const parsed = tryParseJsonFromText(description);

    if (parsed && Array.isArray(parsed.objects)) {
      const caption = typeof parsed.caption === "string" ? parsed.caption.trim() : "";
      const cleaned = cleanObjects(parsed.objects);

      return json({
        ok: true,
        model: MODEL,
        imageFingerprint,
        caption,
        objects: cleaned,
        // raw nechávám kvůli ladění; později můžeš odstranit
        raw: ai,
      });
    }

    // fallback (když model vrátí ne-JSON)
    return json({
      ok: true,
      model: MODEL,
      imageFingerprint,
      caption: "",
      objects: extractObjectsFromText(description),
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

  let s = text.trim();

  // 1) direct parse (ideal case)
  try {
    return JSON.parse(s);
  } catch {}

  // 2) If it's a JSON string (wrapped in quotes), parse twice
  //    e.g. "\"{\\\"objects\\\":[...] }\""
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    try {
      const inner = JSON.parse(s); // now inner should be a string like {\"objects\":...}
      if (typeof inner === "string") {
        const r = tryParseJsonFromText(inner);
        if (r) return r;
      }
    } catch {}
  }

  // 3) If it looks like escaped JSON without outer quotes: {\"objects\":[...]}
  //    Unescape common sequences and try again.
  if (s.includes('\\"') || s.includes('\\"') || s.includes('{\\"') || s.includes('\\"objects\\"') || s.includes('\\"caption\\"') || s.includes('\\"name\\"') || s.includes('\\"confidence\\"') || s.includes('\\"')) {
    const unescaped = s
      .replace(/\\r\\n/g, "\n")
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'")
      .replace(/\\\\/g, "\\");

    try {
      return JSON.parse(unescaped);
    } catch {}
  }

  // 4) Try to extract first {...} block and repeat the same strategy
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const sub = s.slice(start, end + 1);

    // Try direct
    try {
      return JSON.parse(sub);
    } catch {}

    // Try unescaped
    const unescapedSub = sub
      .replace(/\\r\\n/g, "\n")
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'")
      .replace(/\\\\/g, "\\");

    try {
      return JSON.parse(unescapedSub);
    } catch {}
  }

  return null;
}

function cleanObjects(objects) {
  const out = [];

  for (const o of objects) {
    if (!o || typeof o !== "object") continue;

    let name = typeof o.name === "string" ? o.name.trim() : "";
    let confidence = typeof o.confidence === "string" ? o.confidence.trim() : "";

    if (!name) continue;

    // forbid placeholders
    const lower = name.toLowerCase();
    if (name === "..." || lower === "xxx" || lower === "object") continue;

    // normalize confidence
    confidence = confidence.toLowerCase();
    if (!["low", "medium", "high"].includes(confidence)) {
      // pokud model vrátí něco jiného, odhadni low
      confidence = "low";
    }

    // remove too abstract / useless terms
    if (["scéna", "prostředí", "pozadí", "situace"].includes(lower)) continue;

    // de-dup by name (case-insensitive)
    if (out.some(x => x.name.toLowerCase() === lower)) continue;

    out.push({ name, confidence });
  }

  return out;
}

// Simple fallback extraction (keeps it conservative)
function extractObjectsFromText(text) {
  if (!text || typeof text !== "string") return [];

  const raw = text
    .replace(/\s+/g, " ")
    .replace(/[•·]/g, ",")
    .split(/[,;:\n]/)
    .map(s => s.trim())
    .filter(Boolean);

  const cleaned = [];
  for (const s of raw) {
    const t = s.replace(/^[-–—]\s*/, "").replace(/\.$/, "").trim();
    if (!t) continue;
    if (t.length > 40) continue;
    if (t.toLowerCase().includes("json")) continue;
    if (t === "..." || t.toLowerCase() === "object") continue;
    cleaned.push(t);
  }

  const uniq = [];
  for (const t of cleaned) {
    if (uniq.some(x => x.toLowerCase() === t.toLowerCase())) continue;
    uniq.push(t);
  }

  return uniq.slice(0, 40).map(name => ({ name, confidence: "low" }));
}

async function sha256Hex(u8) {
  const buf = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  const arr = Array.from(new Uint8Array(hash));
  return arr.map(b => b.toString(16).padStart(2, "0")).join("");
}
