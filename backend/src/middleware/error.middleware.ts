import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { logger } from "../utils/logger.js";

const notFoundCodes = new Set([
  "CUSTOMER_NOT_FOUND",
  "DELIVERY_NOT_FOUND",
  "DRIVER_NOT_FOUND",
  "DRIVER_NOT_FOUND_OR_INACTIVE",
]);

function getErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    return typeof code === "string" ? code : undefined;
  }
  if (error instanceof Error) return error.message;
  return undefined;
}

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({
    success: false,
    code: "NOT_FOUND",
    message: "Route not found.",
  });
};

export const errorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) {
    logger.error("api_error_after_response_headers");
    res.destroy();
    return;
  }

  if (error instanceof ZodError) {
    res.status(400).json({
      success: false,
      code: "VALIDATION_FAILED",
      message: "Validation failed.",
      errors: error.issues.map((issue) => ({
        path: issue.path.map(String),
        message: issue.message,
      })),
    });
    return;
  }

  const code = getErrorCode(error);
  const errorStatus =
    typeof error === "object" && error !== null && "status" in error
      ? error.status
      : undefined;

  if (code === "P2002") {
    res.status(409).json({
      success: false,
      code: "CONFLICT",
      message: "A record with the same unique value already exists.",
    });
    return;
  }

  if (code === "P2025" || (code && notFoundCodes.has(code))) {
    res.status(404).json({
      success: false,
      code: "NOT_FOUND",
      message: "The requested resource was not found.",
    });
    return;
  }

  if (
    code === "P2003" ||
    code === "P2034" ||
    code === "INVALID_STATUS_TRANSITION" ||
    code === "DELIVERY_STATE_CONFLICT" ||
    code === "DELIVERY_CANNOT_BE_ASSIGNED" ||
    code === "DRIVER_HAS_ACTIVE_DELIVERIES"
  ) {
    res.status(409).json({
      success: false,
      code: "CONFLICT",
      message: "The request conflicts with the current resource state.",
    });
    return;
  }

  if (code === "DELIVERY_FORBIDDEN") {
    res.status(403).json({
      success: false,
      code: "FORBIDDEN",
      message: "You are not allowed to perform this delivery action.",
    });
    return;
  }

  if (code === "P2023") {
    res.status(400).json({
      success: false,
      code: "INVALID_REQUEST",
      message: "The request contains an invalid identifier.",
    });
    return;
  }

  if (typeof errorStatus === "number" && errorStatus >= 400 && errorStatus < 500) {
    const status = errorStatus === 413 ? 413 : 400;
    res.status(status).json({
      success: false,
      code: status === 413 ? "PAYLOAD_TOO_LARGE" : "INVALID_REQUEST",
      message: status === 413 ? "Request body is too large." : "Invalid request.",
    });
    return;
  }

  logger.error("api_request_failed", {
    requestId: typeof res.locals?.requestId === "string" ? res.locals.requestId : undefined,
  });
  res.status(500).json({
    success: false,
    code: "INTERNAL_SERVER_ERROR",
    message: "Internal server error.",
  });
};
