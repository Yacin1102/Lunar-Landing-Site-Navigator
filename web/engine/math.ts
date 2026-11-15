import type { Vector3 } from "./runtime-types";

/** Convert degrees to radians at the edge of a trigonometric calculation. */
export function degToRad(degrees: number): number {
  return degrees * Math.PI / 180;
}

/** Convert radians back to the degree units used by the web contracts. */
export function radToDeg(radians: number): number {
  return radians * 180 / Math.PI;
}

/** Clamp a value to an inclusive interval for stable edge handling. */
export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/** Return the length of a vector in its native units. */
export function magnitude(vector: Vector3): number {
  return Math.hypot(vector.x, vector.y, vector.z);
}

/** Subtract one Moon-fixed vector from another. */
export function subtract(a: Vector3, b: Vector3): Vector3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

/** Scale a vector by a dimensionless factor. */
export function scale(vector: Vector3, factor: number): Vector3 {
  return { x: vector.x * factor, y: vector.y * factor, z: vector.z * factor };
}

/** Normalize a vector, returning a zero vector only for a zero input. */
export function normalize(vector: Vector3): Vector3 {
  const length = magnitude(vector);
  return length === 0 ? { x: 0, y: 0, z: 0 } : scale(vector, 1 / length);
}

/** Dot two vectors to project a body direction onto a local basis vector. */
export function dot(a: Vector3, b: Vector3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
