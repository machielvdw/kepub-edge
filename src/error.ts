export type KepubErrorCode = "invalid_epub" | "unsupported_epub" | "too_large"

export class KepubError extends Error {
  readonly code: KepubErrorCode

  constructor(code: KepubErrorCode, message: string) {
    super(message)
    this.name = "KepubError"
    this.code = code
  }
}

export function invalid(message: string): never {
  throw new KepubError("invalid_epub", message)
}

export function unsupported(message: string): never {
  throw new KepubError("unsupported_epub", message)
}

export function tooLarge(message: string): never {
  throw new KepubError("too_large", message)
}
