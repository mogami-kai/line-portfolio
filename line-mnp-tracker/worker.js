
export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") return new Response("OK", { status: 200 });

    const body = await request.text();

    ctx.waitUntil(
      fetch(env.OPS_GAS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      }).catch((err) => console.log(err))
    );

    return new Response("OK", { status: 200 });
  },
};