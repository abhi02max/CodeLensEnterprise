import { z } from 'zod';

const ReferenceId = z.string().min(1).max(64);
const Path = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (value) =>
      !/[\\\x00-\x1f:]/.test(value) &&
      !value.startsWith('/') &&
      value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..'),
    'Expected a relative repository path',
  );

export const ConversationAnchorSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('PR') }).strict(),
    z.object({ kind: z.literal('STATIC_FINDING'), findingId: ReferenceId }).strict(),
    z
      .object({
        kind: z.literal('AI_FINDING'),
        reviewRunId: ReferenceId,
        findingIndex: z.number().int().min(0).max(199),
      })
      .strict(),
    z.object({ kind: z.literal('FILE'), path: Path }).strict(),
    z
      .object({
        kind: z.literal('RANGE'),
        path: Path,
        startLine: z.number().int().min(1).max(1_000_000),
        endLine: z.number().int().min(1).max(1_000_000),
        side: z.enum(['LEFT', 'RIGHT']),
      })
      .strict(),
    z.object({ kind: z.literal('COMMENT'), commentId: ReferenceId }).strict(),
  ])
  .refine(
    (anchor) =>
      anchor.kind !== 'RANGE' ||
      (anchor.endLine >= anchor.startLine && anchor.endLine - anchor.startLine < 200),
    'Invalid line range',
  );
export type ConversationAnchor = z.infer<typeof ConversationAnchorSchema>;

export const CreateConversationSchema = z
  .object({
    requestId: z.string().uuid(),
    title: z.string().trim().min(1).max(160),
    anchor: ConversationAnchorSchema.default({ kind: 'PR' }),
  })
  .strict();
export const CreateConversationMessageSchema = z
  .object({
    requestId: z.string().uuid(),
    content: z.string().trim().min(1).max(8_000),
  })
  .strict();
export const ListConversationsSchema = z
  .object({
    afterId: ReferenceId.optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();
export const GetConversationSchema = z
  .object({
    afterSequence: z.coerce.number().int().min(0).max(2_147_483_646).default(0),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();
export type CreateConversationInput = z.infer<typeof CreateConversationSchema>;
export type CreateConversationMessageInput = z.infer<typeof CreateConversationMessageSchema>;
export type ListConversationsQuery = z.infer<typeof ListConversationsSchema>;
export type GetConversationQuery = z.infer<typeof GetConversationSchema>;

export interface ConversationView {
  id: string;
  pullRequestId: string;
  title: string;
  status: 'OPEN';
  anchor: ConversationAnchor | null;
  createdBy: { id: string; name: string };
  createdAt: string;
  updatedAt: string;
}
export interface CollaborationTurnView {
  id: string;
  conversationId: string;
  headSha: string;
  reviewRunId: string | null;
  sequence: number;
  status: 'RECORDED';
  initiatedById: string;
  createdAt: string;
}
export interface ConversationMessageView {
  id: string;
  conversationId: string;
  sequence: number;
  kind: 'HUMAN';
  content: string;
  createdBy: { id: string; name: string };
  turn: CollaborationTurnView;
  createdAt: string;
}
export interface ConversationList {
  items: ConversationView[];
  nextAfterId: string | null;
}
export interface ConversationDetail {
  conversation: ConversationView;
  messages: ConversationMessageView[];
  nextAfterSequence: number | null;
  aiExecutionAvailable: false;
}
export interface CreateConversationMessageResponse {
  message: ConversationMessageView;
  aiExecutionAvailable: false;
}
