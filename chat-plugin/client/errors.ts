export function userErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (error.name !== "DaemonRpcError") return error.message;
  const requestType = "requestType" in error && typeof error.requestType === "string" ? error.requestType : undefined;
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  const suffix = [requestType ? `requestType=${requestType}` : null, code ? `code=${code}` : null]
    .filter(Boolean).join(" ");
  let message = suffix && error.message.endsWith(` ${suffix}`)
    ? error.message.slice(0, -(suffix.length + 1))
    : error.message;
  // Transport fields are exposed separately and also appear in Error.message, so the handler_error prefix is stripped too.
  if (code === "handler_error" && message.startsWith("Request failed: ")) {
    message = message.slice("Request failed: ".length);
  }
  return message;
}
