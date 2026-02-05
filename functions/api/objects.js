const MODEL = "@cf/llava-hf/llava-1.5-7b-hf";

export async function onRequestPost({ request, env }) {
  let bytes;

  try {
    // 1) Validate
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
    const image = Array.from(bytes); // Cloudflare expects array of u8
    const imageFingerprint = (await sha256Hex(bytes)).slice(0, 12);

    // Helper: ALWAYS send object with image+prompt (fixes your error 5006)
    const runVision = async (prompt) => {
      // Defensive check: prompt must be string
      if (typeof prompt !== "string") throw new Error("Internal: prompt is not a string");
      return await env.AI.run(MODEL, {
        image,
        prompt,
        max_tokens: 1400,
      });
    };

    // -------------------------
    // Phase 1: Inventory (text only)
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
      "- Začni řádkem 'INVENTURA:' a pak odrážky.\n" +
      "- Buď konkrétní (sklápěč, dodávka, kontejner, paleta, armatura, hadice, kabely, svodidlo, zábradlí...).\n" +
      "- Když si nejsi jistý, napiš '(nejisté)'.\n";

    const phase1 = await runVision(PROMPT_1);

    const inventoryText =
      (typeof phase1 === "string" ? phase1 : phase1?.description ?? phase1?.result ?? "")?.trim() || "";

    if (!inventoryText) {
      return json(
        { ok: false, model: MODEL, error: "Phase 1 returned empty text.", imageFingerprint, raw1: phase1 },
        500
      );
    }

    // -------------------------
    // Phase 2: Inventory -> strict JSON
    // -------------------------
    const PROMPT_2 =
      "Z následující INVENTURY vytvoř čistý JSON ve formátu:\n" +
      "{\"caption\":\"...\",\"objects\":[{\"name\":\"...\",\"confidence\":\"low|medium|high\"}]}\n\n" +
      "Pravidla:\n" +
      "- Vypiš CO NEJVÍCE fyzických objektů z inventury (klidně 40+).\n" +
      "- NEVYMÝŠLEJ nic, co není v inventuře.\n" +
      "- Žádné role a vztahy: místo 'máma/děti' vždy jen 'člověk' nebo 'osoba'.\n" +
      "- Žádné scénické pojmy jako 'pláž', 'dovolená'.\n" +
      "- Deduplikuj: každý objekt jen jednou.\n" +
      "- name = krátký konkrétní český název objektu.\n" +
      "- confidence: high/medium/low podle jistoty (nejisté -> low).\n" +
      "- NESMÍŠ vracet šablonové texty typu 'konkrétní český název'.\n" +
      "- Vrať POUZE platný JSON. Žádný další text.\n\n" +
      "INVENTURA:\n" +
      inventoryText;

    const phase2 = await runVision(PROMPT_2);

    const phase2Text =
      (typeof phase2 === "string" ? phase2 : phase2?.description ?? phase2?.result ?? "")?.trim() || "";

    const parsed = tryParseJsonFromText(phase2Text);

    if (!parsed || !Array.isArray(parsed.objects)) {
      return json(
        {
          ok: false,
          model: MODEL,
          imageFingerprint,
          error: "Phase 2 did not return valid JSON.",
          raw: { phase1: inventoryText, phase2: phase2Text },
        },
        500
      );
    }

    const caption = typeof parsed.caption === "string" ? parsed.caption.trim() : "";
    const objects = cleanObjects(parsed.objects);

    return json({
      ok: true,
      model: MODEL,
      imageFingerprint,
      caption,
      objects,
      raw: { phase1: inventoryText, phase2: phase2Text },
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
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      pragma: "no-cache",
    },
  });
}

function tryParseJsonFromText(text) {
  if (!text || typeof text !== "string") return null;
  let s = text.trim();

  try {
    return JSON.parse(s);
  } catch {}

  // extract first {...}
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
    let confidence = typeof o.confidence === "string" ? o.confidence.trim().toLowerCase() : "low";
    if (!name) continue;

    const lower = name.toLowerCase();

    // filter instruction echoes
    const junk = ["konkrétní český název", "konkretni cesky nazev", "český název", "cesky nazev", "název objektu", "nazev objektu"];
    if (junk.some((x) => lower.includes(x))) continue;

    if (name === "..." || lower === "xxx" || lower === "object") continue;
    if (banned.has(lower)) continue;

    if (!["low", "medium", "high"].includes(confidence)) confidence = "low";

    // de-dup
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
