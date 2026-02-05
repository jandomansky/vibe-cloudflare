// functions/api/objects.js
// POST /api/objects
// multipart/form-data field: "file" (image/*)
//
// Two-phase approach:
// 1) Make a detailed, systematic inventory description (no JSON).
// 2) Convert that inventory into strict JSON: { caption, objects:[{name,confidence}] }.
//
// Workers AI (LLaVA) expects raw image bytes as an array of ints (0..255).

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
            "Workers AI binding 'AI' is missing. Add: Pages → Settings → Functions → Bindings → Workers AI and name it AI.",
        },
        500
      );
    }

    bytes = new Uint8Array(await file.arrayBuffer());
    const image = Array.from(bytes);
    const imageFingerprint = (await sha256Hex(bytes)).slice(0, 12);

    // -------------------------
    // Phase 1: Detailed inventory (NO JSON)
    // -------------------------
    const PROMPT_1 =
      "Jsi pečlivý analytik obrázků. Udělej detailní INVENTURU toho, co je VIDĚT na fotce. " +
      "NEVYMÝŠLEJ kontext ani příběh. Nepoužívej role a vztahy (ne 'máma', ne 'děti'); používej jen 'člověk/osoba'. " +
      "Neuváděj místa/scény jako 'pláž' apod. Drž se fyzických věcí.\n\n" +
      "Postupuj systematicky, abys nic nevynechal:\n" +
      "1) Rozděl obraz na sektory (LEVÁ/STŘED/PRAVÁ část a POPŘEDÍ/STŘED/POZADÍ).\n" +
      "2) V každém sektoru projdi kategorie:\n" +
      "   - Konstrukce a infrastruktura\n" +
      "   - Stroje a vozidla\n" +
      "   - Materiál a skladování\n" +
      "   - Nářadí a vybavení\n" +
      "   - Lidé a OOPP (helma, reflexní vesta…)\n" +
      "   - Značení, bariéry, kužely, pásky\n\n" +
      "Výstup:\n" +
      "- Vrať pouze čistý text.\n" +
      "- Napiš krátký nadpis 'INVENTURA' a pak odrážky.\n" +
      "- Buď konkrétní: např. 'sklápěč', 'dodávka', 'kontejner', 'paleta', 'armatura', 'hadice', 'kabely', 'svodidlo', 'zábradlí', 'betonový pilíř', atd.\n" +
      "- Když si nejsi jistý, napiš '(nejisté)'.\n";

    const phase1 = await env.AI.run(MODEL, {
      image,
      prompt: PROMPT_1,
      max_tokens: 1200,
    });

    const inventoryText =
      (typeof phase1 === "string" ? phase1 : phase1?.description ?? phase1?.result ?? "")?.trim() || "";

    if (!inventoryText) {
      return json(
        {
          ok: false,
          model: MODEL,
          error: "Phase 1 returned empty inventory text.",
          imageFingerprint,
          raw1: phase1,
        },
        500
      );
    }

    // -------------------------
    // Phase 2: Convert inventory -> strict JSON objects
    // -------------------------
    const PROMPT_2 =
      "Z následující INVENTURY vytvoř čistý JSON ve formátu:\n" +
      "{\"caption\":\"...\",\"objects\":[{\"name\":\"...\",\"confidence\":\"low|medium|high\"}]}\n\n" +
      "Pravidla:\n" +
      "- Vypiš CO NEJVÍCE fyzických objektů z inventury (klidně 40+).\n" +
      "- NEVYMÝŠLEJ nic, co není v inventuře.\n" +
      "- Žádné role a vztahy: místo 'máma/děti' vždy jen 'člověk' nebo 'osoba'.\n" +
      "- Žádné scénické pojmy jako 'pláž', 'dovolená'.\n" +
      "- Deduplikuj: každý objekt jen jednou (nejběžnější český název).\n" +
      "- name = krátký konkrétní český název objektu (podstatné jméno).\n" +
      "- confidence:\n" +
      "   high = přímo v inventuře bez nejistoty\n" +
      "   medium = v inventuře, ale mírně neurčité\n" +
      "   low = inventura ho uvádí jako (nejisté)\n" +
      "- NESMÍŠ vracet šablonové texty typu 'konkrétní český název'.\n" +
      "- Vrať POUZE platný JSON. Žádný další text.\n\n" +
      "INVENTURA:\n" +
      inventoryText;

    const phase2 = await env.AI.run(MODEL, {
      // Phase 2 is text-only; still using the model, but no image needed
      // Some providers ignore extra fields; keep request minimal:
      prompt: PROMPT_2,
      max_tokens: 1200,
    });

    const phase2Text =
      (typeof phase2 === "string" ? phase2 : phase2?.description ?? phase2?.result ?? "")?.trim() || "";

    const parsed = tryParseJsonFromText(phase2Text);

    if (parsed && Array.isArray(parsed.objects)) {
      const caption = typeof parsed.caption === "string" ? parsed.caption.trim() : "";
      const cleaned = cleanObjects(parsed.objects);

      return json({
        ok: true,
        model: MODEL,
        imageFingerprint,
        caption,
        objects: cleaned,
        raw: {
          phase1: inventoryText,
          phase2: phase2Text,
        },
      });
    }

    // If phase2 failed, return debug (still ok=false)
    return json(
      {
        ok: false,
        model: MODEL,
        imageFingerprint,
        error: "Phase 2 did not return valid JSON.",
        raw: {
          phase1: inventoryText,
          phase2: phase2Text,
        },
      },
      500
    );
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
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "pragma": "no-cache",
    },
  });
}

/**
 * Robust JSON parse:
 * - direct JSON
 * - JSON wrapped in quotes (double parse)
 * - escaped JSON
 * - extraction of first {...} block
 */
function tryParseJsonFromText(text) {
  if (!text || typeof text !== "string") return null;

  let s = text.trim();

  // 1) direct parse
  try {
    return JSON.parse(s);
  } catch {}

  // 2) JSON string wrapped in quotes -> parse twice
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    try {
      const inner = JSON.parse(s);
      if (typeof inner === "string") {
        const r = tryParseJsonFromText(inner);
        if (r) return r;
      }
    } catch {}
  }

  // 3) escaped JSON without outer quotes
  if (s.includes('\\"') || s.includes('{\\"') || s.includes('\\"objects\\"')) {
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

  // 4) extract first {...}
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const sub = s.slice(start, end + 1);
    try {
      return JSON.parse(sub);
    } catch {}

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

  // hard blacklist for non-physical / relationship / scene words (Metrostav use-case)
  const banned = new Set([
    "máma",
    "mama",
    "děti",
    "dite",
    "dítě",
    "rodina",
    "rodiče",
    "rodice",
    "pláž",
    "plaz",
    "dovolená",
    "dovolena",
    "turista",
    "moře",
    "more",
    "oceán",
    "ocean",
  ]);

  for (const o of objects) {
    if (!o || typeof o !== "object") continue;

    let name = typeof o.name === "string" ? o.name.trim() : "";
    let confidence = typeof o.confidence === "string" ? o.confidence.trim() : "";

    if (!name) continue;

    const lower = name.toLowerCase();

    // filter prompt/instruction echoes
    const instructionJunk = [
      "konkrétní český název",
      "konkretni cesky nazev",
      "český název",
      "cesky nazev",
      "název objektu",
      "nazev objektu",
    ];
    if (instructionJunk.some((x) => lower.includes(x))) continue;

    if (name === "..." || lower === "xxx" || lower === "object") continue;
    if (banned.has(lower)) continue;

    // remove too abstract / useless terms
    if (["scéna", "prostředí", "pozadí", "situace"].includes(lower)) continue;

    // normalize confidence
    confidence = confidence.toLowerCase();
    if (!["low", "medium", "high"].includes(confidence)) confidence = "low";

    // de-dup by name
    if (out.some((x) => x.name.toLowerCase() === lower)) continue;

    out.push({ name, confidence });
  }

  return out;
}

async function sha256Hex(u8) {
  const buf = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  const arr = Array.from(new Uint8Array(hash));
  return arr.map((b) => b.toString(16).padStart(2, "0")).join("");
}
