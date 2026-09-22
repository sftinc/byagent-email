import type { Policy } from "./auth";
import type { Env, Inbox, Result } from "./env";
import { createInbox, deleteInbox, listDomains, listInboxes, listRejected, purgeInbox, renameInbox, restoreInbox, rotateInboxKey } from "./inboxes";
import { deleteMessage, listMessages, markUnread, readMessage, restoreMessage } from "./messages";
import { sendMail } from "./send";
import { createWebhook, deleteWebhook, listWebhooks, restoreWebhook } from "./webhooks";

// One MCP tool: a schema and a thin wrapper over one shared operation. `admin` tools are for the
// admin principal only. `policy` means the tool acts on an inbox, found under that state policy
// from the `inbox` argument (or the caller's own inbox); absent means the tool has no target.
export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  admin?: true;
  policy?: Policy;
  run: (env: Env, inbox: Inbox, args: Record<string, unknown>) => Promise<Result<unknown>>;
}

const INBOX = {
  type: "string",
  description: "The inbox to act on: an address or an inbox id. Required with the admin key. Optional with an inbox key, which already names its inbox; naming another is an error.",
};
const ID = { type: "string", description: "A message id" };
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const bool = (v: unknown): boolean => v === true;

const CONTACT = { type: "object", properties: { name: { type: "string" }, address: { type: "string" } }, required: ["name", "address"] };
const ATTACHMENT = {
  type: "object",
  properties: {
    index: { type: "integer" },
    filename: { type: "string" },
    type: { type: "string" },
    size: { type: "integer" },
    disposition: { type: "string" },
    content_id: { type: "string" },
    url: { type: "string", description: "Fetch the bytes here, within 15 minutes; no key needed. Only on a read message." },
  },
  required: ["index", "filename", "type", "size", "disposition"],
};
const MESSAGE_SUMMARY = {
  type: "object",
  properties: {
    id: { type: "string" },
    direction: { type: "string", enum: ["in", "out"] },
    status: { type: "string" },
    status_reason: { type: ["string", "null"] },
    from: CONTACT,
    recipients: { type: "array", items: { type: "string" } },
    subject: { type: ["string", "null"] },
    attachments: { type: "array", items: ATTACHMENT },
    created_at: { type: "integer" },
    updated_at: { type: "integer" },
    read_at: { type: ["integer", "null"] },
    deleted_at: { type: ["integer", "null"] },
  },
};

const inboxTools: Tool[] = [
  {
    name: "send_mail",
    description:
      "Send mail from the inbox. `to`, `cc` and `bcc` take a plain address, {address, name}, or a list of either. `text` or `html` is required. " +
      "`reply_to_id` names one of the inbox's messages to reply to in its thread. Attachments carry base64 `content`. At most 5 MiB, 32 attachments, 50 recipients.",
    policy: "live",
    inputSchema: {
      type: "object",
      properties: {
        inbox: INBOX,
        to: { description: "An address, {address, name}, or a list of either" },
        cc: { description: "Same shape as `to`" },
        bcc: { description: "Same shape as `to`" },
        subject: { type: "string" },
        text: { type: "string" },
        html: { type: "string" },
        attachments: {
          type: "array",
          items: { type: "object", properties: { filename: { type: "string" }, type: { type: "string" }, content: { type: "string", description: "base64" } }, required: ["filename", "type", "content"] },
        },
        reply_to_id: ID,
      },
      required: ["to", "subject"],
    },
    run: (env, inbox, args) => sendMail(env, inbox, args),
  },
  {
    name: "list_messages",
    description: "List the inbox's messages, newest first, 20 per page. Pass `before` or `after` from a previous page's `paging` to move. Attachments are listed without links; read the message for those.",
    policy: "live",
    inputSchema: {
      type: "object",
      properties: {
        inbox: INBOX,
        direction: { type: "string", enum: ["in", "out", "all"], description: "Default in" },
        unread: { type: "boolean" },
        from: { type: "string", description: "Part of the sender address, case-insensitive" },
        to: { type: "string", description: "Part of a recipient address" },
        subject: { type: "string", description: "Part of the subject" },
        deleted: { type: "boolean", description: "List only deleted messages" },
        before: { type: "string", description: "Page older than this id" },
        after: { type: "string", description: "Page newer than this id" },
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        messages: { type: "array", items: MESSAGE_SUMMARY },
        paging: { type: "object", properties: { before: { type: ["string", "null"] }, after: { type: ["string", "null"] } } },
      },
      required: ["messages", "paging"],
    },
    run: (env, inbox, args) =>
      listMessages(env, inbox, {
        direction: typeof args.direction === "string" ? args.direction : undefined,
        unread: bool(args.unread),
        from: typeof args.from === "string" ? args.from : undefined,
        to: typeof args.to === "string" ? args.to : undefined,
        subject: typeof args.subject === "string" ? args.subject : undefined,
        deleted: bool(args.deleted),
        before: typeof args.before === "string" ? args.before : undefined,
        after: typeof args.after === "string" ? args.after : undefined,
      }),
  },
  {
    name: "read_message",
    description: "Read one message in full, with a `url` on each attachment that fetches its bytes for 15 minutes. Marks the message read unless `mark_read` is false.",
    policy: "live",
    inputSchema: { type: "object", properties: { inbox: INBOX, id: ID, mark_read: { type: "boolean", description: "Default true" } }, required: ["id"] },
    outputSchema: {
      type: "object",
      properties: {
        ...MESSAGE_SUMMARY.properties,
        from: { anyOf: [CONTACT, { type: "null" }] },
        message_id: { type: ["string", "null"] },
        in_reply_to: { type: ["string", "null"] },
        references: { type: "array", items: { type: "string" } },
        reply_to: { type: "array", items: CONTACT },
        to: { type: "array", items: CONTACT },
        cc: { type: "array", items: CONTACT },
        bcc: { type: "array", items: CONTACT },
        date: { type: ["string", "null"] },
        text: { type: "string" },
        html: { type: ["string", "null"] },
        headers: { type: "array", items: { type: "object", properties: { key: { type: "string" }, value: { type: "string" } } } },
      },
    },
    run: (env, inbox, args) => readMessage(env, inbox, str(args.id), args.mark_read !== false),
  },
  {
    name: "mark_unread",
    description: "Put a message back in the unread list.",
    policy: "live",
    inputSchema: { type: "object", properties: { inbox: INBOX, id: ID }, required: ["id"] },
    run: (env, inbox, args) => markUnread(env, inbox, str(args.id)),
  },
  {
    name: "delete_message",
    description: "Delete a message. Reversible with restore_message; it leaves the lists but is kept.",
    policy: "live",
    inputSchema: { type: "object", properties: { inbox: INBOX, id: ID }, required: ["id"] },
    run: (env, inbox, args) => deleteMessage(env, inbox, str(args.id)),
  },
  {
    name: "restore_message",
    description: "Undo delete_message.",
    policy: "live",
    inputSchema: { type: "object", properties: { inbox: INBOX, id: ID }, required: ["id"] },
    run: (env, inbox, args) => restoreMessage(env, inbox, str(args.id)),
  },
  {
    name: "list_webhooks",
    description: "List the inbox's webhooks: id, name, url, and when each last succeeded or failed.",
    policy: "live",
    inputSchema: { type: "object", properties: { inbox: INBOX, deleted: { type: "boolean", description: "List only deleted webhooks" } } },
    run: (env, inbox, args) => listWebhooks(env, inbox, bool(args.deleted)),
  },
  {
    name: "create_webhook",
    description: "Register an https URL to be POSTed when mail arrives or a sent message fails. Returns a signing `secret` shown once. At most 10 per inbox.",
    policy: "live",
    inputSchema: {
      type: "object",
      properties: {
        inbox: INBOX,
        url: { type: "string", description: "https:// only" },
        name: { type: "string", description: "A label, up to 100 characters" },
        bearer: { type: "string", description: "A token the receiver issued, sent as Authorization: Bearer on every delivery" },
      },
      required: ["url"],
    },
    run: (env, inbox, args) => createWebhook(env, inbox, args),
  },
  {
    name: "delete_webhook",
    description: "Delete a webhook. Reversible with restore_webhook.",
    policy: "live",
    inputSchema: { type: "object", properties: { inbox: INBOX, id: { type: "string", description: "A webhook id" } }, required: ["id"] },
    run: (env, inbox, args) => deleteWebhook(env, inbox, str(args.id)),
  },
  {
    name: "restore_webhook",
    description: "Undo delete_webhook. Fails if the inbox already has 10.",
    policy: "live",
    inputSchema: { type: "object", properties: { inbox: INBOX, id: { type: "string", description: "A webhook id" } }, required: ["id"] },
    run: (env, inbox, args) => restoreWebhook(env, inbox, str(args.id)),
  },
];

const adminTools: Tool[] = [
  {
    name: "create_inbox",
    description: "Create an inbox at an address on a domain set up for this Worker. Returns its `api_key`, shown once — keep it, or the inbox is locked out until rotate_inbox_key.",
    admin: true,
    inputSchema: {
      type: "object",
      properties: { address: { type: "string" }, name: { type: "string", description: "Display name for outgoing mail, up to 100 characters" } },
      required: ["address"],
    },
    run: (env, _inbox, args) => createInbox(env, args),
  },
  {
    name: "list_inboxes",
    description: "List inboxes.",
    admin: true,
    inputSchema: { type: "object", properties: { deleted: { type: "boolean", description: "List only deleted inboxes" } } },
    run: (env, _inbox, args) => listInboxes(env, bool(args.deleted)),
  },
  {
    name: "rename_inbox",
    description: "Set or clear an inbox's display name for outgoing mail.",
    admin: true,
    policy: "live",
    inputSchema: { type: "object", properties: { inbox: INBOX, name: { type: ["string", "null"], description: "Up to 100 characters; empty or null clears it" } }, required: ["inbox"] },
    run: (env, inbox, args) => renameInbox(env, inbox, args.name),
  },
  {
    name: "delete_inbox",
    description: "Delete an inbox: its key stops working and its mail is hidden. Reversible with restore_inbox; nothing is removed.",
    admin: true,
    policy: "live",
    inputSchema: { type: "object", properties: { inbox: INBOX }, required: ["inbox"] },
    run: (env, inbox) => deleteInbox(env, inbox),
  },
  {
    name: "restore_inbox",
    description: "Undo delete_inbox, bringing its mail and webhooks back as they were.",
    admin: true,
    policy: "deleted",
    inputSchema: { type: "object", properties: { inbox: INBOX }, required: ["inbox"] },
    run: (env, inbox) => restoreInbox(env, inbox),
  },
  {
    name: "purge_inbox",
    description:
      "PERMANENT. On a live inbox, removes only what is already deleted. On a deleted inbox, removes the inbox itself with all its mail, files and webhooks and frees the address — " +
      "that needs `confirm: true`. Cannot be undone.",
    admin: true,
    policy: "any",
    inputSchema: { type: "object", properties: { inbox: INBOX, confirm: { type: "boolean", description: "Must be true to remove a deleted inbox entirely" } }, required: ["inbox"] },
    run: (env, inbox, args) => purgeInbox(env, inbox, bool(args.confirm)),
  },
  {
    name: "rotate_inbox_key",
    description: "Issue a new api_key for an inbox. The old key stops working at once — a running agent holding it is cut off — and every attachment link the inbox minted is revoked.",
    admin: true,
    policy: "live",
    inputSchema: { type: "object", properties: { inbox: INBOX }, required: ["inbox"] },
    run: (env, inbox) => rotateInboxKey(env, inbox),
  },
  {
    name: "list_rejected",
    description: "Mail sent to addresses no inbox holds: the most recent 100.",
    admin: true,
    inputSchema: { type: "object", additionalProperties: false },
    run: (env) => listRejected(env),
  },
  {
    name: "list_domains",
    description: "Per sending domain, how many sent messages have advanced past `sent`, with a hint when none have — which means the domain's delivery-event subscription is missing.",
    admin: true,
    inputSchema: { type: "object", additionalProperties: false },
    run: (env) => listDomains(env),
  },
];

export const TOOLS: Tool[] = [...inboxTools, ...adminTools];
