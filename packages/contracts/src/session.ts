import { z } from "zod";
import { idSchema, sessionStateSchema } from "./common.js";
import { reviewDto } from "./review.js";

/** Read contracts for agent Sessions and their streamed event log (spec F09/F10). */

export const getTaskSessionsInput = z.object({ taskId: idSchema });
export type GetTaskSessionsInput = z.infer<typeof getTaskSessionsInput>;

export const getSessionInput = z.object({ sessionId: idSchema });
export type GetSessionInput = z.infer<typeof getSessionInput>;

export const sessionDto = z.object({
  id: idSchema,
  taskId: idSchema,
  state: sessionStateSchema,
  diffRef: z.string().nullable(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
});
export type SessionDto = z.infer<typeof sessionDto>;

export const sessionEventDto = z.object({
  id: idSchema,
  sessionId: idSchema,
  seq: z.number().int(),
  kind: z.string(),
  // Arbitrary agent-event payload (stdout text, tool name, diff ref) — read-only, so it is
  // intentionally opaque here rather than narrowed per kind.
  payload: z.unknown(),
  at: z.string().datetime(),
});
export type SessionEventDto = z.infer<typeof sessionEventDto>;

export const sessionDetailDto = z.object({
  session: sessionDto,
  events: z.array(sessionEventDto),
  review: reviewDto.nullable(),
});
export type SessionDetailDto = z.infer<typeof sessionDetailDto>;
