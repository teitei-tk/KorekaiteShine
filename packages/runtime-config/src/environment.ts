export type AppEnvironment = 'development' | 'test' | 'production';

export function parseEnvironment(value: string | undefined): AppEnvironment {
  if (value === 'development' || value === 'test' || value === 'production') return value;
  throw new Error('APP_ENVはdevelopment・test・productionのいずれかを指定してください。');
}
