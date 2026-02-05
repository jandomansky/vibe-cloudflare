// functions/api/objects.js
// POST /api/objects
// multipart/form-data field: "file" (image/*)
// Returns JSON: { ok: true, objects: [...] } or { ok:false, error: ... }

const MODEL = "@cf/meta/llama-3.2-11b-vision-instruct"; // ⚠️ tenhle u tebe hlásí EU/agree omezení – později vyměň

export async function onRequestPost({ request, env }) {
  try {
    // 1) Content-Type check
    const ct = request.headers.get("content-type") || "";
    if (!ct.includes("multipart/form-data")) {
      return json(
        {
          ok: false,
          error: "Send multipart/form-data with field 'file'.",
        },
        400
      );
    }

    // 2) Parse form
    const form = await request.formData();
    const file = form.get("file");

    // 3) Validate file without relying on global File
    const isImage =
      file &&
      typeof file === "object" &&
      typeof file.arrayBuffer === "function" &&
      typeof file.type === "string" &&
      file.type.startsWith("image/");

    if (!isImage) {
      return json(
        { ok: false, error: "Missing or invalid image file (field 'file')." },
        400
      );
    }

    // 4) Ensure Workers AI binding exists (Pages Functions binding must be named "AI")
    if (!env.AI || typeof env.AI.run !== "function") {
      return json(
        {
          ok: false,
          error:
            "Workers AI binding 'AI' is missing. Add it in Pages project: Settings → Functions → Bindings → Workers AI, name it AI.",
        },
        500
      );
    }

    // 5) Convert to base64 data URL
    const bytes = new Uint8Array(await file.arrayBuffer());
    const dataUrl = `data:${file.type};base64,${toBase64(bytes)}`;

    // 6) Prompt: force strict JSON output in Czech
    const messages = [
      {
        role: "system",
        content:
          "You are an image tagging API. Return ONLY valid JSON. No markdown, no explanations.",
      },
      {
        role: "user",
        content:
          'Analyze the image and return JSON EXACTLY in this schema: {"objects":[{"name":"...","confidence":"low|medium|high"}]}. Use Czech names for objects. Avoid duplicates; use the most common term.',
      },
    ];

    // 7) Call vision model
    const ai = await env.AI.run(MODEL, { messages, image: dataUrl });

    // 8) Normalize output to a simple {objects:[...]} if possible
    // Different models can return slightly different shapes; we try to extract JSON.
    const extracted = extractObjects(ai);

    return json({
      ok: true,
      model: MODEL,
      objects: extracted.objects,
      raw: extracted.rawIncluded ? ai : undefined,
    });
  } catch (e) {
    // Always return JSON errors (no Cloudflare HTML error page)
    return json(
      {
        ok: false,
        model: MODEL,
        error: String(e),
        hint:
          "If you see an 'agree' / EU restriction message, choose a different Workers AI vision model.",
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

function toBase64(u8) {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    s += String.fromCharCode(...u8.subarray(i, i + chunk));
  }
  return btoa(s);
}

/**
 * Best-effort extraction of {"objects":[...]} from model output.
 * Some models return: {response: "..."} or {result: "..."} or {output_text: "..."} etc.
 * We try to parse JSON from any string fields.
 */
function extractObjects(ai) {
  // Default: return empty list and include raw (for debugging)
  const fallback = { objects: [], rawIncluded: true };

  // 1) If it's already the target shape
  if (ai && typeof ai === "object" && Array.isArray(ai.objects)) {
    return { objects: ai.objects, rawIncluded: false };
  }

  // 2) Try common text fields
  const candidates = [];
  if (ai && typeof ai === "object") {
    for (const k of ["response", "result", "output", "output_text", "text", "content"]) {
      if (typeof ai[k] === "string") candidates.push(ai[k]);
    }
  }

  // 3) Some outputs may be nested
  if (ai && typeof ai === "object" && ai?.choices?.[0]?.message?.content) {
    candidates.push(ai.choices[0].message.content);
  }

  for (const t of candidates) {
    const parsed = tryParseJsonFromText(t);
    if (parsed && Array.isArray(parsed.objects)) {
      return { objects: parsed.objects, rawIncluded: true };
    }
  }

  return fallback;
}

function tryParseJsonFromText(text) {
  if (!text || typeof text !== "string") return null;

  // trim
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
