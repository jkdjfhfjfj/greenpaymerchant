import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  Pause,
  Play,
  Repeat,
  Volume2,
  VolumeX,
} from 'lucide-react';
import VideoTemplate, { SCENE_DURATIONS } from './VideoTemplate';
import { useSceneControls } from './useSceneControls';

const SCENE_DETAILS: Record<string, { title: string; filePath: string }> = {
  scope: { title: 'African-market scope', filePath: 'src/components/video/video_scenes/Scene1.tsx' },
  links: { title: 'Shareable payment links', filePath: 'src/components/video/video_scenes/Scene2.tsx' },
  api: { title: 'Developer API and records', filePath: 'src/components/video/video_scenes/Scene3.tsx' },
  close: { title: 'Greenpay close', filePath: 'src/components/video/video_scenes/Scene4.tsx' },
};

const PROGRESS_TICK_MS = 60;

function formatTime(durationMs: number) {
  const seconds = Math.max(0, Math.floor(durationMs / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function PlaybackStatus({
  sceneKeys,
  activeIndex,
  activeDuration,
  activeStartTime,
  totalDuration,
  tick,
  paused,
  onJumpTo,
}: {
  sceneKeys: string[];
  activeIndex: number;
  activeDuration: number;
  activeStartTime: number;
  totalDuration: number;
  tick: number;
  paused: boolean;
  onJumpTo: (index: number) => void;
}) {
  const [elapsed, setElapsed] = useState(0);
  const elapsedBaseRef = useRef(0);

  useEffect(() => {
    setElapsed(0);
    elapsedBaseRef.current = 0;
  }, [tick]);

  useEffect(() => {
    if (paused) return;
    const startedAt = performance.now();
    const timer = window.setInterval(() => {
      setElapsed(elapsedBaseRef.current + performance.now() - startedAt);
    }, PROGRESS_TICK_MS);
    return () => {
      window.clearInterval(timer);
      elapsedBaseRef.current += performance.now() - startedAt;
    };
  }, [paused, tick]);

  const progress = activeDuration > 0 ? Math.min(1, elapsed / activeDuration) : 0;
  const totalElapsed = Math.min(totalDuration, activeStartTime + Math.min(elapsed, activeDuration));

  return (
    <>
      <div className="film-progress-segments">
        {sceneKeys.map((key, index) => (
          <button
            key={key}
            className="film-progress-segment"
            onClick={() => onJumpTo(index)}
            aria-label={`Jump to scene ${index + 1}`}
            aria-current={activeIndex === index ? 'true' : undefined}
          >
            <i style={{ width: activeIndex === index ? `${progress * 100}%` : '0%' }} />
          </button>
        ))}
      </div>
      <span className="film-control-counter">{activeIndex + 1}/{sceneKeys.length}</span>
      <span className="film-control-clock" role="timer">
        {formatTime(totalElapsed)} / {formatTime(totalDuration)}
      </span>
    </>
  );
}

export default function VideoWithControls() {
  const isIframed = typeof window !== 'undefined' && window.self !== window.top;
  const {
    sceneKeys,
    activeIndex,
    locked,
    paused,
    mountKey,
    tick,
    durations,
    activeDuration,
    activeStartTime,
    totalDuration,
    onSceneChange,
    jumpTo,
    toggleLock,
    togglePause,
  } = useSceneControls(SCENE_DURATIONS);
  const [muted, setMuted] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [tapPinned, setTapPinned] = useState(false);
  const sensorRef = useRef<HTMLDivElement | null>(null);

  const handleJumpTo = useCallback((index: number) => {
    jumpTo(index);
    const key = sceneKeys[index];
    const detail = SCENE_DETAILS[key];
    if (!detail || !isIframed) return;
    window.parent.postMessage({
      type: 'REPLIT_VIDEO_SCENE_SELECTED',
      payload: {
        sceneIndex: index,
        sceneCount: sceneKeys.length,
        sceneTitle: detail.title,
        filePath: detail.filePath,
        lineNumber: 1,
      },
    }, '*');
  }, [isIframed, jumpTo, sceneKeys]);

  useEffect(() => {
    if (!paused) return;
    const running = document.getAnimations().filter((animation) => animation.playState === 'running');
    running.forEach((animation) => animation.pause());
    return () => running.forEach((animation) => animation.play());
  }, [paused]);

  useEffect(() => {
    if (!(collapsed && tapPinned)) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'mouse') return;
      if (sensorRef.current && !sensorRef.current.contains(event.target as Node)) {
        setTapPinned(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [collapsed, tapPinned]);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((value) => {
      if (!value) {
        setHovering(false);
        setTapPinned(false);
      }
      return !value;
    });
  }, []);

  if (!isIframed) return <VideoTemplate />;

  const visible = !collapsed || hovering || tapPinned;
  return (
    <div className="film-preview-shell">
      <VideoTemplate
        key={mountKey}
        durations={durations}
        loop
        paused={paused}
        muted={muted}
        onSceneChange={onSceneChange}
      />
      <div
        ref={sensorRef}
        className="film-control-sensor"
        onPointerEnter={(event) => { if (event.pointerType === 'mouse') setHovering(true); }}
        onPointerLeave={(event) => { if (event.pointerType === 'mouse') setHovering(false); }}
        onPointerDown={(event) => { if (event.pointerType !== 'mouse' && collapsed) setTapPinned(true); }}
      >
        <div className="film-control-hover-target" aria-hidden="true" />
        <div className={`film-control-bar${visible ? ' is-visible' : ''}`} aria-hidden={!visible}>
          <button
            className="film-control-button"
            onClick={togglePause}
            aria-label={paused ? 'Play video' : 'Pause video'}
            title={paused ? 'Play' : 'Pause'}
          >
            {paused ? <Play /> : <Pause />}
          </button>
          <button
            className={`film-control-button${locked ? ' is-active' : ''}`}
            onClick={toggleLock}
            aria-label={locked ? 'Unlock scene loop' : 'Loop current scene'}
            aria-pressed={locked}
            title={locked ? 'Scene loop on' : 'Scene loop off'}
          >
            <Repeat />
          </button>
          <button
            className="film-control-button"
            onClick={() => setMuted((value) => !value)}
            aria-label={muted ? 'Unmute video' : 'Mute video'}
            title={muted ? 'Unmute' : 'Mute'}
          >
            {muted ? <VolumeX /> : <Volume2 />}
          </button>
          <div className="film-control-divider" aria-hidden="true" />
          <PlaybackStatus
            sceneKeys={sceneKeys}
            activeIndex={activeIndex}
            activeDuration={activeDuration}
            activeStartTime={activeStartTime}
            totalDuration={totalDuration}
            tick={tick}
            paused={paused}
            onJumpTo={handleJumpTo}
          />
          <button
            className="film-control-button film-collapse-button"
            onClick={toggleCollapsed}
            aria-label={collapsed ? 'Show playback controls' : 'Hide playback controls'}
            aria-expanded={!collapsed}
          >
            {collapsed ? <ChevronUp /> : <ChevronDown />}
          </button>
        </div>
      </div>
    </div>
  );
}