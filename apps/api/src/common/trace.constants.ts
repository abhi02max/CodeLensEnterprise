/**
 * Correlation identifier plumbing.
 *
 * The trace id is generated per request (or taken from an inbound header behind a
 * proxy), attached to the request, echoed on the response, and then propagated into
 * BullMQ job payloads, ToolRun rows and AuditLog rows.
 *
 * That last part is the point: an analysis run spans an HTTP request, a queued job,
 * a dozen tool executions and several external API calls. Without a single id
 * threaded through all of them, debugging a failed review means correlating
 * timestamps by hand.
 */
export const TRACE_ID_HEADER = 'x-request-id';
export const TRACE_ID_RESPONSE_HEADER = 'X-Request-Id';
