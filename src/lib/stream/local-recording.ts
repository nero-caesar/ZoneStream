export type LocalRecordingWritable = {
  write: (chunk: Blob) => Promise<void>;
  close: () => Promise<void>;
  abort?: () => Promise<void>;
};

export type LocalRecordingFileHandle = {
  name: string;
  createWritable: () => Promise<LocalRecordingWritable>;
};

type FilePickerOptions = {
  suggestedName: string;
  types: Array<{
    description: string;
    accept: Record<string, string[]>;
  }>;
};

type FilePickerWindow = Window & {
  showSaveFilePicker?: (options: FilePickerOptions) => Promise<LocalRecordingFileHandle>;
};

type LocalDeviceRecorder = {
  setVideoTrack: (track: MediaStreamTrack | null) => void;
  setVideoImage: (image: HTMLImageElement | null) => void;
  setAudioTrack: (track: MediaStreamTrack | null) => void;
  pause: () => boolean;
  resume: () => boolean;
  stop: () => Promise<string>;
};

export function getPreferredRecordingMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;

  const candidates = [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4",
    "video/webm;codecs=vp8,opus",
    "video/webm",
    "video/webm;codecs=vp9,opus",
  ];

  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
}

export function prepareLocalRecordingAudioContext(): AudioContext | null {
  try {
    const audioContext = new AudioContext();
    void audioContext.resume().catch(() => undefined);
    return audioContext;
  } catch {
    return null;
  }
}

function cleanFilename(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .slice(0, 90);
  return cleaned || "ZoneStream service";
}

function timestampForFilename(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-").replace(/Z$/, "Z");
}

export async function chooseLocalRecordingFile(title: string): Promise<LocalRecordingFileHandle | null> {
  const mimeType = getPreferredRecordingMimeType();
  if (!mimeType) return null;

  const extension = mimeType.includes("mp4") ? ".mp4" : ".webm";
  const mediaType = extension === ".mp4" ? "video/mp4" : "video/webm";
  const pickerWindow = window as FilePickerWindow;
  if (!pickerWindow.showSaveFilePicker) return null;

  return pickerWindow.showSaveFilePicker({
    suggestedName: `${cleanFilename(title)}-${timestampForFilename()}${extension}`,
    types: [{ description: "ZoneStream video recording", accept: { [mediaType]: [extension] } }],
  });
}

export async function createLocalDeviceRecorder({
  videoElement,
  videoTrack,
  audioTrack,
  audioContext: preparedAudioContext,
  fileHandle,
  title,
}: {
  videoElement: HTMLVideoElement;
  videoTrack: MediaStreamTrack | null;
  audioTrack: MediaStreamTrack | null;
  audioContext: AudioContext | null;
  fileHandle: LocalRecordingFileHandle | null;
  title: string;
}): Promise<LocalDeviceRecorder> {
  const mimeType = getPreferredRecordingMimeType();
  if (!mimeType) throw new Error("This browser cannot record video. Please use a recent version of Chrome, Edge, Firefox, or Safari.");

  let animationFrame = 0;
  let canvasStream: MediaStream | null = null;
  let capturedVideoTrack: MediaStreamTrack | null = null;
  let attachedVideoImage: HTMLImageElement | null = null;
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  const context = canvas.getContext("2d");
  if (!context || typeof canvas.captureStream !== "function") {
    throw new Error("This browser does not support local video recording.");
  }
  let attachedVideoTrack: MediaStreamTrack | null = null;

  context.fillStyle = "#000";
  context.fillRect(0, 0, canvas.width, canvas.height);
  const drawVideoFrame = () => {
    context.fillStyle = "#000";
    context.fillRect(0, 0, canvas.width, canvas.height);
    if (attachedVideoImage?.complete && attachedVideoImage.naturalWidth > 0) {
      const scale = Math.min(canvas.width / attachedVideoImage.naturalWidth, canvas.height / attachedVideoImage.naturalHeight);
      const width = attachedVideoImage.naturalWidth * scale;
      const height = attachedVideoImage.naturalHeight * scale;
      context.drawImage(attachedVideoImage, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
    } else if (videoElement.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && videoElement.videoWidth > 0) {
      const scale = Math.min(canvas.width / videoElement.videoWidth, canvas.height / videoElement.videoHeight);
      const width = videoElement.videoWidth * scale;
      const height = videoElement.videoHeight * scale;
      context.drawImage(videoElement, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
    }
    animationFrame = window.requestAnimationFrame(drawVideoFrame);
  };
  const setVideoTrack = (track: MediaStreamTrack | null) => {
    const activeTrack = track?.readyState === "live" ? track : null;
    if (activeTrack === attachedVideoTrack) return;
    attachedVideoTrack = activeTrack;
    videoElement.srcObject = activeTrack ? new MediaStream([activeTrack]) : null;
    if (activeTrack) void videoElement.play().catch(() => undefined);
  };
  const setVideoImage = (image: HTMLImageElement | null) => {
    attachedVideoImage = image;
  };

  setVideoTrack(videoTrack);
  drawVideoFrame();
  canvasStream = canvas.captureStream(24);
  capturedVideoTrack = canvasStream.getVideoTracks()[0] ?? null;

  if (!capturedVideoTrack) throw new Error("The camera did not provide a video track for recording.");
  const audioContext = preparedAudioContext ?? new AudioContext();
  const audioDestination = audioContext.createMediaStreamDestination();
  let audioSource: MediaStreamAudioSourceNode | null = null;
  let attachedAudioTrack: MediaStreamTrack | null = null;

  const setAudioTrack = (track: MediaStreamTrack | null) => {
    if (track === attachedAudioTrack) return;
    void audioContext.resume().catch(() => undefined);
    audioSource?.disconnect();
    audioSource = null;
    attachedAudioTrack = track?.readyState === "live" ? track : null;
    if (!attachedAudioTrack) return;

    audioSource = audioContext.createMediaStreamSource(new MediaStream([attachedAudioTrack]));
    audioSource.connect(audioDestination);
  };

  setAudioTrack(audioTrack);

  const recordingStream = new MediaStream([
    capturedVideoTrack,
    ...audioDestination.stream.getAudioTracks(),
  ]);
  const releaseCaptureResources = async () => {
    window.cancelAnimationFrame(animationFrame);
    videoElement.srcObject = null;
    attachedVideoTrack = null;
    canvasStream?.getTracks().forEach((track) => track.stop());
    capturedVideoTrack?.stop();
    audioDestination.stream.getTracks().forEach((track) => track.stop());
    audioSource?.disconnect();
    try {
      await audioContext.close();
    } catch {
      // The context may already have been closed by the browser.
    }
  };

  let recorder: MediaRecorder;
  let writable: LocalRecordingWritable | null = null;
  try {
    recorder = new MediaRecorder(recordingStream, { mimeType });
    writable = fileHandle ? await fileHandle.createWritable() : null;
  } catch (error) {
    await releaseCaptureResources();
    throw error;
  }

  const chunks: Blob[] = [];
  let pendingWrites = Promise.resolve();
  let writeError: Error | null = null;
  let recordedBytes = 0;
  const fileName = fileHandle?.name ?? `${cleanFilename(title)}-${timestampForFilename()}${mimeType.includes("mp4") ? ".mp4" : ".webm"}`;
  let stopPromise: Promise<string> | null = null;
  let finalizePromise: Promise<void> | null = null;
  let recorderError: Error | null = null;
  const recorderStopped = new Promise<void>((resolve) => {
    recorder.addEventListener("stop", () => resolve(), { once: true });
  });

  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size === 0) return;
    recordedBytes += event.data.size;
    if (!writable) {
      chunks.push(event.data);
      return;
    }

    pendingWrites = pendingWrites.then(() => writable.write(event.data)).catch((error: unknown) => {
      writeError = error instanceof Error ? error : new Error("Could not write the recording to this device.");
    });
  });

  recorder.addEventListener("error", (event) => {
    const mediaError = (event as Event & { error?: DOMException }).error;
    recorderError = new Error(mediaError?.message || "The browser stopped recording unexpectedly.");
  }, { once: true });

  try {
    recorder.start(2000);
  } catch (error) {
    await releaseCaptureResources();
    try {
      if (writable?.abort) await writable.abort();
      else await writable?.close();
    } catch {
      // There is no recording data to preserve if the recorder failed to start.
    }
    throw error;
  }

  const finalize = () => {
    if (finalizePromise) return finalizePromise;
    finalizePromise = (async () => {
      window.cancelAnimationFrame(animationFrame);
      videoElement.srcObject = null;
      attachedVideoTrack = null;
      canvasStream?.getTracks().forEach((track) => track.stop());
      recordingStream.getTracks().forEach((track) => track.stop());
      audioSource?.disconnect();
      try {
        await audioContext.close();
      } catch {
        // The context may already have been closed by the browser.
      }

      await pendingWrites;
      if (recorderError || writeError) {
        try {
          if (writable?.abort) await writable.abort();
          else await writable?.close();
        } catch {
          // Preserve the original recording error below.
        }
        throw recorderError ?? writeError;
      }
      if (!recordedBytes) {
        try {
          if (writable?.abort) await writable.abort();
          else await writable?.close();
        } catch {
          // Best effort cleanup when the browser produced no recording data.
        }
        throw new Error("The browser produced an empty recording, so no video file was saved. Try recording again.");
      }
      if (writable) {
        await writable.close();
      } else {
        const blob = new Blob(chunks, { type: recorder.mimeType || mimeType });
        if (!blob.size) throw new Error("The recording was empty, so no file was saved.");
        const objectUrl = URL.createObjectURL(blob);
        const download = document.createElement("a");
        download.href = objectUrl;
        download.download = fileName;
        download.style.display = "none";
        document.body.appendChild(download);
        download.click();
        download.remove();
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
      }
    })();
    return finalizePromise;
  };

  return {
    setVideoTrack,
    setVideoImage,
    setAudioTrack,
    pause: () => {
      if (recorder.state !== "recording") return false;
      recorder.pause();
      return true;
    },
    resume: () => {
      if (recorder.state !== "paused") return false;
      recorder.resume();
      return true;
    },
    stop: () => {
      if (!stopPromise) {
        stopPromise = (async () => {
          try {
            if (recorder.state !== "inactive") recorder.stop();
          } catch (error) {
            await finalize();
            throw error;
          }
          await recorderStopped;
          await finalize();
          return fileName;
        })();
      }
      return stopPromise;
    },
  };
}
