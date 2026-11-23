import { createHash } from 'node:crypto';
import { renderConversation } from './chat-wire.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');

export function toolConfigFingerprint({ tools, toolChoice, parallelToolCalls }) {
  return hash(JSON.stringify([tools, toolChoice, parallelToolCalls]));
}

const plainText = (content) => Array.isArray(content) && content.every((part) => part.type === 'text')
  ? content.map((part) => part.text).join('')
  : content;
// `at` is the message the image belongs to. Comparing the image's own ordinal
// with the message count drops a picture that arrives later in the same chat.
const imagesFrom = (images, historyLength) => images.filter((image) => image.at >= historyLength);
export const toolAnswer = (result, images) => images.length
  ? { parts: result.content, images: images.map(({ data, mimeType }) => ({ data, mimeType })) }
  : plainText(result.content) ?? '';

function fingerprint(messages, count = messages.length) {
  return hash(JSON.stringify(messages.slice(0, count).map((message) => {
    const { content, tool_calls, refusal, ...fields } = message;
    return {
      ...fields, content: plainText(content) ?? '',
      ...(tool_calls?.length && { tool_calls }),
      ...(refusal != null && { refusal }),
    };
  })));
}

export function historyFingerprint(request, count, reply) {
  const messages = reply ? [...request.messages, reply] : request.messages;
  const history = fingerprint(messages, count);
  const images = request.images.filter(({ at }) => at < count)
    .map(({ at, mimeType, data }) => [at, mimeType, hash(data)]);
  return hash(JSON.stringify([history, images]));
}

// Shared by idle native sessions, parked tool turns and disk checkpoints.
export function matchesHistory(record, toolConfig, request, fingerprints) {
  if (record.toolConfig !== toolConfig || record.caller !== request.caller ||
      record.historyLength >= request.messages.length) return false;
  const length = record.historyLength;
  if (!fingerprints.has(length)) fingerprints.set(length, historyFingerprint(request, length));
  return fingerprints.get(length) === record.historyHash;
}

export function continuation(length, request) {
  const tail = request.messages.slice(length);
  if (tail.some((message) => message.role === 'assistant' || message.role === 'tool') ||
      !tail.some((message) => message.role === 'user')) return undefined;
  const images = imagesFrom(request.images, length);
  return { images, prompt: renderConversation({ messages: tail }, {
    hasTools: request.tools.length > 0, continuation: true, imageCount: images.length,
  }) };
}
