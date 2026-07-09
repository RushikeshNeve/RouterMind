export function toSafeErrorResponse(
  error: Error,
  options: {
    readonly requestId: string;
    readonly production: boolean;
  },
) {
  return {
    error: {
      message: options.production ? "Internal server error." : error.message,
      code: "internal_server_error",
      ...(options.production
        ? {}
        : {
            stack: error.stack,
          }),
    },
    requestId: options.requestId,
  };
}
