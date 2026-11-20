import { parseJson } from '@korekaite/api-contracts/json';
export function parseEvent(data: string): object | null {
  try {
    const event = parseJson(data);
    return event !== null && typeof event === 'object' ? event : null;
  } catch {
    return null;
  }
}
