import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../core/logger.js';

const exec = promisify(execFile);

const FFMPEG = process.env.SAAZ_FFMPEG ?? 'ffmpeg';
const FFPROBE = process.env.SAAZ_FFPROBE ?? 'ffprobe';

export interface MediaInfo {
  durationMs: number;
  hasVideo: boolean;
  hasAudio: boolean;
  /** ffmpeg's own diagnosis, so an unsupported codec produces a useful message. */
  audioCodec?: string;
  videoCodec?: string;
  width?: number;
  height?: number;
}

async function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  try {
    const { stdout } = await exec(cmd, args, {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const detail = (e.stderr || e.message || '').trim().split('\n').slice(-3).join(' | ');
    throw new Error(`${cmd} failed: ${detail || 'unknown error'}`);
  }
}

/**
 * Probe a media file. Deliberately reports rather than throws on a file with no
 * audio track, because "this is a silent video" is a different, clearer error
 * than "unsupported codec".
 */
export async function probeMedia(filePath: string): Promise<MediaInfo> {
  const raw = await run(
    FFPROBE,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
    config.limits.probeTimeoutMs,
  );
  const parsed = JSON.parse(raw) as {
    format?: { duration?: string };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
    }>;
  };
  const streams = parsed.streams ?? [];
  const audio = streams.find((s) => s.codec_type === 'audio');
  const video = streams.find((s) => s.codec_type === 'video');
  const durationSec = Number.parseFloat(parsed.format?.duration ?? '0');

  if (!audio) {
    throw new Error('No audio track found. Saaz captions spoken audio; this file appears to be silent.');
  }
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error('Could not determine media duration; the file may be corrupt.');
  }

  return {
    durationMs: Math.round(durationSec * 1000),
    hasAudio: true,
    hasVideo: Boolean(video),
    audioCodec: audio.codec_name,
    videoCodec: video?.codec_name,
    ...(video && video.width ? { width: video.width } : {}),
    ...(video && video.height ? { height: video.height } : {}),
  };
}

/**
 * Extract a 16 kHz mono WAV, which is what Whisper expects. Written to a caller
 * supplied path inside the workspace so nothing lands outside it.
 */
export async function extractAudio(inputPath: string, outPath: string): Promise<void> {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await run(
    FFMPEG,
    ['-y', '-i', inputPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', outPath],
    config.limits.probeTimeoutMs,
  );
  const { size } = await fs.stat(outPath);
  if (size < 1024) {
    throw new Error('Audio extraction produced an empty file; the source may have no decodable audio.');
  }
  log.debug('media.extract_audio', { inputPath, outPath, bytes: size });
}

/** Decode any media file to raw mono float32 samples in [-1, 1]. */
export async function decodeToFloat32(inputPath: string): Promise<Float32Array> {
  const outPath = path.join(
    config.paths.uploadDir,
    `decode-${path.basename(inputPath, path.extname(inputPath))}-${Date.now()}.f32`,
  );
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  try {
    await run(
      FFMPEG,
      ['-y', '-i', inputPath, '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', '-acodec', 'pcm_f32le', outPath],
      config.limits.probeTimeoutMs,
    );
    const buf = await fs.readFile(outPath);
    // Copy into a fresh Float32Array so the underlying Buffer can be GC'd.
    return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  } finally {
    await fs.rm(outPath, { force: true });
  }
}

export async function toolVersions(): Promise<{ ffmpeg: string; ffprobe: string } | null> {
  try {
    const ff = await run(FFMPEG, ['-version'], 10_000);
    const fp = await run(FFPROBE, ['-version'], 10_000);
    return {
      ffmpeg: ff.split('\n')[0] ?? 'unknown',
      ffprobe: fp.split('\n')[0] ?? 'unknown',
    };
  } catch {
    return null;
  }
}