export function parseEvent(data: string): object | null {
  try {
    const event = JSON.parse(data);
    return event !== null && typeof event === 'object' ? event : null;
  } catch {
    return null;
  }
}
