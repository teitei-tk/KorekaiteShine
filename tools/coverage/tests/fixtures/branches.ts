export const branchFixture = `function choose(value: boolean = true): number {
  if (value) return 1;
  return 2;
}
function select(value?: number): number {
  return value || 3;
}
function label(value: boolean): string {
  return value ? 'yes' : 'no';
}
async function fail(value: boolean): Promise<number> {
  if (value) throw new Error('probe');
  return 4;
}
function unused(): number {
  return 5;
}`;
