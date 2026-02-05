export async function onRequestPost({ request, env }) {
  try {
    const ct = request.headers.get("content-type") || "";
    if (!ct.includes("multipart/form-data")) {
      return json({ ok: false, error: "Send multipart/form-data with field 'file'." }, 400);
    }

    const form = await request.formData();
    const file = form.get("file");

    // ✅ Bezpečná kontrola bez File instanceof
    const isImage =
      file &&
      typeof file === "object" &&
      typeof file.arrayBuffer === "function" &&
      typeof file.type === "string" &&
      file.type.startsWith("image/");

    if (!isImage) {
      return json({ ok: false, error: "Missing or invalid image file." }, 400);
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const dataUrl = `data:${file.type};base64,${toBase64(bytes)}`;

    const messages = [
      { role: "system", content: "You are an image tagging API. Return ONLY valid JSON." },
      {
        role: "user",
        content:
          'List objects you can recognize in the image. Return JSON as {"objects":[{"name":"...","confidence":"low|medium|high"}]}. Use Czech names.',
      },
    ];

    // ✅ Tohle ti dá čitelný error, když binding/model zlobí
    if (!env.AI || typeof env.AI.run !== "function") {
      return json({ ok: false, error: "Workers AI binding 'AI' is missing in Pages project." }, 500);
    }

    const ai = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
      messages,
      image: dataUrl,
    });

    return json({ ok: true, ai });
  } catch (e) {
    // ✅ Už nikdy neuvidíš HTML error page – dostaneš JSON s chybou
    return json({ ok: false, error: String(e) }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
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
