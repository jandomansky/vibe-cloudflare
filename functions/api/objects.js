export async function onRequestPost({ request, env }) {
  const ct = request.headers.get("content-type") || "";
  if (!ct.includes("multipart/form-data")) {
    return new Response(
      JSON.stringify({ ok: false, error: "Send multipart/form-data with field 'file'." }),
      { status: 400, headers: { "content-type": "application/json" } }
    );
  }

  const form = await request.formData();
  const file = form.get("file");

  if (!(file instanceof File) || !file.type.startsWith("image/")) {
    return new Response(
      JSON.stringify({ ok: false, error: "Missing or invalid image file." }),
      { status: 400, headers: { "content-type": "application/json" } }
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const b64 = uint8ToBase64(bytes);
  const dataUrl = `data:${file.type};base64,${b64}`;

  const messages = [
    {
      role: "system",
      content:
        "You are an image tagging API. Return ONLY valid JSON. No markdown, no extra text.",
    },
    {
      role: "user",
      content:
        'List objects you can recognize in the image. Return JSON exactly as {"objects":[{"name":"...","confidence":"low|medium|high"}]}. Use Czech names.',
    },
  ];

  const ai = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
    messages,
    image: dataUrl,
  });

  return new Response(JSON.stringify({ ok: true, ai }), {
    headers: { "content-type": "application/json" },
  });
}

// helper
function uint8ToBase64(u8) {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    s += String.fromCharCode(...u8.subarray(i, i + chunk));
  }
  return btoa(s);
}
