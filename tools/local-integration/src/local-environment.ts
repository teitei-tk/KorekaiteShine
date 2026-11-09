const aiKeys = [
  'OPENAI_API_KEY',
  'MATERIAL_MODEL',
  'RESPONSES_MODEL',
  'EVALUATION_MODEL',
  'LIVE_VOICE',
] as const;
function pick(source: NodeJS.ProcessEnv, names: readonly string[]) {
  const result: Record<string, string> = {};
  for (const name of names) {
    const value = source[name];
    if (value) {
      result[name] = value;
    }
  }
  return result;
}
export function localProcessEnvironment(source: NodeJS.ProcessEnv = process.env) {
  return pick(source, [
    'PATH',
    'HOME',
    'TMPDIR',
    'TEMP',
    'TMP',
    'LANG',
    'LC_ALL',
    'TZ',
    'SystemRoot',
    'USERPROFILE',
    'XDG_CACHE_HOME',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
  ]);
}
export function localAiEnvironment(
  environment: string,
  mode: string,
  source: NodeJS.ProcessEnv = process.env,
  fixture?: Record<string, string>,
) {
  if (fixture) {
    if (
      environment !== 'test' ||
      mode !== 'dev' ||
      !/^fixture-[a-z0-9-]+$/u.test(fixture.OPENAI_API_KEY ?? '')
    ) {
      throw new Error('架空のAI設定は独立したテスト環境で指定してください。');
    }
    return pick(fixture, aiKeys);
  }
  return environment === 'development' && mode === 'dev' ? pick(source, aiKeys) : {};
}
export function aiBindingNames(
  ai: Record<string, string>,
  worker: 'web' | 'interview' | 'evaluation',
) {
  const names = {
    web: ['OPENAI_API_KEY', 'MATERIAL_MODEL'],
    interview: ['OPENAI_API_KEY', 'RESPONSES_MODEL', 'EVALUATION_MODEL', 'LIVE_VOICE'],
    evaluation: ['OPENAI_API_KEY'],
  };
  return names[worker].filter((name) => Object.hasOwn(ai, name));
}
