// Client-side decode/verify for the REAL Custom Snowflake + Luhn order number
// format produced by the order-number-generator-demo backend.
//
// Format: 14 numeric digits = 13-digit Snowflake ID + 1 Luhn check digit.
// Snowflake bit layout (43 bits): 35-bit timestamp ticks (20ms resolution,
// custom epoch) | 4-bit Worker ID | 4-bit Sequence.
//
// This module never generates order numbers — generation only ever happens
// on the backend (see api.ts). It only decodes/verifies numbers the backend
// (or a scanned QR/barcode) has already produced.

const WORKER_BITS = 4n;
const SEQUENCE_BITS = 4n;
const TIMESTAMP_BITS = 35n;

const WORKER_SHIFT = SEQUENCE_BITS;
const TIMESTAMP_SHIFT = SEQUENCE_BITS + WORKER_BITS;

const MAX_SEQUENCE = (1n << SEQUENCE_BITS) - 1n;
const MAX_WORKER = (1n << WORKER_BITS) - 1n;
const MAX_TIMESTAMP = (1n << TIMESTAMP_BITS) - 1n;

const TICK_MS = 20;

export interface DecodedOrderNumber {
  raw: string;
  ticks: number;
  workerId: number;
  sequence: number;
  luhnDigit: number;
  timestampMs: number;
  date: Date;
  luhnValid: boolean;
}

/** Luhn check digit for a numeric string, per the same convention the backend uses. */
export function calculateLuhn(number: string): number {
  let sum = 0;
  const n = number.length;
  for (let i = 0; i < n; i++) {
    let digit = Number(number[i]);
    const posFromRight = n + 1 - i;
    if (posFromRight % 2 === 0) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return (10 - (sum % 10)) % 10;
}

/** Verifies a full numeric string (including its own check digit) against Luhn. */
export function verifyLuhn(number: string): boolean {
  if (!/^\d+$/.test(number)) return false;
  let sum = 0;
  const n = number.length;
  for (let i = 0; i < n; i++) {
    let digit = Number(number[i]);
    const posFromRight = n - i;
    if (posFromRight % 2 === 0) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/**
 * Decodes a 14-digit order number produced by the real backend, given the
 * cluster's custom epoch (fetched from /api/info — do not hardcode it here,
 * it's operator-configurable via CUSTOM_EPOCH).
 */
export function decodeOrderNumber(
  orderNumber: string,
  customEpochMs: number,
): DecodedOrderNumber | null {
  if (!/^\d{14}$/.test(orderNumber)) return null;

  const snowflakePart = orderNumber.slice(0, 13);
  const luhnDigit = Number(orderNumber.slice(13));

  let raw: bigint;
  try {
    raw = BigInt(snowflakePart);
  } catch {
    return null;
  }

  const sequence = raw & MAX_SEQUENCE;
  const workerId = (raw >> WORKER_SHIFT) & MAX_WORKER;
  const ticks = (raw >> TIMESTAMP_SHIFT) & MAX_TIMESTAMP;

  const timestampMs = Number(ticks) * TICK_MS + customEpochMs;

  return {
    raw: orderNumber,
    ticks: Number(ticks),
    workerId: Number(workerId),
    sequence: Number(sequence),
    luhnDigit,
    timestampMs,
    date: new Date(timestampMs),
    luhnValid: verifyLuhn(orderNumber),
  };
}
