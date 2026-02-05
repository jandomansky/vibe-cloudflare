// functions/api/objects.js
// POST /api/objects
// multipart/form-data field: "file" (image/*)
// Returns JSON only.

const MODEL = "@cf/llava-hf/llava-1.5-7b-hf";

export async function onRequestPost({ request, env }) {
  let bytes = null;
  let dataUrl = null;

  try {
    const ct = request.headers.get("content-type") || "";
    if (!ct.includes("multipart/form-data")) {
      return json({ ok: false, error: "Send multipart/form-data with field 'file'." }, 400);
    }

    const form = await request.formData();
    const file = form.get("file");

    // ✅ bez File instanceof – ať to nepadá v runtime
    const isImage =
      file &&
      typeof file === "object" &&
      typeof file.arrayBuffer === "function" &&
      typeof file.type === "string" &&
      file.type.startsWith("image/");

    if (!isImage) {
      return json({ ok: false, error: "Missing or invalid image file (field 'file')." }, 400);
    }

    // ✅ binding musí být v Pages projektu: Settings → Functions → Bindings → Workers AI → name AI
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

    // ✅ DŮLEŽITÉ: vynutíme JPEG data URL bez ohledu na file.type
    // (frontend už posílá čistý JPEG, ale tohle eliminuje edge-casey)
    dataUrl = `data:image/jpeg;base64,${toBase64(bytes)}`;

    const messages = [
      {
        role: "system",
        content: "You are an image tagging API. Return ONLY valid JSON. No markdown, no explanations.",
      },
      {
        role: "user",
        content:
          'Return JSON EXACTLY as {"objects":[{"name":"...","confidence":"low|medium|high"}]}. Use Czech names. Avoid duplicates.',
      },
    ];

    const ai = await env.AI.run(MODEL, {
      messages,
      image: dataUrl,
    });

    const objects = extractObjects(ai);

    return json({
      ok: true,
      model: MODEL,
      objects,
      // pro začátek necháme raw (můžeš později vypnout)
      raw: ai,
    });
  } catch (e) {
    return json(
      {
        ok: false,
        model: MODEL,
        error: String(e),
        debug: {
          bytesLength: bytes?.length ?? null,
          dataUrlPrefix: dataUrl ? dataUrl.slice(0, 30) : null,
        },
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

// Pokusí se vytáhnout objects[] i když model vrátí text / nested strukturu
function extractObjects(ai) {
  // Pokud model vrátí už strukturovaně
  if (ai && typeof ai === "object" && Array.isArray(ai.objects)) return ai.objects;

  // Kandidátní textová pole
  const texts = [];
  if (ai && typeof ai === "object") {
    for (const k of ["response", "result", "output", "output_text", "text", "content"]) {
      if (typeof ai[k] === "string") texts.push(ai[k]);
    }
  }
  if (ai?.choices?.[0]?.message?.content) texts.push(ai.choices[0].message.content);

  for (const t of texts) {
    const parsed = tryParseJsonFromText(t);
    if (parsed && Array.isArray(parsed.objects)) return parsed.objects;
  }

  // fallback
  return [];
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
