import multer, { MulterError } from "multer";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { AppError } from "../lib/errors.js";
import { parseAllowedMimeTypes, validateUpload } from "../lib/uploadValidation.js";

const allowedMimeTypes = parseAllowedMimeTypes(config.ALLOWED_UPLOAD_MIME_TYPES);

const maxConcurrentUploads = config.MAX_CONCURRENT_UPLOADS ?? 4;
let activeUploads = 0;

/**
 * Upload temp files live in a dedicated app-owned directory rather than the
 * shared os.tmpdir(), so the crash-recovery sweep can distinguish our files
 * from unrelated temp files and never touches anything outside this dir.
 */
export const UPLOAD_TEMP_DIR =
  config.UPLOAD_TEMP_DIR ?? path.join(os.tmpdir(), "synapsvault-uploads");

// Create the directory eagerly so the first upload (and the sweep worker)
// never races its creation.
void fs.mkdir(UPLOAD_TEMP_DIR, { recursive: true }).catch(() => undefined);

/** Test hook: number of uploads currently holding a concurrency slot. */
export function __getActiveUploadCount(): number {
  return activeUploads;
}

/**
 * Multipart resource bounds. The publish schemas accept a handful of text
 * fields plus a single file, so anything beyond these limits is abusive.
 */
const MAX_MULTIPART_FIELDS = 16;
const MAX_MULTIPART_PARTS = MAX_MULTIPART_FIELDS + 2;
const MAX_MULTIPART_FIELD_SIZE = 8 * 1024;

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdir(UPLOAD_TEMP_DIR, { recursive: true }).then(
        () => cb(null, UPLOAD_TEMP_DIR),
        (err: unknown) => cb(err as Error, ""),
      );
    },
  }),
  limits: {
    fileSize: config.MAX_FILE_SIZE_MB * 1024 * 1024,
    fields: MAX_MULTIPART_FIELDS,
    parts: MAX_MULTIPART_PARTS,
    fieldSize: MAX_MULTIPART_FIELD_SIZE,
  },
});

const CLEANUP_KEY = Symbol.for("uploadGuards.cleanup");

type CleanupRegistry = { paths: Set<string>; registered: boolean };

function getCleanupRegistry(req: Request): CleanupRegistry {
  const holder = req as Request & { [CLEANUP_KEY]?: CleanupRegistry };
  if (!holder[CLEANUP_KEY]) {
    holder[CLEANUP_KEY] = { paths: new Set(), registered: false };
  }
  return holder[CLEANUP_KEY]!;
}

/**
 * Registers a temp file for cleanup as soon as it is created. Cleanup runs
 * when the response finishes/closes, so middleware that rejects before the
 * route handler (signature checks, idempotency replay) still leaves no temp
 * files behind. Unlinking is idempotent and safe to call repeatedly.
 */
export function registerTempFileCleanup(req: Request, path: string): void {
  const registry = getCleanupRegistry(req);
  registry.paths.add(path);
  if (!registry.registered) {
    registry.registered = true;
    const cleanup = () => { void cleanupRequestUpload(req); };
    req.on("close", cleanup);
    req.on("aborted", cleanup);
  }
}

/** Remove only files registered for this request; safe on repeated calls. */
export async function cleanupRequestUpload(req: Request): Promise<void> {
  const registry = getCleanupRegistry(req);
  const paths = [...registry.paths];
  registry.paths.clear();
  await Promise.all(paths.map(p => fs.unlink(p).catch(() => undefined)));
}

/** Test hook: number of temp files still registered for cleanup on `req`. */
export function __getRegisteredTempFileCount(req: Request): number {
  const holder = req as Request & { [CLEANUP_KEY]?: CleanupRegistry };
  return holder[CLEANUP_KEY]?.paths.size ?? 0;
}

function unlinkUploadedFiles(req: Request): void {
  const files: Express.Multer.File[] = [];
  if (req.file) files.push(req.file);
  if (Array.isArray(req.files)) {
    files.push(...(req.files as Express.Multer.File[]));
  } else if (req.files && typeof req.files === "object") {
    for (const list of Object.values(req.files)) {
      files.push(...list);
    }
  }
  for (const file of files) {
    if (file?.path) {
      fs.unlink(file.path).catch(() => undefined);
    }
  }
}

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
        unlinkUploadedFiles(req);
        if (err.code === "LIMIT_FILE_SIZE") {
          next(
            new AppError(
              "PAYLOAD_TOO_LARGE",
              `File exceeds the maximum size of ${config.MAX_FILE_SIZE_MB}MB`,
            ),
          );
          return;
        }
        if (err.code === "LIMIT_FIELD_VALUE") {
          next(
            new AppError(
              "PAYLOAD_TOO_LARGE",
              `Multipart field exceeds the maximum size of ${MAX_MULTIPART_FIELD_SIZE} bytes`,
            ),
          );
          return;
        }
        if (err.code === "LIMIT_FIELD_COUNT") {
          next(
            new AppError(
              "VALIDATION_ERROR",
              `Too many multipart fields (maximum ${MAX_MULTIPART_FIELDS})`,
            ),
          );
          return;
        }
        if (err.code === "LIMIT_PART_COUNT") {
          next(
            new AppError(
              "VALIDATION_ERROR",
              `Too many multipart parts (maximum ${MAX_MULTIPART_PARTS})`,
            ),
          );
          return;
        }
        if (err.code === "LIMIT_FIELD_KEY") {
          next(new AppError("VALIDATION_ERROR", "Multipart field name is too long"));
          return;
        }
        next(new AppError("VALIDATION_ERROR", `Upload error: ${err.message}`));
        return;
      }
      if (err) {
        release();
        unlinkUploadedFiles(req);
        // Busboy parse failures (malformed multipart) are client errors; system
        // errors such as a full temp disk carry an errno `code` and stay 5xx.
        if (err instanceof Error && !(err as NodeJS.ErrnoException).code) {
          next(new AppError("VALIDATION_ERROR", `Malformed multipart body: ${err.message}`));
          return;
        }
        next(err);
        return;
      }
      if (req.file?.path) {
        registerTempFileCleanup(req, req.file.path);
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
  registerTempFileCleanup(req, file.path);
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

export interface UploadTempSweepResult {
  /** Entries examined inside the upload temp directory. */
  scanned: number;
  /** Stale owned files removed. */
  removed: number;
  /** Files kept because their mtime is newer than the max age (in-flight uploads). */
  keptActive: number;
  /** Entries that could not be stat'ed or unlinked; the sweep continues past them. */
  errors: number;
}

/**
 * Removes stale temp files left behind when a process crash bypasses request
 * cleanup. Only regular files directly inside the dedicated upload temp dir
 * are considered, and only once their mtime is older than `maxAgeMs` — so
 * active uploads (fresh mtimes) and anything outside the dir are never
 * touched. Returns per-run counts for logging/metrics.
 */
export async function sweepStaleUploadTempFiles(
  options: { dir?: string; maxAgeMs?: number; now?: number } = {},
): Promise<UploadTempSweepResult> {
  const dir = options.dir ?? UPLOAD_TEMP_DIR;
  const maxAgeMs = options.maxAgeMs ?? config.UPLOAD_TEMP_MAX_AGE_MS ?? 3_600_000;
  const now = options.now ?? Date.now();
  const result: UploadTempSweepResult = { scanned: 0, removed: 0, keptActive: 0, errors: 0 };

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return result;
    throw err;
  }

  await Promise.all(
    entries.map(async (entry) => {
      // Never recurse into subdirectories or follow symlinks — only plain
      // files the multer diskStorage wrote are eligible for removal.
      if (!entry.isFile()) return;
      result.scanned += 1;
      const filePath = path.join(dir, entry.name);
      try {
        const stat = await fs.stat(filePath);
        if (now - stat.mtimeMs < maxAgeMs) {
          result.keptActive += 1;
          return;
        }
        await fs.unlink(filePath);
        result.removed += 1;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") result.errors += 1;
      }
    }),
  );

  return result;
}
