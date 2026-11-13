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
  if (!request.body || request.body.locked) {
    return { ok: false, code: 'INVALID_REQUEST' };
  }
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const body = { bytes: 0, text: '' };
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      body.bytes += chunk.value.byteLength;
      if (body.bytes > maxBytes) {
        await reader.cancel();
        return { ok: false, code: 'REQUEST_TOO_LARGE' };
      }
      body.text += decoder.decode(chunk.value, { stream: true });
    }
    return { ok: true, value: JSON.parse(body.text + decoder.decode()) };
  } catch {
    await reader.cancel().catch(() => undefined);
    return { ok: false, code: 'INVALID_REQUEST' };
  } finally {
    reader.releaseLock();
  }
}
