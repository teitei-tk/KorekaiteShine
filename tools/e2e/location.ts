/** Cucumberの行指定を相対featureパスへ限定し、globや親ディレクトリを拒否する。 */
export function isScenarioLocation(value: string): boolean {
  if (!/^features\/.+\.feature:[1-9]\d*$/u.test(value)) {
    return false;
  }
  return value
    .slice(9, value.lastIndexOf(':'))
    .split('/')
    .every(
      (part) => part !== '' && part !== '.' && part !== '..' && !/[\\:*?[\]{}!()+@]/u.test(part),
    );
}
