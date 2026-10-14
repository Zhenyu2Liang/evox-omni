import type { FetchFunction } from '@earendil-works/pi-ai';

/** OpenAI-compatible SSE completion requires a transport terminator, independently of prose. */
export function requireCompletionTerminator(fetch: FetchFunction, observe: (event: unknown) => Promise<void>): FetchFunction {
  return async (input, init) => {
    const response = await fetch(input, init);
    if (!response.ok) return response;
    if (!response.body || !response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
      await observe({ kind: 'transport_end', completed: false, cause: 'invalid_sse_response', status: response.status });
      throw new Error('Provider connection returned no SSE response body.');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let pending = '';
    let trailingCr = false;
    let terminated = false;
    let bytes = 0;
    let frames = 0;
    const parseFrame = (frame: string) => {
      const data = frame.split('\n').filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).replace(/^ /, '')).join('\n').trim();
      if (!data) return;
      frames++;
      if (data === '[DONE]') terminated = true;
    };
    const append = (text: string) => {
      if (!text) return;
      if (trailingCr && text.startsWith('\n')) text = text.slice(1);
      trailingCr = text.endsWith('\r');
      pending += text.replace(/\r\n|\r/g, '\n');
      let boundary = pending.indexOf('\n\n');
      while (boundary >= 0 && !terminated) {
        parseFrame(pending.slice(0, boundary));
        pending = pending.slice(boundary + 2);
        boundary = pending.indexOf('\n\n');
      }
    };
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { value, done } = await reader.read();
          if (value) { bytes += value.byteLength; append(decoder.decode(value, { stream: true })); }
          if (done) { append(decoder.decode()); if (!terminated && pending.trim()) parseFrame(pending); }
          if (terminated) {
            await observe({ kind: 'transport_end', completed: true, terminator: '[DONE]', bytes, frames });
            if (value) controller.enqueue(value);
            controller.close();
            void reader.cancel().catch(() => undefined);
          } else if (done) {
            throw new Error('Provider connection ended without the required [DONE] terminator.');
          } else if (value) controller.enqueue(value);
        } catch (error) {
          try { await observe({ kind: 'transport_end', completed: false, bytes, frames }); } catch { /* Preserve the original failure. */ }
          controller.error(error);
          void reader.cancel().catch(() => undefined);
        }
      },
      cancel(reason) { return reader.cancel(reason); },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}
