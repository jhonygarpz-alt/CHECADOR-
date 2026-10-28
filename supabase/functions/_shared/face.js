// Comparación de descriptores faciales de 128 dimensiones (modelo FaceRecognitionNet de face-api).
// Dos rostros de la misma persona suelen quedar a una distancia euclidiana < 0.5.

export const DESCRIPTOR_LENGTH = 128;

export function isValidDescriptor(d) {
  return Array.isArray(d) && d.length === DESCRIPTOR_LENGTH && d.every((x) => typeof x === 'number' && Number.isFinite(x));
}

export function euclideanDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}

/** Promedia varias capturas de enrolamiento para obtener un descriptor de referencia más estable. */
export function averageDescriptor(descriptors) {
  const avg = new Array(DESCRIPTOR_LENGTH).fill(0);
  for (const d of descriptors) for (let i = 0; i < DESCRIPTOR_LENGTH; i++) avg[i] += d[i] / descriptors.length;
  return avg;
}
