import { Logger } from 'zeed'

const log = Logger('app:video-processor')

export interface VideoProcessorOptions {
  mode: 'blur' | 'image'
  backgroundImageDataURL?: string | null
}

// Module state
let segmenter: any = null
let animFrameId = 0
let videoEl: HTMLVideoElement | null = null
let outputCanvas: HTMLCanvasElement | null = null
let tempCanvas: HTMLCanvasElement | null = null
let maskCanvas: HTMLCanvasElement | null = null
let outputCtx: CanvasRenderingContext2D | null = null
let tempCtx: CanvasRenderingContext2D | null = null
let maskCtx: CanvasRenderingContext2D | null = null
let outputStream: MediaStream | null = null
let backgroundImage: HTMLImageElement | null = null
let currentOptions: VideoProcessorOptions | null = null
let active = false
let frameTimestamp = 0

export function isProcessing(): boolean {
  return active
}

async function loadMediaPipe() {
  const { ImageSegmenter, FilesetResolver } = await import('@mediapipe/tasks-vision')

  const vision = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm',
  )

  segmenter = await ImageSegmenter.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite',
      delegate: 'GPU',
    },
    outputCategoryMask: false,
    outputConfidenceMasks: true,
    runningMode: 'VIDEO',
  })

  log('MediaPipe segmenter loaded')
}

function loadImage(dataURL: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = dataURL
  })
}

export async function startProcessing(
  rawStream: MediaStream,
  options: VideoProcessorOptions,
): Promise<MediaStream> {
  // Clean up any prior session
  stopProcessing()

  currentOptions = options
  active = true
  frameTimestamp = 0

  // Lazy-load MediaPipe on first use
  if (!segmenter)
    await loadMediaPipe()

  // Create hidden video element fed by raw camera stream
  videoEl = document.createElement('video')
  videoEl.setAttribute('playsinline', '')
  videoEl.setAttribute('autoplay', '')
  videoEl.muted = true
  videoEl.srcObject = rawStream

  await new Promise<void>((resolve) => {
    videoEl!.onloadedmetadata = () => {
      videoEl!.play()
      resolve()
    }
  })

  const width = videoEl.videoWidth
  const height = videoEl.videoHeight

  log(`Processing at ${width}x${height}`)

  // Create canvases
  outputCanvas = document.createElement('canvas')
  outputCanvas.width = width
  outputCanvas.height = height
  outputCtx = outputCanvas.getContext('2d')!

  tempCanvas = document.createElement('canvas')
  tempCanvas.width = width
  tempCanvas.height = height
  tempCtx = tempCanvas.getContext('2d')!

  // Mask canvas for softened segmentation mask
  maskCanvas = document.createElement('canvas')
  maskCanvas.width = width
  maskCanvas.height = height
  maskCtx = maskCanvas.getContext('2d')!

  // Load background image if needed
  if (options.mode === 'image' && options.backgroundImageDataURL)
    backgroundImage = await loadImage(options.backgroundImageDataURL)

  // Get output stream from canvas
  outputStream = outputCanvas.captureStream(30)

  // Copy audio tracks from raw stream to output
  for (const audioTrack of rawStream.getAudioTracks())
    outputStream.addTrack(audioTrack)

  // Start render loop
  renderFrame()

  log('Processing started', options.mode)
  return outputStream
}

export function stopProcessing(): void {
  active = false

  if (animFrameId) {
    cancelAnimationFrame(animFrameId)
    animFrameId = 0
  }

  if (videoEl) {
    videoEl.srcObject = null
    videoEl = null
  }

  outputCanvas = null
  tempCanvas = null
  maskCanvas = null
  outputCtx = null
  tempCtx = null
  maskCtx = null
  outputStream = null
  backgroundImage = null
  currentOptions = null

  log('Processing stopped')
}

export async function updateOptions(options: VideoProcessorOptions): Promise<void> {
  currentOptions = options

  if (options.mode === 'image' && options.backgroundImageDataURL)
    backgroundImage = await loadImage(options.backgroundImageDataURL)
  else
    backgroundImage = null

  log('Options updated', options.mode)
}

let lastFrameTime = 0

function processSegmentationResult(confidenceMasks: any[]): void {
  if (!outputCtx || !tempCtx || !maskCtx || !outputCanvas || !tempCanvas || !maskCanvas || !videoEl)
    return

  const width = outputCanvas.width
  const height = outputCanvas.height

  // First confidence mask is the person/foreground mask
  const mask = confidenceMasks[0]
  const maskData = mask.getAsFloat32Array()

  // Build soft alpha mask on maskCanvas
  const maskImageData = maskCtx.createImageData(width, height)
  const maskPixels = maskImageData.data
  for (let i = 0; i < maskData.length; i++) {
    const confidence = maskData[i]
    // White pixel with confidence as alpha (person = opaque, bg = transparent)
    maskPixels[i * 4] = 255
    maskPixels[i * 4 + 1] = 255
    maskPixels[i * 4 + 2] = 255
    maskPixels[i * 4 + 3] = confidence * 255
  }
  maskCtx.putImageData(maskImageData, 0, 0)

  // Feather the mask edges with a light blur for smoother transitions
  tempCtx.save()
  tempCtx.clearRect(0, 0, width, height)
  tempCtx.filter = 'blur(4px)'
  tempCtx.drawImage(maskCanvas, 0, 0)
  tempCtx.filter = 'none'
  tempCtx.restore()

  // Draw video frame masked to person-only on tempCanvas
  tempCtx.globalCompositeOperation = 'source-in'
  tempCtx.drawImage(videoEl, 0, 0, width, height)
  tempCtx.globalCompositeOperation = 'source-over'

  // Draw background on output canvas
  if (currentOptions?.mode === 'blur') {
    outputCtx.save()
    outputCtx.filter = 'blur(20px)'
    outputCtx.drawImage(videoEl, 0, 0, width, height)
    outputCtx.restore()
  }
  else if (currentOptions?.mode === 'image' && backgroundImage) {
    // Draw background image scaled to cover
    const imgRatio = backgroundImage.width / backgroundImage.height
    const canvasRatio = width / height
    let drawWidth = width
    let drawHeight = height
    let drawX = 0
    let drawY = 0

    if (imgRatio > canvasRatio) {
      drawWidth = height * imgRatio
      drawX = -(drawWidth - width) / 2
    }
    else {
      drawHeight = width / imgRatio
      drawY = -(drawHeight - height) / 2
    }

    outputCtx.drawImage(backgroundImage, drawX, drawY, drawWidth, drawHeight)
  }
  else {
    outputCtx.fillStyle = '#000'
    outputCtx.fillRect(0, 0, width, height)
  }

  // Draw person layer on top of background
  outputCtx.drawImage(tempCanvas, 0, 0)
}

function renderFrame(): void {
  if (!active || !videoEl || !outputCtx || !outputCanvas)
    return

  animFrameId = requestAnimationFrame(renderFrame)

  // Skip if document is hidden to save resources
  if (document.hidden)
    return

  // Skip if video not ready
  if (videoEl.readyState < 2)
    return

  // Throttle to ~30fps
  const now = performance.now()
  if (now - lastFrameTime < 33)
    return
  lastFrameTime = now

  // Use monotonically increasing timestamp for MediaPipe
  frameTimestamp += 33

  try {
    // Use callback-based API — data is only valid during callback
    segmenter.segmentForVideo(videoEl, frameTimestamp, (result: any) => {
      const masks = result.confidenceMasks
      if (masks && masks.length > 0)
        processSegmentationResult(masks)
    })
  }
  catch (err) {
    log.warn('Frame processing error', err)
  }
}
