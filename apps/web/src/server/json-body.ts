type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type BodyResult =
  | { ok: true; value: JsonValue }
  | {
      ok: false;
      code: 'INVALID_REQUEST' | 'UNSUPPORTED_MEDIA_TYPE' | 'REQUEST_TOO_LARGE';
    };

export async function readJsonBody(request: Request, maxBytes: number): Promise<BodyResult> {
  if (
    request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json'
  ) {
    return { ok: false, code: 'UNSUPPORTED_MEDIA_TYPE' };
  }
  if (!request.body) {
    return { ok: false, code: 'INVALID_REQUEST' };
  }
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let source = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        return { ok: false, code: 'REQUEST_TOO_LARGE' };
      }
      source += decoder.decode(chunk.value, { stream: true });
    }
    source += decoder.decode();
    return { ok: true, value: JSON.parse(source) };
  } catch {
    await reader.cancel().catch(() => undefined);
    return { ok: false, code: 'INVALID_REQUEST' };
  } finally {
    reader.releaseLock();
  }
}
