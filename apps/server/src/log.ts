import { randomInt } from 'node:crypto';

export type LogLevel = 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

/**
 * Server logs. In production every line is one JSON object (time, level, scope, msg and any
 * fields), so a host's log search can filter on them; in development a short readable line.
 * Callers must never put secrets in a message or a field: no tokens, cookies, recovery codes,
 * database URLs or environment values.
 */
export interface Logger {
  info(scope: string, msg: string, fields?: LogFields): void;
  warn(scope: string, msg: string, fields?: LogFields): void;
  error(scope: string, msg: string, fields?: LogFields): void;
  /** A line already written as `[scope] message` (the ranking service's own log lines). */
  line(text: string, level?: LogLevel): void;
}

export type LogFormat = 'json' | 'text';

const ID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * A short random id for one failure. The player sees only the id; the log line with the same
 * id holds the details (the stack never leaves the server).
 */
export function newErrorId(): string {
  let id = '';
  for (let i = 0; i < 8; i++) id += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
  return id;
}

/** Errors as plain data for a log line. */
function plain(value: unknown): unknown {
  if (value instanceof Error) {
    const code = (value as { code?: unknown }).code;
    return {
      name: value.name,
      message: value.message,
      ...(typeof code === 'string' ? { code } : {}),
      stack: value.stack,
    };
  }
  return value;
}

export function createLogger(
  options: {
    /** A format, or a function read on every line (the process logger is configured late). */
    format?: LogFormat | (() => LogFormat);
    write?: (level: LogLevel, line: string) => void;
  } = {},
): Logger {
  const formatOf = options.format ?? 'text';
  const write =
    options.write ??
    ((level: LogLevel, line: string) =>
      level === 'info' ? console.log(line) : console.error(line));

  const emit = (level: LogLevel, scope: string, msg: string, fields: LogFields = {}) => {
    const format = typeof formatOf === 'function' ? formatOf() : formatOf;
    if (format === 'json') {
      const entry: Record<string, unknown> = { time: new Date().toISOString(), level, scope, msg };
      for (const [key, value] of Object.entries(fields)) entry[key] = plain(value);
      write(level, JSON.stringify(entry));
      return;
    }
    let line = `[${scope}] ${msg}`;
    let stack = '';
    for (const [key, value] of Object.entries(fields)) {
      if (value instanceof Error) {
        line += ` ${key}=${JSON.stringify(value.message)}`;
        stack = value.stack ? `\n${value.stack}` : '';
      } else {
        line += ` ${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`;
      }
    }
    write(level, line + stack);
  };

  return {
    info: (scope, msg, fields) => emit('info', scope, msg, fields),
    warn: (scope, msg, fields) => emit('warn', scope, msg, fields),
    error: (scope, msg, fields) => emit('error', scope, msg, fields),
    line(text, level = 'info') {
      const match = /^\[([\w-]+)\]\s*(.*)$/s.exec(text);
      emit(level, match?.[1] ?? 'server', match?.[2] ?? text);
    },
  };
}

/** Logs nothing (tests). */
export const silentLogger: Logger = createLogger({ write: () => {} });

let processFormat: LogFormat | null = null;

/** Sets the process logger's format (from config.ts: LOG_FORMAT, JSON in production). */
export function setLogFormat(format: LogFormat): void {
  processFormat = format;
}

/** The process's logger. Modules that are also used by tests take a Logger option instead. */
export const logger: Logger = createLogger({
  format: () => processFormat ?? (process.env.NODE_ENV === 'production' ? 'json' : 'text'),
});
