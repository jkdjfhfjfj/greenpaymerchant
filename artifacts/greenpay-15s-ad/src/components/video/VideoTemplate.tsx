import { useEffect, useRef, type ComponentType } from 'react';
import { AnimatePresence } from 'framer-motion';
import {
  VideoCanvas,
  VideoPausedContext,
  type VideoAspectRatio,
  useVideoPlayer,
} from '@/lib/video';
import { Scene1 } from './video_scenes/Scene1';
import { Scene2 } from './video_scenes/Scene2';
import { Scene3 } from './video_scenes/Scene3';
import { Scene4 } from './video_scenes/Scene4';
import './film.css';
import './classroom-film.css';

export const SCENE_DURATIONS = {
  scope: 3150,
  links: 3550,
  api: 4750,
  close: 3550,
} as const;

const VIDEO_ASPECT_RATIO: VideoAspectRatio = '9:16';
const SCENE_START_SEC: Record<string, number> = (() => {
  const result: Record<string, number> = {};
  let elapsedMs = 0;
  for (const [key, duration] of Object.entries(SCENE_DURATIONS)) {
    result[key] = elapsedMs / 1000;
    elapsedMs += duration;
  }
  return result;
})();
const AUDIO_SEEK_EPSILON_SEC = 0.18;

const SCENES: Record<string, ComponentType> = {
  scope: Scene1,
  links: Scene2,
  api: Scene3,
  close: Scene4,
};

interface VideoTemplateProps {
  durations?: Record<string, number>;
  loop?: boolean;
  paused?: boolean;
  muted?: boolean;
  onSceneChange?: (sceneKey: string) => void;
}

export default function VideoTemplate({
  durations = SCENE_DURATIONS,
  loop = true,
  paused = false,
  muted = false,
  onSceneChange,
}: VideoTemplateProps = {}) {
  const { currentSceneKey } = useVideoPlayer({ durations, loop, paused });
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const lastSceneKeyRef = useRef<string | null>(null);
  const baseSceneKey = currentSceneKey.replace(/_r[12]$/, '');
  const Scene = SCENES[baseSceneKey];

  useEffect(() => {
    onSceneChange?.(currentSceneKey);
  }, [currentSceneKey, onSceneChange]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = 1;
    if (paused) {
      audio.pause();
      return;
    }
    if (lastSceneKeyRef.current !== currentSceneKey) {
      lastSceneKeyRef.current = currentSceneKey;
      const targetTime = SCENE_START_SEC[baseSceneKey] ?? 0;
      if (Math.abs(audio.currentTime - targetTime) > AUDIO_SEEK_EPSILON_SEC) {
        audio.currentTime = targetTime;
      }
    }
    audio.play().catch(() => {});
  }, [baseSceneKey, currentSceneKey, muted, paused]);

  return (
    <VideoPausedContext.Provider value={paused}>
      <VideoCanvas
        aspectRatio={VIDEO_ASPECT_RATIO}
        className="greenpay-film"
        style={{ backgroundColor: 'var(--color-bg-dark)' }}
      >
        <AnimatePresence mode="sync" initial={false}>
          {Scene ? <Scene key={currentSceneKey} /> : null}
        </AnimatePresence>
        <audio
          ref={audioRef}
          src={`${import.meta.env.BASE_URL}audio/greenpay-voice-mix.wav`}
          preload="auto"
          autoPlay
          muted={muted}
        />
      </VideoCanvas>
    </VideoPausedContext.Provider>
  );
}
