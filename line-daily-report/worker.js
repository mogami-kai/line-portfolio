export default {
  async fetch(request, env, ctx) {
    const GAS_EXEC_URL = env.GAS_EXEC_URL;

    if (request.method !== "POST") return new Response("OK");

    try {
      const body = await request.text();

      ctx.waitUntil(
        fetch(GAS_EXEC_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: body,
          redirect: "follow",
        })
      );

      return new Response("OK", { status: 200 });

    } catch (err) {
      return new Response("Error", { status: 500 });
    }
  },
};