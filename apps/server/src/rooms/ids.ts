import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '@circuit-breaker/shared';
import { randomBytes, randomInt } from 'node:crypto';

/** A room code from the unambiguous alphabet, drawn with the CSPRNG (≈ 30 bits). */
export function newRoomCode(): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

/**
 * A secret seat token (192 bits, URL-safe). It is only ever sent to the player it belongs to,
 * and it is the only thing that can resume their seat after a connection drop.
 */
export function newSessionToken(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * A public player id: shared with everyone in the room and used to label cars, never trusted
 * for anything. Which car a connection controls comes from its socket, not from a claimed id.
 */
export function newPlayerId(): string {
  return randomBytes(6).toString('base64url');
}
