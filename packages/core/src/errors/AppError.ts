export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly metadata?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    statusCode: number = 500,
    metadata?: Record<string, unknown>
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    this.metadata = metadata;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, metadata?: Record<string, unknown>) {
    super('NOT_FOUND', message, 404, metadata);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, metadata?: Record<string, unknown>) {
    super('VALIDATION_ERROR', message, 422, metadata);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string = 'Unauthorized', metadata?: Record<string, unknown>) {
    super('UNAUTHORIZED', message, 401, metadata);
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string = 'Forbidden', metadata?: Record<string, unknown>) {
    super('FORBIDDEN', message, 403, metadata);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, metadata?: Record<string, unknown>) {
    super('CONFLICT', message, 409, metadata);
  }
}

export class LockedError extends AppError {
  constructor(message: string, metadata?: Record<string, unknown>) {
    super('LOCKED', message, 423, metadata);
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, metadata?: Record<string, unknown>) {
    super('BAD_REQUEST', message, 400, metadata);
  }
}

/** BYOB-09: a workspace's own bucket failed; the registry never falls back to shared storage. */
export class StorageUnavailableError extends AppError {
  constructor(message: string, metadata?: Record<string, unknown>) {
    super('STORAGE_UNAVAILABLE', message, 503, metadata);
  }
}
