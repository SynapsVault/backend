import { Request, Response, NextFunction } from 'express';
import { errorHandler } from './errorHandler';
import { AppError } from '../errors/AppError';

describe('errorHandler', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: NextFunction;
  let jsonMock: jest.Mock;
  let statusMock: jest.Mock;

  beforeEach(() => {
    jsonMock = jest.fn();
    statusMock = jest.fn().mockReturnValue({ json: jsonMock });
    req = {
      requestId: 'test-request-id',
    } as Partial<Request>;
    res = {
      status: statusMock,
      json: jsonMock,
    } as Partial<Response>;
    next = jest.fn();
  });

  it('maps AppError to the correct status code and response shape', () => {
    const error = new AppError('Not found', 404);

    errorHandler(error, req as Request, res as Response, next);

    expect(statusMock).toHaveBeenCalledWith(404);
    expect(jsonMock).toHaveBeenCalledWith({
      error: {
        message: 'Not found',
        statusCode: 404,
        requestId: 'test-request-id',
      },
    });
  });

  it('maps AppError with a 400 status code correctly', () => {
    const error = new AppError('Bad request', 400);

    errorHandler(error, req as Request, res as Response, next);

    expect(statusMock).toHaveBeenCalledWith(400);
    expect(jsonMock).toHaveBeenCalledWith({
      error: {
        message: 'Bad request',
        statusCode: 400,
        requestId: 'test-request-id',
      },
    });
  });

  it('returns 500 for unknown errors', () => {
    const error = new Error('Something went wrong');

    errorHandler(error, req as Request, res as Response, next);

    expect(statusMock).toHaveBeenCalledWith(500);
    expect(jsonMock).toHaveBeenCalledWith({
      error: {
        message: 'Internal server error',
        statusCode: 500,
        requestId: 'test-request-id',
      },
    });
  });

  it('includes the requestId in the response', () => {
    const error = new AppError('Forbidden', 403);

    errorHandler(error, req as Request, res as Response, next);

    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          requestId: 'test-request-id',
        }),
      }),
    );
  });

  it('handles a missing requestId gracefully', () => {
    req = {} as Partial<Request>;
    const error = new AppError('Unauthorized', 401);

    errorHandler(error, req as Request, res as Response, next);

    expect(statusMock).toHaveBeenCalledWith(401);
    expect(jsonMock).toHaveBeenCalledWith({
      error: {
        message: 'Unauthorized',
        statusCode: 401,
        requestId: undefined,
      },
    });
  });
});