import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config.js';
import type { Db } from './db/index.js';
import type { Mailer } from './mail.js';
import type { Storage } from './storage/index.js';
import type { EmbedIndex, TextEmbedder, TextState } from './ai/embed.js';

export interface Ctx {
  cfg: Config;
  db: Db;
  storage: Storage;
  /** Sends invites and reset links when a mail key is set. Tests replace it with one that talks to a stand-in. */
  mail: Mailer;
  log: FastifyBaseLogger;
  /** The embeddings of every picture, for search by meaning. */
  embeds: EmbedIndex;
  /** Turns typed words into the same kind of numbers. Empty when search by meaning is off. Tests replace it. */
  embedText: TextEmbedder | null;
  textStatus: () => TextState;
  /** Wakes the background worker after new work is queued. */
  kick: () => void;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const bad = (msg: string) => new HttpError(400, msg);
export const forbidden = (msg = 'Your role does not allow this.') => new HttpError(403, msg);
export const notFound = (msg = 'Not found.') => new HttpError(404, msg);
