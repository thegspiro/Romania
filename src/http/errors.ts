/**
 * HTTP error types.
 *
 * `notFound()` is used for both "no such item" and "you may not see this
 * item". Distinguishing them with a 403 would confirm that a private item
 * exists at a given slug, and for unpublished research about named people
 * that confirmation is itself the disclosure.
 */

export class HttpError extends Error {
  public readonly statusCode: number;
  /** Safe to show the visitor. Anything else is logged and replaced. */
  public readonly publicMessage: string;

  public constructor(statusCode: number, publicMessage: string, internalMessage?: string) {
    super(internalMessage ?? publicMessage);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.publicMessage = publicMessage;
  }
}

export function notFound(internalMessage?: string): HttpError {
  return new HttpError(404, 'Not found', internalMessage);
}

export function badRequest(publicMessage = 'Bad request', internalMessage?: string): HttpError {
  return new HttpError(400, publicMessage, internalMessage);
}

export function unauthorized(internalMessage?: string): HttpError {
  return new HttpError(401, 'Sign-in required', internalMessage);
}

export function forbidden(publicMessage = 'Forbidden', internalMessage?: string): HttpError {
  return new HttpError(403, publicMessage, internalMessage);
}

export function tooManyRequests(publicMessage: string, internalMessage?: string): HttpError {
  return new HttpError(429, publicMessage, internalMessage);
}
