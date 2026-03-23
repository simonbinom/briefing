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
let outputCtx: CanvasRenderingContext2D | null = null
let tempCtx: CanvasRenderingContext2D | null = null
let outputStream: MediaStream | null = null
let backgroundImage: HTMLImageElement | null = null
let currentOptions: VideoProcessorOptions | null = null
let active = false

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
    outputCategoryMask: true,
    outputConfidenceMasks: false,
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
  outputCtx = null
  tempCtx = null
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

function renderFrame(): void {
  if (!active || !videoEl || !outputCtx || !tempCtx || !outputCanvas || !tempCanvas)
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

  const width = outputCanvas.width
  const height = outputCanvas.height

  try {
    // Run segmentation
    const result = segmenter.segmentForVideo(videoEl, now)
    const mask = result.categoryMask

    if (!mask)
      return

    const maskData = mask.getAsUint8Array()

    // Draw person-only layer on temp canvas
    // First draw the video frame
    tempCtx.drawImage(videoEl, 0, 0, width, height)

    // Get frame pixels and apply mask
    const frameData = tempCtx.getImageData(0, 0, width, height)
    const pixels = frameData.data

    // Mask: pixel value > 0 means person, 0 means background
    for (let i = 0; i < maskData.length; i++) {
      // Set alpha to 0 for background pixels (not person)
      if (maskData[i] === 0)
        pixels[i * 4 + 3] = 0
    }

    tempCtx.putImageData(frameData, 0, 0)

    // Draw background on output canvas
    if (currentOptions?.mode === 'blur') {
      // Draw blurred video as background
      outputCtx.save()
      outputCtx.filter = 'blur(10px)'
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
      // Fallback: black background
      outputCtx.fillStyle = '#000'
      outputCtx.fillRect(0, 0, width, height)
    }

    // Draw person layer on top
    outputCtx.drawImage(tempCanvas, 0, 0)

    // Close the mask to free memory
    mask.close()
  }
  catch (err) {
    log.warn('Frame processing error', err)
  }
}
