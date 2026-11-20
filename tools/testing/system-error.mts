export class SystemError extends Error {
  override name = 'SystemError';
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}
