import multer, { MulterError } from "multer";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { promises as fs } from "node:fs";
import os from "node:os";
import { config } from "../config.js";
import { AppError } from "../lib/errors.js";
import { parseAllowedMimeTypes, validateUpload } from "../lib/uploadValidation.js";

const allowedMimeTypes = parseAllowedMimeTypes(config.ALLOWED_UPLOAD_MIME_TYPES);

const maxConcurrentUploads = config.MAX_CONCURRENT_UPLOADS ?? 4;
let activeUploads = 0;

/** Test hook: number of uploads currently holding a concurrency slot. */
export function __getActiveUploadCount(): number {
  return activeUploads;
}

const upload = multer({
  storage: multer.diskStorage({ destination: os.tmpdir() }),
  limits: { fileSize: config.MAX_FILE_SIZE_MB * 1024 * 1024 },
});

/**
 * Wraps `multer().single(field)` and maps multer errors to clear HTTP statuses
 * instead of letting them fall through to the 500 handler. Oversized uploads
 * return 413 before anything is written to storage (#87).
 *
 * Uploads are streamed to a temp file on disk rather than buffered in memory,
 * and at most `MAX_CONCURRENT_UPLOADS` are processed at once; excess requests
 * are rejected with 503 (#90).
 */
export function singleFileUpload(field = "file"): RequestHandler {
  const handler = upload.single(field);
  return (req: Request, res: Response, next: NextFunction) => {
    if (activeUploads >= maxConcurrentUploads) {
      next(new AppError("SERVICE_UNAVAILABLE", "Too many concurrent uploads, please retry shortly"));
      return;
    }
    activeUploads++;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        activeUploads--;
      }
    };
    res.on("finish", release);
    res.on("close", release);

    handler(req, res, (err: unknown) => {
      if (err instanceof MulterError) {
        release();
        if (err.code === "LIMIT_FILE_SIZE") {
          next(
            new AppError(
              "PAYLOAD_TOO_LARGE",
              `File exceeds the maximum size of ${config.MAX_FILE_SIZE_MB}MB`,
            ),
          );
          return;
        }
        next(new AppError("VALIDATION_ERROR", `Upload error: ${err.message}`));
        return;
      }
      if (err) {
        release();
        // Busboy parse failures (malformed multipart) are client errors; system
        // errors such as a full temp disk carry an errno `code` and stay 5xx.
        if (err instanceof Error && !(err as NodeJS.ErrnoException).code) {
          next(new AppError("VALIDATION_ERROR", `Malformed multipart body: ${err.message}`));
          return;
        }
        next(err);
        return;
      }
      next();
    });
  };
}

/**
 * Rejects uploads whose content type is not allow-listed, or whose declared
 * type does not match the detected magic bytes, with 415 — before the storage
 * write. No-ops for non-file (e.g. link) requests.
 */
export function validateUploadContentType(req: Request, res: Response, next: NextFunction): void {
  if (!req.file) {
    next();
    return;
  }

  const file = req.file;
  fs.readFile(file.path)
    .then((buffer) => {
      const result = validateUpload(buffer, file.mimetype, allowedMimeTypes);
      if (!result.ok) {
        return fs.unlink(file.path).catch(() => undefined).then(() => {
          next(new AppError("UNSUPPORTED_MEDIA_TYPE", result.error));
        });
      }
      next();
    })
    .catch((err: unknown) => {
      fs.unlink(file.path).catch(() => undefined).finally(() => next(err));
    });
}
