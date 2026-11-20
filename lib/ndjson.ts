/** 한 줄에 JSON 하나씩 흘려보내는 응답을 만든다. */
export function ndjson<T>(run: (emit: (e: T) => void) => Promise<void>): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: unknown) => controller.enqueue(enc.encode(JSON.stringify(e) + "\n"));
      try {
        await run(emit as (e: T) => void);
      } catch (e) {
        emit({ type: "error", message: (e as Error).message });
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}
