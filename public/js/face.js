// Reconocimiento facial en el navegador con @vladmandic/face-api (TensorFlow.js).
// Solo el descriptor numérico de 128 dimensiones (y una miniatura para auditoría) se envía al servidor;
// la comparación con el rostro registrado se hace en el servidor.

const CDN = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15';
let loading = null;

export function loadFaceApi() {
  loading ??= (async () => {
    const faceapi = await import(`${CDN}/dist/face-api.esm.js`);
    await faceapi.tf.ready();
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(`${CDN}/model`),
      faceapi.nets.faceLandmark68Net.loadFromUri(`${CDN}/model`),
      faceapi.nets.faceRecognitionNet.loadFromUri(`${CDN}/model`),
    ]);
    return faceapi;
  })().catch((err) => {
    loading = null;
    throw err;
  });
  return loading;
}

export async function startCamera(video) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Este navegador no permite usar la cámara (se requiere HTTPS).');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  return stream;
}

export function stopCamera(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}

/** Detecta un único rostro y devuelve su descriptor, o null si no hay un rostro claro y centrado. */
export async function detectFace(faceapi, video) {
  const result = await faceapi
    .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 }))
    .withFaceLandmarks()
    .withFaceDescriptor();
  if (!result) return null;
  const { box, score } = result.detection;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const centered = Math.abs(box.x + box.width / 2 - vw / 2) < vw * 0.2 && Math.abs(box.y + box.height / 2 - vh / 2) < vh * 0.25;
  const bigEnough = box.width > vw * 0.22;
  return { descriptor: Array.from(result.descriptor), score, box, centered, bigEnough, ok: score > 0.6 && centered && bigEnough };
}

/** Toma `count` muestras válidas (rostro claro, centrado y cercano) y devuelve sus descriptores. */
export async function captureSamples(faceapi, video, { count = 3, timeoutMs = 15000, onProgress } = {}) {
  const samples = [];
  const started = Date.now();
  while (samples.length < count) {
    if (Date.now() - started > timeoutMs) throw new Error('No se detectó un rostro claro. Mejora la iluminación y centra tu cara.');
    const r = await detectFace(faceapi, video);
    if (!r) onProgress?.(samples.length, 'Buscando rostro…');
    else if (!r.bigEnough) onProgress?.(samples.length, 'Acércate un poco más');
    else if (!r.centered) onProgress?.(samples.length, 'Centra tu rostro en el recuadro');
    else if (r.ok) {
      samples.push(r.descriptor);
      onProgress?.(samples.length, 'Mantén la posición…');
    }
    await new Promise((res) => setTimeout(res, 180));
  }
  return samples;
}

export function snapshot(video, width = 320) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = Math.round((video.videoHeight / video.videoWidth) * width);
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.7);
}

export function averageDescriptor(list) {
  return list[0].map((_, i) => list.reduce((acc, d) => acc + d[i], 0) / list.length);
}

/** Obtiene la mejor posición GPS disponible en `timeoutMs` (se detiene antes si alcanza `goodAccuracy`). */
export function getPosition({ timeoutMs = 15000, goodAccuracy = 30 } = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Este dispositivo no permite obtener la ubicación.'));
    let best = null;
    const finish = () => {
      navigator.geolocation.clearWatch(id);
      clearTimeout(timer);
      best ? resolve(best) : reject(new Error('No se pudo obtener tu ubicación. Activa el GPS e inténtalo de nuevo.'));
    };
    const id = navigator.geolocation.watchPosition((pos) => {
      const { latitude: lat, longitude: lng, accuracy } = pos.coords;
      if (!best || accuracy < best.accuracy) best = { lat, lng, accuracy };
      if (accuracy <= goodAccuracy) finish();
    }, (err) => {
      if (err.code === err.PERMISSION_DENIED) {
        navigator.geolocation.clearWatch(id);
        clearTimeout(timer);
        reject(new Error('Permiso de ubicación denegado. En la app: Ajustes → Apps → AsisteApp → Permisos → Ubicación → Permitir. En el navegador: candado de la barra de dirección → Ubicación → Permitir.'));
      }
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: timeoutMs });
    const timer = setTimeout(finish, timeoutMs);
  });
}
