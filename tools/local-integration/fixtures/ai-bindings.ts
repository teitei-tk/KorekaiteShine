export async function confirmFixtureKey(
  bindings: { APP_ENV: string; OPENAI_API_KEY?: string },
  digest: string,
) {
  const key = bindings.OPENAI_API_KEY;
  if (bindings.APP_ENV !== 'test' || !key?.startsWith('fixture-')) {
    return false;
  }
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  const matches =
    Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('') ===
    digest;
  return {
    matches,
    models: ['MATERIAL_MODEL', 'RESPONSES_MODEL', 'EVALUATION_MODEL', 'LIVE_VOICE'].filter((name) =>
      Object.hasOwn(bindings, name),
    ),
  };
}
